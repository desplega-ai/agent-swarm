// react-query hooks for Comb's direct agent-fs calls (the browser talks to
// agent-fs with the human's own key, never through the swarm API).
//
// Build every key with `agentFsKey` (contract in `lib/agent-fs/query.ts`) and
// pass `retry: agentFsRetry`. Keys start with "agent-fs", so these results
// never persist to the dashboard's localStorage query cache, and
// `disconnect()` drops them all at once. This file imports the context, never
// the reverse.

import {
  type QueryKey,
  queryOptions,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useAgentFs } from "@/contexts/agent-fs-context";
import { type AgentFsClient, AgentFsError } from "@/lib/agent-fs/client";
import { agentFsKey, agentFsRetry } from "@/lib/agent-fs/query";
import type {
  CommentAddParams,
  CommentAddResult,
  CommentListEntry,
  CommentListResult,
  CommentResolveResult,
  DiffResult,
  DriveMembersResult,
  LogResult,
  LsResult,
  StatResult,
} from "@/lib/agent-fs/types";
import { commentReadPaths, mergeCommentLists } from "@/lib/comb/comments";
import type { DrivePath } from "@/lib/comb/paths";

export { agentFsKey, agentFsRetry };

/** Text files above this size are not loaded (the viewer offers a download). */
export const COMB_TEXT_MAX_BYTES = 2 * 1024 * 1024;

/** The connected client (null until `ready`) and the key parts for drive queries. */
export interface AgentFsAccess {
  client: AgentFsClient | null;
  /** `useAgentFs().endpoint`, so the `connect()` eviction matches every key. */
  endpoint: string;
  userId: string | null;
}

export function useAgentFsAccess(): AgentFsAccess {
  const { state, client, endpoint, credential } = useAgentFs();
  return {
    client: state === "ready" ? client : null,
    endpoint: endpoint ?? "",
    userId: credential?.userId ?? null,
  };
}

/** `["agent-fs", endpoint, userId, orgId, driveId, kind, path]` for one drive path. */
function drivePathKey(access: AgentFsAccess, target: DrivePath, kind: string) {
  return agentFsKey(
    access.endpoint,
    access.userId,
    target.orgId,
    target.driveId,
    kind,
    target.path,
  );
}

/**
 * Folder listing query. `target.path` is a folder path ("/" is the root). The
 * tree rail runs many of these through `useQueries`.
 */
export function agentFsLsQuery(access: AgentFsAccess, target: DrivePath) {
  return queryOptions({
    queryKey: drivePathKey(access, target, "ls"),
    queryFn: ({ signal }) =>
      (access.client as AgentFsClient).callOp<LsResult>(
        target.orgId,
        "ls",
        { path: target.path },
        target.driveId,
        { signal },
      ),
    enabled: access.client !== null,
    retry: agentFsRetry,
  });
}

export function useAgentFsLs(target: DrivePath) {
  return useQuery(agentFsLsQuery(useAgentFsAccess(), target));
}

/** File metadata. A missing file fails with a 404 `AgentFsError` (not retried). */
export function useAgentFsStat(target: DrivePath) {
  const access = useAgentFsAccess();
  return useQuery({
    queryKey: drivePathKey(access, target, "stat"),
    queryFn: ({ signal }) =>
      (access.client as AgentFsClient).callOp<StatResult>(
        target.orgId,
        "stat",
        { path: target.path },
        target.driveId,
        { signal },
      ),
    enabled: access.client !== null,
    retry: agentFsRetry,
  });
}

/** `text` is null when the file is larger than `maxBytes` (`tooLarge`). */
export type AgentFsText = { tooLarge: false; text: string } | { tooLarge: true; text: null };

/**
 * The file as text, read through the raw bytes route (`cat` stops at 200
 * lines). The key ends with the file revision from `stat`, so the bytes load
 * once per version: `stat` polls and a new version refetches. The previous
 * version stays on screen while the next one loads.
 */
