// react-query hooks for Comb's direct agent-fs calls (the browser talks to
// agent-fs with the human's own key, never through the swarm API).
//
// Every key starts with "agent-fs", so these results never persist to the
// dashboard's localStorage query cache (`shouldPersistQuery`), and
// `disconnect()` drops them all at once.

import { type QueryKey, queryOptions, useQuery } from "@tanstack/react-query";
import { useAgentFs } from "@/contexts/agent-fs-context";
import { AgentFsClient, AgentFsError, isAgentFsAuthError } from "@/lib/agent-fs/client";
import type { DriveMembersResult, LsResult, StatResult } from "@/lib/agent-fs/types";
import type { DrivePath } from "@/lib/comb/paths";

/** Text files above this size are not loaded (the viewer offers a download). */
export const COMB_TEXT_MAX_BYTES = 2 * 1024 * 1024;

/**
 * `["agent-fs", endpoint, userId, ...rest]`. `userId` is null for public
 * calls (`/health`). Invalidate by prefix, for example
 * `agentFsKey(endpoint, userId, "ls")` for every folder listing.
 */
export function agentFsKey(endpoint: string, userId: string | null, ...rest: unknown[]) {
  return ["agent-fs", endpoint, userId, ...rest] as const;
}

/** Connection-level data changes rarely: no polling. */
const CONNECTION_QUERY = { staleTime: 5 * 60_000, refetchInterval: false } as const;

/** Public server info. `features` gates Comb surfaces that need a newer agent-fs. */
export function useAgentFsHealth(endpoint: string | null) {
  return useQuery({
    queryKey: agentFsKey(endpoint ?? "", null, "health"),
    queryFn: ({ signal }) => AgentFsClient.health(endpoint as string, { signal }),
    enabled: endpoint !== null,
    retry: 1,
    ...CONNECTION_QUERY,
  });
}

/**
 * The connected identity. The provider runs it to learn whether the saved key
 * still works (a 401 is not retried). Components read `useAgentFs().me`.
 */
export function useAgentFsMe(client: AgentFsClient | null, userId: string | null) {
  return useQuery({
    queryKey: agentFsKey(client?.endpoint ?? "", userId, "me"),
    queryFn: ({ signal }) => (client as AgentFsClient).getMe({ signal }),
    enabled: client !== null,
    retry: (failureCount, error) => !isAgentFsAuthError(error) && failureCount < 2,
    ...CONNECTION_QUERY,
  });
}

/**
 * A 4xx does not change on retry (a 401 key, a 404 path, a 403 role), so only
 * network failures and 5xx retry.
 */
function retryAgentFs(failureCount: number, error: Error): boolean {
  if (isAgentFsAuthError(error)) return false;
  if (error instanceof AgentFsError && error.status >= 400 && error.status < 500) return false;
  return failureCount < 2;
}

/** The connected client (null until `ready`) and the key parts for drive queries. */
export interface AgentFsAccess {
  client: AgentFsClient | null;
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
    retry: retryAgentFs,
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
    retry: retryAgentFs,
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
    retry: retryAgentFs,
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
    retry: retryAgentFs,
    ...CONNECTION_QUERY,
  });
}
