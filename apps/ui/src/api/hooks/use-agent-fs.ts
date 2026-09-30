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
import { useState } from "react";
import { useAgentFs } from "@/contexts/agent-fs-context";
import { useDataUrl, useObjectUrl } from "@/hooks/use-object-url";
import { type AgentFsClient, AgentFsError } from "@/lib/agent-fs/client";
import { agentFsKey, agentFsRetry } from "@/lib/agent-fs/query";
import type {
  CommentAddParams,
  CommentAddResult,
  CommentListResult,
  CommentResolveResult,
  DiffResult,
  DriveMembersResult,
  LogResult,
  LsResult,
  RevertParams,
  RevertResult,
  StatResult,
} from "@/lib/agent-fs/types";
import {
  COMB_LOG_LIMIT,
  commentAuthorNames,
  commentReadPaths,
  type FileThreads,
  listFileThreads,
} from "@/lib/comb/comments";
import {
  blobUrlPlan,
  COMB_MEDIA_MAX_BYTES,
  freshPresignedUrl,
  MEDIA_URL_EXPIRY_MARGIN_MS,
  type MediaKind,
  type MediaSource,
  mediaSourceFrom,
} from "@/lib/comb/media";
import type { DrivePath } from "@/lib/comb/paths";
import { type AgentFsText, COMB_TEXT_MAX_BYTES, readDriveText } from "@/lib/comb/text-content";

export { agentFsKey, agentFsRetry };
export { type AgentFsText, COMB_TEXT_MAX_BYTES };

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

/**
 * The file as text (`readDriveText`, `tooLarge` above `COMB_TEXT_MAX_BYTES`).
 * The key ends with the file revision from `stat`, so the bytes load once per
 * version: `stat` polls and a new version refetches. The previous version
 * stays on screen while the next one loads.
 */
export function useAgentFsText(target: DrivePath) {
  const access = useAgentFsAccess();
  const stat = useAgentFsStat(target).data;
  const revision = fileRevision(stat);
  const fileKey = drivePathKey(access, target, "content");
  return useQuery({
    queryKey: [...fileKey, revision] as const,
    queryFn: ({ signal }): Promise<AgentFsText> =>
      readDriveText(access.client as AgentFsClient, target, stat as StatResult, signal),
    enabled: access.client !== null && stat !== undefined,
    retry: agentFsRetry,
    staleTime: Number.POSITIVE_INFINITY,
    refetchInterval: false,
    // One entry per revision: drop each as soon as no viewer reads it, so a
    // file that changes on every poll does not pile up copies of its bytes.
    gcTime: 0,
    placeholderData: keepSameFile(fileKey),
  });
}

function sameKeyPrefix(key: QueryKey, prefix: readonly unknown[]): boolean {
  return prefix.every((part, index) => key[index] === part);
}

/** The version id that content keys end with, so each version loads once. */
function fileRevision(stat: StatResult | undefined) {
  return stat ? (stat.currentVersion ?? stat.etag ?? stat.modifiedAt) : null;
}

/**
 * `placeholderData` that keeps the previous data of the same file (keys under
 * `fileKey`) on screen while a new revision loads.
 */
function keepSameFile(fileKey: readonly unknown[]) {
  return <T>(previous: T | undefined, previousQuery?: { queryKey: QueryKey }) =>
    previousQuery && sameKeyPrefix(previousQuery.queryKey, fileKey) ? previous : undefined;
}

// --- Media URLs (step-6: image, video, and PDF viewers) ---

/** Presigned media URLs live one hour. */
const MEDIA_URL_EXPIRES_IN_SECONDS = 3600;

export interface AgentFsMediaUrl {
  /** Null while the URL loads, after an error, and when `tooLarge`. */
  url: string | null;
  /** Blob mode only: the file is above `COMB_MEDIA_MAX_BYTES`, so its bytes do not load. */
  tooLarge: boolean;
  error: Error | null;
}