export function useAgentFsText(target: DrivePath, opts: { maxBytes?: number } = {}) {
  const access = useAgentFsAccess();
  const maxBytes = opts.maxBytes ?? COMB_TEXT_MAX_BYTES;
  const stat = useAgentFsStat(target).data;
  const revision = stat ? (stat.currentVersion ?? stat.etag ?? stat.modifiedAt) : null;
  const fileKey = drivePathKey(access, target, "content");
  return useQuery({
    queryKey: [...fileKey, revision] as const,
    queryFn: async ({ signal }): Promise<AgentFsText> => {
      if (stat && stat.size > maxBytes) return { tooLarge: true, text: null };
      const blob = await (access.client as AgentFsClient).fetchRaw(
        target.orgId,
        target.driveId,
        target.path,
        { signal },
      );
      return { tooLarge: false, text: await blob.text() };
    },
    enabled: access.client !== null && stat !== undefined,
    retry: agentFsRetry,
    staleTime: Number.POSITIVE_INFINITY,
    refetchInterval: false,
    // File bytes can be large: drop them soon after the viewer unmounts.
    gcTime: 5 * 60_000,
    placeholderData: (previous, previousQuery) =>
      previousQuery && sameKeyPrefix(previousQuery.queryKey, fileKey) ? previous : undefined,
  });
}

function sameKeyPrefix(key: QueryKey, prefix: readonly unknown[]): boolean {
  return prefix.every((part, index) => key[index] === part);
}

/**
 * Members of a drive with their display names and emails. Needs the agent-fs
 * `drive-members` feature. Comb uses it to show authors by name.
 */
export function useDriveMembers(drive: { orgId: string; driveId: string }) {
  const access = useAgentFsAccess();
  const { features } = useAgentFs();
  return useQuery({
    queryKey: agentFsKey(
      access.endpoint,
      access.userId,
      drive.orgId,
      drive.driveId,
      "drive-members",
    ),
    queryFn: ({ signal }) =>
      (access.client as AgentFsClient).callOp<DriveMembersResult>(
        drive.orgId,
        "drive-members",
        {},
        drive.driveId,
        { signal },
      ),
    enabled: access.client !== null && features.has("drive-members"),
    retry: agentFsRetry,
    // Members change rarely: no polling.
    staleTime: 5 * 60_000,
    refetchInterval: false,
  });
}

// --- Comments (step-7) -------------------------------------------------------

/** Threads per `comment-list` call (agent-fs answers 50 without a limit). */
const COMMENT_LIST_LIMIT = 200;

/**
 * `["agent-fs", endpoint, userId, orgId, driveId, "comments", ...rest]`. One
 * file's lists are `(..., "comments", path, "open" | "resolved")`, with the
 * Comb path ("/docs/a.md"). Invalidate one file with `rest = [path]`, and
 * every comment query of the drive (folder lists included) with no `rest`.
 */
export function agentFsCommentsKey(
  access: AgentFsAccess,
  drive: { orgId: string; driveId: string },
  ...rest: unknown[]
) {
  return agentFsKey(
    access.endpoint,
    access.userId,
    drive.orgId,
    drive.driveId,
    "comments",
    ...rest,
  );
}

function connectedClient(access: AgentFsAccess): AgentFsClient {
  if (!access.client) throw new AgentFsError(0, "NOT_CONNECTED", "Comb is not connected");
  return access.client;
}

/**
 * Root threads of one file, newest first, with their replies. Open threads by
 * default. `resolved: true` answers the resolved ones. Reads both stored path
 * forms (see `lib/comb/comments.ts`). Polls on the dashboard default (10 s).
 */
