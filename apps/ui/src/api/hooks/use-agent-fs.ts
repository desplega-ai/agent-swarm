// react-query hooks for Comb's direct agent-fs calls (the browser talks to
// agent-fs with the human's own key, never through the swarm API).
//
// Build every key with `agentFsKey` (contract in `lib/agent-fs/query.ts`) and
// pass `retry: agentFsRetry`. Keys start with "agent-fs", so these results
// never persist to the dashboard's localStorage query cache, and
// `disconnect()` drops them all at once. This file imports the context, never
// the reverse.

import { type QueryKey, queryOptions, useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useAgentFs } from "@/contexts/agent-fs-context";
import { type AgentFsClient, AgentFsError } from "@/lib/agent-fs/client";
import { agentFsKey, agentFsRetry } from "@/lib/agent-fs/query";
import type {
  DriveMembersResult,
  LsResult,
  SignedUrlDisposition,
  StatResult,
} from "@/lib/agent-fs/types";
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

// --- Media URLs (step-6: image, video, and PDF viewers) ---

/** Presigned media URLs live one hour. A cached one is minted again after 50 minutes. */
const MEDIA_URL_EXPIRES_IN_SECONDS = 3600;
const MEDIA_URL_STALE_MS = 50 * 60_000;

export interface AgentFsMediaUrl {
  /** Null while the URL loads and after an error. */
  url: string | null;
  /** `presigned`: a public storage URL. `blob`: the raw bytes in a local object URL. */
  source: "presigned" | "blob" | null;
  error: Error | null;
}

/**
 * A URL for `<img>`, `<video>`, or `<iframe>`. It is a presigned storage URL
 * when the backend supports them (`signed-url` answers `kind: "presigned"`).
 * Otherwise (a 422, or an `app` link, for example on the local storage
 * backend) the Bearer `/raw` bytes load into an object URL. The object URL is
 * revoked when the file, its revision, or the component changes.
 *
 * `opts.type` sets the object URL's content type. A frame needs it: an object
 * URL has the dashboard's origin, so it must never render as HTML.
 *
 * Keys: `[..., "media", path, revision, "signed-url", disposition]` and
 * `[..., "media", path, revision, "raw"]`. Invalidate both by the prefix
 * `(..., "media", path)`.
 */
export function useAgentFsMediaUrl(
  target: DrivePath,
  opts: { disposition?: SignedUrlDisposition; type?: string } = {},
): AgentFsMediaUrl {
  const access = useAgentFsAccess();
  const disposition = opts.disposition ?? "inline";
  const { type } = opts;
  const stat = useAgentFsStat(target).data;
  const revision = stat ? (stat.currentVersion ?? stat.etag ?? stat.modifiedAt) : null;
  const mediaKey = drivePathKey(access, target, "media");
  const enabled = access.client !== null && stat !== undefined;
  // A new revision keeps the previous media of the same file on screen while it loads.
  const keepSameFile = <T>(previous: T | undefined, previousQuery?: { queryKey: QueryKey }) =>
    previousQuery && sameKeyPrefix(previousQuery.queryKey, mediaKey) ? previous : undefined;

  const signed = useQuery({
    queryKey: [...mediaKey, revision, "signed-url", disposition] as const,
    // Null: this backend has no presigned URLs, so the bytes load through `/raw`.
    queryFn: async (): Promise<string | null> => {
      try {
        const result = await (access.client as AgentFsClient).getSignedUrl(
          target.orgId,
          target.driveId,
          target.path,
          { disposition, expiresIn: MEDIA_URL_EXPIRES_IN_SECONDS },
        );
        return result.kind === "presigned" ? result.url : null;
      } catch (err) {
        if (err instanceof AgentFsError && err.status === 422) return null;
        throw err;
      }
    },
    enabled,
    retry: agentFsRetry,
    staleTime: MEDIA_URL_STALE_MS,
    gcTime: 10 * 60_000,
    // A URL on screen never changes under the viewer: a new URL reloads a
    // PDF at page 1 and restarts a video. A new mount after 50 minutes mints
    // a new URL.
    refetchInterval: false,
    refetchOnWindowFocus: false,
    placeholderData: keepSameFile,
  });

  const raw = useQuery({
    queryKey: [...mediaKey, revision, "raw"] as const,
    queryFn: async ({ signal }) => {
      const blob = await (access.client as AgentFsClient).fetchRaw(
        target.orgId,
        target.driveId,
        target.path,
        { signal },
      );
      return type && blob.type !== type ? new Blob([blob], { type }) : blob;
    },
    enabled: enabled && signed.data === null,
    retry: agentFsRetry,
    staleTime: Number.POSITIVE_INFINITY,
    refetchInterval: false,
    // Never keep media bytes (or their object URLs) for a file that is not on screen.
    gcTime: 0,
    placeholderData: keepSameFile,
  });
  const objectUrl = useObjectUrl(signed.data === null ? raw.data : undefined);

  if (signed.error) return { url: null, source: null, error: signed.error };
  if (signed.data) return { url: signed.data, source: "presigned", error: null };
  if (raw.error) return { url: null, source: null, error: raw.error };
  return { url: objectUrl, source: objectUrl ? "blob" : null, error: null };
}

/** An object URL for `blob`. It is revoked when the blob changes and on unmount. */
function useObjectUrl(blob: Blob | undefined): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!blob) return;
    const next = URL.createObjectURL(blob);
    setUrl(next);
    return () => {
      URL.revokeObjectURL(next);
      setUrl(null);
    };
  }, [blob]);
  // On a blob change the old URL shows for one more render. It is revoked after that commit.
  return blob ? url : null;
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
