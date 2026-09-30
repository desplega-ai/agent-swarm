// Which cached agent-fs queries a change-stream event makes stale. Pure, so
// the rules are testable without React. `useAgentFsLive` applies them.

import type { QueryKey } from "@tanstack/react-query";
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
 * because its events refresh them.
 */
export const LIVE_QUERY_KINDS = ["stat", "ls", "comments"] as const;

/**
 * The Comb form of an event path: exactly one leading "/". agent-fs sends a
 * path as its writer stored it ("docs/a.md" or "/docs/a.md").
 */
export function combEventPath(path: string): string {
  return `/${path.replace(/^\/+/, "")}`;
}

/**
 * Query-key prefixes to invalidate for one event.
 *
 * - `file.changed`: the file's `stat`, and the `ls` of every folder above it
 *   (a new or emptied subfolder also changes its parent's listing). Content,
 *   media, and log keys end with the `stat` revision, so the new `stat`
 *   loads them. A diff key names two fixed versions and never goes stale.
 * - `comment.changed`: the file's `comments`, and the folder comment lists
 *   (`(..., "comments", "prefix", folder)`) of every folder above it.
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
      const path = combEventPath(event.path);
      return [key("stat", path), ...ancestorFolders(path).map((folder) => key("ls", folder))];
    }
    case "comment.changed": {
      const path = combEventPath(event.path);
      return [
        key("comments", path),
        ...ancestorFolders(path).map((folder) => key("comments", "prefix", folder)),
      ];
    }
    default:
      return [];
  }
}