export function useAgentFsComments(file: DrivePath, opts: { resolved?: boolean } = {}) {
  const access = useAgentFsAccess();
  const resolved = opts.resolved ?? false;
  return useQuery({
    queryKey: agentFsCommentsKey(access, file, file.path, resolved ? "resolved" : "open"),
    queryFn: async ({ signal }): Promise<CommentListEntry[]> => {
      const client = connectedClient(access);
      const lists = await Promise.all(
        commentReadPaths(file.path).map((path) =>
          client.callOp<CommentListResult>(
            file.orgId,
            "comment-list",
            // `resolved: true` lists every root: keep the resolved ones.
            { path, limit: COMMENT_LIST_LIMIT, ...(resolved ? { resolved: true } : {}) },
            file.driveId,
            { signal },
          ),
        ),
      );
      const threads = mergeCommentLists(lists.map((list) => list.comments));
      return resolved ? threads.filter((thread) => thread.resolved) : threads;
    },
    enabled: access.client !== null,
    retry: agentFsRetry,
  });
}

/** `comment-add`, for the composer and the outbox retry. */
export function addAgentFsComment(
  access: AgentFsAccess,
  drive: { orgId: string; driveId: string },
  params: CommentAddParams,
): Promise<CommentAddResult> {
  return connectedClient(access).callOp<CommentAddResult>(
    drive.orgId,
    "comment-add",
    { ...params },
    drive.driveId,
  );
}

/**
 * Add a comment or a reply. Success refreshes every comment query of the
 * drive (the file's lists and step-9's folder lists).
 */
export function useAddComment(file: DrivePath) {
  const access = useAgentFsAccess();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (params: CommentAddParams) => addAgentFsComment(access, file, params),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: agentFsCommentsKey(access, file) }),
  });
}

/** Resolve or reopen a root thread. */
export function useResolveComment(file: DrivePath) {
  const access = useAgentFsAccess();
  const queryClient = useQueryClient();
  const key = agentFsCommentsKey(access, file);
  return useMutation({
    mutationFn: ({ id, resolved }: { id: string; resolved: boolean }) =>
      connectedClient(access).callOp<CommentResolveResult>(
        file.orgId,
        "comment-resolve",
        { id, resolved },
        file.driveId,
      ),
    // A poll that started before the write must not bring the old state back.
    onMutate: () => queryClient.cancelQueries({ queryKey: key }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: key }),
  });
}

/**
 * The file's versions (`log`, newest first). The key ends with the current
 * version, so a new version refetches it and nothing polls. Key:
 * `(..., "log", path, currentVersion)`.
 */
export function agentFsLogQuery(
  access: AgentFsAccess,
  file: DrivePath,
  currentVersion: number | undefined,
) {
  return queryOptions({
    queryKey: agentFsKey(
      access.endpoint,
      access.userId,
      file.orgId,
      file.driveId,
      "log",
      file.path,
      currentVersion ?? null,
    ),
    queryFn: ({ signal }) =>
      connectedClient(access).callOp<LogResult>(
        file.orgId,
        "log",
        { path: file.path, limit: 200 },
        file.driveId,
        { signal },
      ),
    enabled: access.client !== null && currentVersion !== undefined,
    staleTime: Number.POSITIVE_INFINITY,
    refetchInterval: false,
    retry: agentFsRetry,
    gcTime: 5 * 60_000,
  });
}

/**
 * `diff {path, v1, v2}` with source line numbers. A version pair never
 * changes, so the answer is cached for good. Key:
 * `(..., "diff", path, v1, v2)`. Step-10 reuses it.
 */
export function agentFsDiffQuery(access: AgentFsAccess, file: DrivePath, v1: number, v2: number) {
  return queryOptions({
    queryKey: agentFsKey(
      access.endpoint,
      access.userId,
      file.orgId,
      file.driveId,
      "diff",
      file.path,
      v1,
      v2,
    ),
    queryFn: ({ signal }) =>
      connectedClient(access).callOp<DiffResult>(
        file.orgId,
        "diff",
        { path: file.path, v1, v2 },
        file.driveId,
        { signal },
      ),
    enabled: access.client !== null && v1 > 0 && v1 < v2,
    staleTime: Number.POSITIVE_INFINITY,
    refetchInterval: false,
    retry: false,
    gcTime: 5 * 60_000,
  });
}
