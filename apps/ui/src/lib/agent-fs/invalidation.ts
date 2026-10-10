// Which cached agent-fs queries a change-stream event makes stale. Pure, so
// the rules are testable without React. `useAgentFsLive` applies them.

import type { QueryKey } from "@tanstack/react-query";
import { commentCombPath } from "../comb/comments";
import { ancestorFolders } from "../comb/paths";
import { agentFsKey } from "./query";
import type { DriveEvent } from "./stream";

/** The key parts of the drive that the stream follows (see `agentFsKey`). */
export interface LiveKeyContext {
  endpoint: string;
  userId: string | null;
  orgId: string;
  driveId: string;
}

/**
 * The query kinds that stop polling while the drive's stream is live,
 * because its events refresh them. `drivePoll` and the `ready` resync both
 * read this list.
 */
export const LIVE_QUERY_KINDS: readonly string[] = ["stat", "ls", "comments"];

/** The dashboard's default poll (`app/providers.tsx`). */
export const COMB_POLL_MS = 10_000;

/**
 * `refetchInterval` for a drive query of `kind` (the key part after the
 * drive id): off for a `LIVE_QUERY_KINDS` kind while the drive's change
 * stream is live, because its events refresh the query. The dashboard's
 * 10 s poll otherwise. `access` is `useAgentFsAccess()`.
 */
export function drivePoll(
  access: { liveDriveId?: string | null },
  target: { driveId: string },
  kind: string,
): number | false {
  const live = access.liveDriveId === target.driveId && LIVE_QUERY_KINDS.includes(kind);
  return live ? false : COMB_POLL_MS;
}

/**
 * The comment list of a folder (step-9): `(..., "comments", "prefix",
 * folder.path)`, the same key as `agentFsCommentsKey(access, folder,
 * "prefix", folder.path)`. `folder.path` ends with "/". A `comment.changed`
 * event for any file below the folder refreshes it.
 */
export function agentFsFolderCommentsKey(
  access: { endpoint: string; userId: string | null },
  folder: { orgId: string; driveId: string; path: string },
) {
  return agentFsKey(
    access.endpoint,
    access.userId,
    folder.orgId,
    folder.driveId,
    "comments",
    "prefix",
    folder.path,
  );
}

/**
 * Query-key prefixes to invalidate for one event.
 *
 * - `file.changed`: the file's `stat`, and the `ls` of every folder above it
 *   (a new or emptied subfolder also changes its parent's listing). Content,
 *   media, and log keys end with the `stat` revision, so the new `stat`
 *   loads them. A diff key names two fixed versions and never goes stale.
 * - `comment.changed`: the file's `comments`, and the folder comment list
 *   (`agentFsFolderCommentsKey`) of every folder above it.
 * - `ready` (first connect and every reconnect): every `LIVE_QUERY_KINDS`
 *   query of the drive, because events are not replayed.
 */
export function keysToInvalidate(event: DriveEvent, ctx: LiveKeyContext): QueryKey[] {
  const key = (...rest: unknown[]) =>
    agentFsKey(ctx.endpoint, ctx.userId, ctx.orgId, ctx.driveId, ...rest);
  switch (event.type) {
    case "ready":
      return LIVE_QUERY_KINDS.map((kind) => key(kind));
    case "file.changed": {
      const path = commentCombPath(event.path);
      return [key("stat", path), ...ancestorFolders(path).map((folder) => key("ls", folder))];
    }
    case "comment.changed": {
      const path = commentCombPath(event.path);
      return [
        key("comments", path),
        ...ancestorFolders(path).map((folder) =>
          agentFsFolderCommentsKey(ctx, { ...ctx, path: folder }),
        ),
      ];
    }
    default:
      return [];
  }
}