/**
 * A URL for `<img>`, `<video>`, or a PDF `<iframe>`. It is a presigned
 * storage URL when the backend supports them. Otherwise (a 422, or an `app`
 * link, for example on the local storage backend) the Bearer `/raw` bytes
 * load into a local URL, up to `COMB_MEDIA_MAX_BYTES`. `blobUrlPlan` sets
 * that URL's type, so it never renders as a document at the dashboard's
 * origin. The local URL is revoked when the file, its revision, or the
 * component changes.
 *
 * Keys: `[..., "media", path, revision, "signed-url"]` and
 * `[..., "media", path, revision, "raw"]`. Neither the keys nor the cached
 * bytes depend on `kind`. Invalidate both by the prefix `(..., "media", path)`.
 */
export function useAgentFsMediaUrl(target: DrivePath, kind: MediaKind): AgentFsMediaUrl {
  const access = useAgentFsAccess();
  const stat = useAgentFsStat(target).data;
  const revision = fileRevision(stat);
  const mediaKey = drivePathKey(access, target, "media");
  const enabled = access.client !== null && stat !== undefined;
  // A cached presigned URL near its expiry never shows on mount. It is stale
  // (see `staleTime`), so the mount mints a new one.
  const [mountedAt] = useState(Date.now);

  const signed = useQuery({
    queryKey: [...mediaKey, revision, "signed-url"] as const,
    queryFn: async (): Promise<MediaSource> => {
      const mintedAt = Date.now();
      const outcome = await (access.client as AgentFsClient)
        .getSignedUrl(target.orgId, target.driveId, target.path, {
          disposition: "inline",
          expiresIn: MEDIA_URL_EXPIRES_IN_SECONDS,
        })
        .then(
          (result) => ({ result }),
          (error: unknown) => ({ error }),
        );
      const source = mediaSourceFrom(outcome, mintedAt);
      if (source.kind === "error") throw source.error;
      return source;
    },
    enabled,
    retry: agentFsRetry,
    // A presigned URL goes stale when it enters the expiry margin, so the next
    // mount mints a new one. Blob mode changes only with the backend.
    staleTime: ({ state }) =>
      state.data?.kind === "presigned"
        ? state.data.expiresAt - MEDIA_URL_EXPIRY_MARGIN_MS - state.dataUpdatedAt
        : Number.POSITIVE_INFINITY,
    gcTime: 10 * 60_000,
    // A URL on screen never changes under the viewer: a new URL reloads a
    // PDF at page 1 and restarts a video.
    refetchInterval: false,
    refetchOnWindowFocus: false,
    placeholderData: keepSameFile(mediaKey),
  });
  const presignedUrl = freshPresignedUrl(signed.data, mountedAt);
  const blobMode = signed.data?.kind === "blob";
  const tooLarge = blobMode && stat !== undefined && stat.size > COMB_MEDIA_MAX_BYTES;

  const raw = useQuery({
    queryKey: [...mediaKey, revision, "raw"] as const,
    queryFn: ({ signal }) =>
      (access.client as AgentFsClient).fetchRaw(target.orgId, target.driveId, target.path, {
        signal,
      }),
    enabled: enabled && blobMode && !tooLarge,
    retry: agentFsRetry,
    staleTime: Number.POSITIVE_INFINITY,
    refetchInterval: false,
    // Never keep media bytes (or their object URLs) for a file that is not on screen.
    gcTime: 0,
    placeholderData: keepSameFile(mediaKey),
  });
  const plan = blobUrlPlan(kind, target.path, stat?.contentType);
  const blob = blobMode && !tooLarge ? raw.data : undefined;
  const objectUrl = useObjectUrl(plan.as === "object-url" ? blob : undefined, plan.type);
  const dataUrl = useDataUrl(plan.as === "data-url" ? blob : undefined, plan.type);
  const blobUrl = objectUrl ?? dataUrl;

  // Data wins over an error: a failed background refetch keeps the URL on screen.
  if (presignedUrl) return { url: presignedUrl, tooLarge: false, error: null };
  if (tooLarge) return { url: null, tooLarge: true, error: null };
  if (blobUrl) return { url: blobUrl, tooLarge: false, error: null };
  return { url: null, tooLarge: false, error: signed.error ?? raw.error };
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

/**
 * `["agent-fs", endpoint, userId, orgId, driveId, "comments", ...rest]`. One
 * file's threads are `(..., "comments", path)`, with the Comb path
 * ("/docs/a.md"). Invalidate one file with `rest = [path]`, and every comment
 * query of the drive (folder lists included) with no `rest`.
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
 * Every root thread of one file (open and resolved), newest first, with its
 * replies: `{threads, truncated}` (`listFileThreads`, at most the newest
 * 2,000). `comment-list {resolved: true}` answers every root, paged per
 * stored path form (see `lib/comb/comments.ts`). Key: `(..., "comments", path)`.
 */
export function agentFsCommentsQuery(access: AgentFsAccess, file: DrivePath) {
  return queryOptions({
    queryKey: agentFsCommentsKey(access, file, file.path),
    queryFn: ({ signal }): Promise<FileThreads> => {
      const client = connectedClient(access);
      return listFileThreads(commentReadPaths(file.path), async (path, offset, limit) => {
        const page = await client.callOp<CommentListResult>(
          file.orgId,
          "comment-list",
          { path, resolved: true, limit, offset },
          file.driveId,
          { signal },
        );
        return page.comments;
      });
    },
    enabled: access.client !== null,
    retry: agentFsRetry,
  });
}

/** The file's threads. Polls on the dashboard default (10 s). Split open and resolved by `thread.resolved`. */
export function useAgentFsComments(file: DrivePath) {
  return useQuery(agentFsCommentsQuery(useAgentFsAccess(), file));
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
    // Offline, try anyway: the failure moves the comment to the outbox. The
    // default ("online") pauses the send, and the composer waits with it.
    networkMode: "always",
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
        { path: file.path, limit: COMB_LOG_LIMIT },
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

// --- Review changes (step-10) -------------------------------------------------

/**
 * The file's versions, newest first. Same cache entry as the comment anchors
 * (`agentFsLogQuery`). `enabled: false` skips the call.
 */
export function useAgentFsLog(
  file: DrivePath,
  currentVersion: number | undefined,
  { enabled = true }: { enabled?: boolean } = {},
) {
  const query = agentFsLogQuery(useAgentFsAccess(), file, currentVersion);
  return useQuery({ ...query, enabled: enabled && query.enabled === true });
}

/** The diff from `from` to `to` (`from < to`). Same cache entry as the comment anchors. */
export function useAgentFsDiff(file: DrivePath, from: number, to: number) {
  return useQuery(agentFsDiffQuery(useAgentFsAccess(), file, from, to));
}

const NO_AUTHOR_NAMES: ReadonlyMap<string, string> = new Map();

/** `author → authorDisplayName` over the file's loaded comments (the rail's query, no extra call). */
export function useCommentAuthorNames(file: DrivePath): ReadonlyMap<string, string> {
  const query = agentFsCommentsQuery(useAgentFsAccess(), file);
  return useQuery({ ...query, select: commentAuthorNames }).data ?? NO_AUTHOR_NAMES;
}

/**
 * `revert`: write an old version again, as a new version. `expectedVersion`
 * is the head the human reviewed. agent-fs answers 409 (`EDIT_CONFLICT`) and
 * writes nothing when the file has moved on since. Either way `stat`
 * refetches, so the view learns the new head.
 */
export function useRevertFile(file: DrivePath) {
  const access = useAgentFsAccess();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ version, expectedVersion }: { version: number; expectedVersion: number }) =>
      connectedClient(access).callOp<RevertResult>(
        file.orgId,
        "revert",
        { path: file.path, version, expectedVersion } satisfies RevertParams,
        file.driveId,
      ),
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: drivePathKey(access, file, "stat") }),
  });
}
