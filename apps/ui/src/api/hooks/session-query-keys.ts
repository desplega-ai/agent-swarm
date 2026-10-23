// Query keys of the sessions v2 caches: the list pages, the tree, and the
// session detail. The hooks build their queries from them, and the triage
// cache patches (`session-triage-cache.ts`) write through them, so a patch
// always hits the key a hook reads.
//
// Relative imports only: `bun:test` runs this from the repo root.

import type { QueryKey } from "@tanstack/react-query";
import {
  getSessionsHiddenSources,
  getSessionsShow,
  type SessionsShow,
} from "../../lib/sessions-show";
import type { SessionStatusFilter, SessionTriageFilter } from "../types";

export interface UseSessionsOptions {
  limit?: number;
  offset?: number;
  /** Source filter (e.g. `["ui"]`). Empty / undefined → all sources. */
  source?: string[];
  /** Case-insensitive substring search against the root task's text. */
  q?: string;
  /** When set, restrict results to sessions owned by this user. */
  requestedByUserId?: string;
  /** Root tasks whose `contextKey` starts with this prefix (≥1.157.1). */
  contextKeyPrefix?: string;
  /**
   * `mine` / `shared` (session sharing servers only, see `SESSION_SHARING_MIN_VERSION`).
   * Every sessions v2 list sends `tree`, so its totals match `useSessionTree()`.
   */
  scope?: "mine" | "shared" | "tree";
  /** Mine (default) or All, with `scope=tree`. `sessionsQueryOptions` fills it in. */
  show?: "all";
  /** Hidden root sources, comma-joined, with `scope=tree`. `sessionsQueryOptions` fills it in. */
  hideSource?: string;
  /** Asset key prefix, subgroups included (sessions v2). */
  keyPrefix?: string;
  /** Exactly this group, not its subgroups (sessions v2). */
  groupKey?: string;
  /** Sessions in no group (sessions v2). */
  noGroup?: boolean;
  /** Read-state section: Inbox, Later, Done, or every unread session (sessions v2). */
  triage?: SessionTriageFilter;
  /** Running, failed, or "Needs you" (sessions v2). */
  status?: SessionStatusFilter;
  /** A person in the chain or a share user (sessions v2). */
  withUserId?: string;
  /** Disable the query entirely (e.g. when user identity is not yet resolved). */
  enabled?: boolean;
}

/**
 * Query key prefix of every session list page. The triage hooks patch rows
 * under it. Invalidate with `["sessions"]`.
 */
export const SESSION_LIST_KEY = ["sessions", "list"] as const;

/** Query key prefix of the sessions v2 tree. Invalidate with this key. */
export const SESSION_TREE_KEY = ["session-tree"] as const;

/** The list params in a session list query key: `[...SESSION_LIST_KEY, userId, params]`. */
export type SessionListParams = Omit<UseSessionsOptions, "enabled"> & { limit: number };

/**
 * The params of one session list page. A tree list follows the filter menu:
 * the Mine / All view (`show`) and the hidden sources, default the current
 * ones, so its key and total match the tree's.
 */
export function sessionListParams(
  options?: UseSessionsOptions,
  show: SessionsShow = getSessionsShow(),
  hidden: readonly string[] = getSessionsHiddenSources(),
): SessionListParams {
  const { enabled: _enabled, ...rest } = options ?? {};
  const params: SessionListParams = { ...rest, limit: rest.limit ?? 50 };
  if (rest.scope === "tree" && show === "all") params.show = "all";
  if (rest.scope === "tree" && hidden.length > 0) params.hideSource = hidden.join(",");
  return params;
}

/**
 * A session list page key. Rows carry the viewer's read state, and `scope`
 * and `triage` depend on the viewer, so a user switch must not show the
 * last user's page.
 */
export function sessionListKey(userId: string | null, params: SessionListParams) {
  return [...SESSION_LIST_KEY, userId, params] as const;
}

/** The list params of a session list query key (see `sessionListKey`). */
export function sessionListParamsOf(key: QueryKey): SessionListParams | undefined {
  const params = key[3];
  return params && typeof params === "object" ? (params as SessionListParams) : undefined;
}

/** The Mine / All view of a tree list page, or null for a list outside the tree. */
export function sessionListView(params: SessionListParams | undefined): SessionsShow | null {
  if (params?.scope !== "tree") return null;
  return params.show === "all" ? "all" : "mine";
}

/** The tree key: its counts are per viewer, per Mine / All view, and per hidden sources. */
export function sessionTreeKey(
  userId: string | null,
  show: SessionsShow,
  hidden: readonly string[] = getSessionsHiddenSources(),
) {
  return [...SESSION_TREE_KEY, userId, show, hidden.join(",")] as const;
}

/** The session detail query: `["session", rootTaskId, userId]`. */
export function sessionDetailKey(rootTaskId: string | undefined, userId: string | null): QueryKey {
  return ["session", rootTaskId, userId];
}
