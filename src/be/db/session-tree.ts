import {
  keyPrefixRange,
  normalizeAssetKey,
  SESSION_LEAF_KINDS,
  sessionGroupKey,
} from "../../assets/key";
import { isTerminalTaskStatus, TERMINAL_TASK_STATUSES } from "../../types";
import { getDbClient, literalPrefixPattern } from "../db";
import {
  type SessionViewer,
  sessionMineCondition,
  sessionViewerCondition,
} from "./session-visibility";

export type SessionReadState = "unread" | "read" | "later" | "done";
export interface SessionFilters {
  /** Restrict roots to these task sources. */
  source?: string[];
  /** Leave out roots of these task sources (the sessions v2 source filter). */
  hideSource?: string[];
  /** Match root task text or title with a case-insensitive substring. */
  q?: string;
  /** Match the root requester, excluding NULL requester rows. */
  requestedByUserId?: string;
  /** Literal context prefix for the UI session panel, escaping %, _ and backslash. */
  contextKeyPrefix?: string;
  /** Apply this user's session ownership and share visibility. */
  viewer?: SessionViewer;
  /** Match roots under this literal canonical asset key prefix. */
  keyPrefix?: string;
  /** Match this exact group and its direct resource leaves. */
  groupKey?: string;
  /** Match shared and viewer-personal namespace roots and direct leaves. */
  noGroup?: boolean;
  /** Filter by chain-wide read state or the Inbox section. */
  triage?: "inbox" | "later" | "done" | "unread";
  /** Filter by latest chain status or pending human attention. */
  status?: "running" | "failed" | "needs";
  /** Match a requester anywhere in the chain or an active share recipient. */
  withUserId?: string;
  /** Use this ISO timestamp for read-state comparisons. */
  now?: string;
  /** Exclude ownerless roots for user viewers to match the tree's visibility. */
  tree?: boolean;
  /** For user viewers: only human-started roots of the viewer and shares (the "Mine" view). */
  mine?: boolean;
  /** Match exactly this root (one session's summary, e.g. its read state). */
  rootId?: string;
}

type SqlFragment = { sql: string; params: (string | number | null)[] };

/** Shared read-state rule with bound ISO timestamps for the list and tree. */
function sessionReadStateSql(now = new Date().toISOString()): SqlFragment {
  return {
    sql: `CASE
      WHEN s.id IS NULL THEN CASE WHEN a.lastActivityAt > ? THEN 'unread' ELSE 'read' END
      WHEN s.status = 'dismissed' THEN 'done'
      WHEN s.status = 'done' THEN CASE WHEN a.lastActivityAt > s.lastUpdatedAt THEN 'unread' ELSE 'done' END
      WHEN s.status = 'snoozed' THEN CASE WHEN s.snoozeUntil > ? THEN 'later' ELSE 'unread' END
      WHEN a.lastActivityAt > COALESCE(s.lastReadAt, s.lastUpdatedAt) THEN 'unread'
      ELSE 'read'
    END`,
    params: [new Date(Date.parse(now) - 7 * 86400000).toISOString(), now],
  };
}

function groupCondition(group: string): SqlFragment {
  const { lo, hi } = keyPrefixRange(group);
  // The remaining key must be one resource leaf, with no nested path.
  // SQLite substr/length count code points, so count them here too (not UTF-16 units).
  const start = [...lo].length + 1;
  return {
    sql: `(r."key" >= ? AND r."key" < ? AND (r."key" = ? OR (
      instr(substr(r."key", ?, length(r."key") - ?), '/') = 0 AND
      (${SESSION_LEAF_KINDS.map(() => 'substr(r."key", ?) GLOB ?').join(" OR ")})
    )))`,
    params: [
      lo,
      hi,
      lo,
      start,
      start,
      ...SESSION_LEAF_KINDS.flatMap((kind) => [start, `${kind}:?*/`]),
    ],
  };
}

export function sessionRootFilter(opts: SessionFilters = {}): SqlFragment {
  const conditions = ["r.parentTaskId IS NULL"];
  const params: SqlFragment["params"] = [];
  const add = (fragment: SqlFragment) => {
    conditions.push(fragment.sql);
    params.push(...fragment.params);
  };
  if (opts.rootId) add({ sql: "r.id = ?", params: [opts.rootId] });
  const sources = opts.source?.filter(Boolean) ?? [];
  if (sources.length)
    add({ sql: `r.source IN (${sources.map(() => "?").join(",")})`, params: sources });
  const hidden = opts.hideSource?.filter(Boolean) ?? [];
  if (hidden.length)
    add({ sql: `r.source NOT IN (${hidden.map(() => "?").join(",")})`, params: hidden });
  if (opts.q?.trim()) {
    const like = `%${opts.q.trim().toLowerCase()}%`;
    add({
      sql: "(lower(r.task) LIKE ? OR lower(COALESCE(r.title, '')) LIKE ?)",
      params: [like, like],
    });
  }
  if (opts.requestedByUserId?.trim())
    add({ sql: "r.requestedByUserId = ?", params: [opts.requestedByUserId.trim()] });
  if (opts.contextKeyPrefix)
    add({
      sql: "r.contextKey LIKE ? ESCAPE '\\'",
      params: [literalPrefixPattern(opts.contextKeyPrefix)],
    });
  if (opts.viewer) {
    add(sessionViewerCondition(opts.viewer));
    if (opts.tree) conditions.push("r.requestedByUserId IS NOT NULL");
    if (opts.mine) add(sessionMineCondition(opts.viewer.userId));
  }
  if (opts.keyPrefix) {
    const { lo, hi } = keyPrefixRange(opts.keyPrefix);
    add({ sql: 'r."key" >= ? AND r."key" < ?', params: [lo, hi] });
  }
  if (opts.groupKey) add(groupCondition(normalizeAssetKey(opts.groupKey)));
  if (opts.noGroup) {
    const groups = [groupCondition("shared/")];
    if (opts.viewer?.userId) groups.push(groupCondition(`personal/${opts.viewer.userId}/`));
    add({
      sql: `(${groups.map((g) => g.sql).join(" OR ")})`,
      params: groups.flatMap((g) => g.params),
    });
  }
  if (opts.triage === "later" || opts.triage === "done") {
    add({
      sql: `r.id IN (SELECT itemId FROM inbox_item_state
        WHERE userId = ? AND itemType = 'to_read' AND status IN (${opts.triage === "later" ? "'snoozed'" : "'done','dismissed'"}))`,
      params: [opts.viewer?.userId ?? null],
    });
  }
  return { sql: conditions.join(" AND "), params };
}

function excludesTriaged(opts: SessionFilters): boolean {
  return !!(opts.viewer?.userId && (opts.groupKey || opts.keyPrefix || opts.noGroup));
}

function hasSessionChainFilter(opts: SessionFilters): boolean {
  return !!(opts.triage || opts.status || opts.withUserId || excludesTriaged(opts));
}

const runningSql = `latestStatus NOT IN (${TERMINAL_TASK_STATUSES.map((s) => `'${s}'`).join(",")})`;

/**
 * A session starts at a parentTaskId IS NULL root. One recursive CTE computes
 * chain-wide latest activity for list ordering. Root filters precede recursion.
 * Read state and chain filters follow aggregation.
 */
export function sessionSummaryQuery(opts: SessionFilters = {}): SqlFragment {
  const root = sessionRootFilter(opts);
  const read = opts.viewer?.userId ? sessionReadStateSql(opts.now) : { sql: "NULL", params: [] };
  const params = [...root.params];
  if (opts.withUserId) params.push(opts.withUserId);
  params.push(...read.params, opts.viewer?.userId ?? null);
  const filters: string[] = [];
  if (opts.triage === "unread") filters.push("readState = 'unread'");
  else if (opts.triage === "later" || opts.triage === "done") {
    filters.push("readState = ?");
    params.push(opts.triage);
  } else if (opts.triage === "inbox" || excludesTriaged(opts)) {
    filters.push("(readState IS NULL OR readState IN ('read','unread'))");
  }
  if (opts.status === "running") filters.push(runningSql);
  if (opts.status === "failed") filters.push("latestStatus = 'failed'");
  if (opts.status === "needs") filters.push("needsYou = 1");
  if (opts.withUserId) {
    filters.push(`(a.withUser > 0 OR EXISTS (SELECT 1 FROM session_shares sh
      WHERE sh.rootTaskId = a.root_id AND sh.revokedAt IS NULL AND sh.userId = ?))`);
    params.push(opts.withUserId);
  }
  return {
    // SQLite takes the bare status from the row with MAX(lastUpdatedAt).
    // Keep this as the only MIN/MAX aggregate so status follows activity.
    sql: `WITH RECURSIVE chain(root_id, id, lastUpdatedAt, status, requestedByUserId) AS (
      SELECT r.id, r.id, r.lastUpdatedAt, r.status, r.requestedByUserId
      FROM agent_tasks r WHERE ${root.sql}
      UNION ALL
      SELECT c.root_id, t.id, t.lastUpdatedAt, t.status, t.requestedByUserId
      FROM chain c JOIN agent_tasks t ON t.parentTaskId = c.id
    ), agg AS (
      SELECT root_id, COUNT(*) AS chainCount,
        status AS latestStatus, MAX(lastUpdatedAt) AS lastActivityAt,
        ${opts.withUserId ? "SUM(requestedByUserId = ?) AS withUser," : ""}
        SUM(EXISTS (SELECT 1 FROM approval_requests ar
          WHERE ar.sourceTaskId = chain.id AND ar.status = 'pending')) AS pendingApproval
      FROM chain GROUP BY root_id
    ), state AS (
      SELECT a.*, ${read.sql} AS readState, s.snoozeUntil
      FROM agg a LEFT JOIN inbox_item_state s
        ON s.userId = ? AND s.itemType = 'to_read' AND s.itemId = a.root_id
    ), summary AS (
      SELECT *, (COALESCE(readState = 'unread' AND latestStatus = 'failed', 0) OR pendingApproval) AS needsYou
      FROM state
    )
    SELECT a.* FROM summary a ${filters.length ? `WHERE ${filters.join(" AND ")}` : ""}`,
    params,
  };
}

/**
 * One session's read state for a user, with the same rule and chain activity
 * as the list rows. Null when the user cannot see the root.
 */
export async function getSessionReadState(
  rootId: string,
  userId: string,
  now?: string,
): Promise<{ readState: SessionReadState; lastActivityAt: string } | null> {
  const query = sessionSummaryQuery({ rootId, viewer: { userId, scope: "all" }, now });
  const row = await getDbClient().get<{ readState: SessionReadState; lastActivityAt: string }>(
    `SELECT readState, lastActivityAt FROM (${query.sql})`,
    query.params,
  );
  return row?.readState ? { readState: row.readState, lastActivityAt: row.lastActivityAt } : null;
}

/** Count roots directly unless a filter needs chain activity or participants. */
export function sessionCountQuery(opts: SessionFilters = {}): SqlFragment {
  const chain = hasSessionChainFilter(opts);
  const query = chain ? sessionSummaryQuery(opts) : sessionRootFilter(opts);
  return {
    sql: chain
      ? `SELECT COUNT(*) AS count FROM (${query.sql})`
      : `SELECT COUNT(*) AS count FROM agent_tasks r WHERE ${query.sql}`,
    params: query.params,
  };
}

export interface SessionRowFields {
  readState?: SessionReadState;
  snoozeUntil?: string | null;
  needsYou?: boolean;
  groupKey?: string;
  shared?: boolean;
  people?: { id: string; name: string }[];
  peopleCount?: number;
  preview?: string | null;
  /** Active shares with their access. `userId` null means everyone on the swarm. */
  shares?: { userId: string | null; name: string | null; access: "read" | "write" }[];
}

/** Two page-wide queries load people, shares and bounded output previews. */
export async function sessionPageFields(
  roots: { id: string; requestedByUserId?: string }[],
): Promise<Map<string, SessionRowFields>> {
  const result = new Map<string, SessionRowFields>();
  if (!roots.length) return result;
  const ids = roots.map((r) => r.id);
  const [tasks, shares] = await Promise.all([
    getDbClient().query<{
      root_id: string;
      id: string | null;
      name: string | null;
      preview: string | null;
    }>(
      `WITH RECURSIVE chain(root_id, id) AS (
        SELECT id, id FROM agent_tasks WHERE id IN (${ids.map(() => "?").join(",")})
        UNION ALL SELECT c.root_id, t.id FROM chain c JOIN agent_tasks t ON t.parentTaskId = c.id
      ) SELECT c.root_id, t.requestedByUserId AS id, u.name,
        CASE WHEN t.source = 'system' AND t.taskType = 'follow-up' THEN NULL ELSE NULLIF(trim(substr(t.output, 1, 200)), '') END AS preview
      FROM chain c CROSS JOIN agent_tasks t ON t.id = c.id
      LEFT JOIN users u ON u.id = t.requestedByUserId
      ORDER BY t.lastUpdatedAt DESC, t.createdAt DESC, t.id DESC`,
      ids,
    ),
    getDbClient().query<{
      root_id: string;
      id: string | null;
      name: string | null;
      access: "read" | "write";
    }>(
      `SELECT sh.rootTaskId AS root_id, sh.userId AS id, u.name, sh.access FROM session_shares sh
      LEFT JOIN users u ON u.id = sh.userId
      WHERE sh.revokedAt IS NULL AND sh.rootTaskId IN (${ids.map(() => "?").join(",")})
      ORDER BY sh.createdAt, sh.id`,
      ids,
    ),
  ]);
  const people = new Map<string, Map<string, string>>();
  for (const root of roots) {
    result.set(root.id, { shared: false, preview: null, shares: [] });
    people.set(root.id, new Map());
  }
  // Chain rows are newest first. Reserve the requester slot before adding other people.
  for (const root of roots) {
    if (!root.requestedByUserId) continue;
    people.get(root.id)!.set(root.requestedByUserId, root.requestedByUserId);
  }
  for (const task of tasks) {
    if (task.id) people.get(task.root_id)!.set(task.id, task.name ?? task.id);
    const fields = result.get(task.root_id)!;
    if (fields.preview === null && task.preview !== null) fields.preview = task.preview;
  }
  for (const share of shares) {
    const fields = result.get(share.root_id)!;
    fields.shared = true;
    fields.shares!.push({ userId: share.id, name: share.name, access: share.access });
    if (share.id) people.get(share.root_id)!.set(share.id, share.name ?? share.id);
  }
  for (const [id, members] of people) {
    Object.assign(result.get(id)!, {
      people: [...members].slice(0, 8).map(([id, name]) => ({ id, name })),
      peopleCount: members.size,
    });
  }
  return result;
}

export interface SessionSectionCounts {
  total: number;
  unread: number;
  running: number;
  needsYou: number;
}
export interface SessionTreeGroup extends SessionSectionCounts {
  key: string;
  lastActivityAt: string;
}

export interface SessionTree {
  groups: SessionTreeGroup[];
  inbox: SessionSectionCounts;
  later: SessionSectionCounts;
  done: SessionSectionCounts;
  noGroup: SessionSectionCounts;
  /** Each root source in this view with its session count, hidden sources included, most first. */
  sources: { source: string; total: number }[];
}

export async function getSessionTree(
  actor: { kind: "bypass" } | { kind: "user"; userId: string | null },
  now?: string,
  opts: { mine?: boolean; hideSource?: string[] } = {},
): Promise<SessionTree> {
  // No source filter in SQL: the source counts must include hidden sources,
  // so the filter menu can offer them back. The loop skips them instead.
  const query = sessionSummaryQuery({
    ...(actor.kind === "user" ? { viewer: { userId: actor.userId, scope: "all" } as const } : {}),
    now,
    tree: true,
    mine: opts.mine,
  });
  const rows = await getDbClient().query<{
    key: string;
    source: string;
    lastActivityAt: string;
    latestStatus: string;
    readState: SessionReadState | null;
    needsYou: number;
  }>(
    `SELECT r."key", r.source, a.lastActivityAt, a.latestStatus, a.readState, a.needsYou
    FROM (${query.sql}) a CROSS JOIN agent_tasks r ON r.id = a.root_id`,
    query.params,
  );
  const counts = (): SessionSectionCounts => ({ total: 0, unread: 0, running: 0, needsYou: 0 });
  const result: SessionTree = {
    groups: [],
    inbox: counts(),
    later: counts(),
    done: counts(),
    noGroup: counts(),
    sources: [],
  };
  const hidden = new Set(opts.hideSource);
  const sources = new Map<string, number>();
  const groups = new Map<string, SessionTreeGroup>();
  const add = (section: SessionSectionCounts, row: (typeof rows)[number]) => {
    section.total++;
    if (row.readState === "unread") section.unread++;
    if (!isTerminalTaskStatus(row.latestStatus)) section.running++;
    if (row.needsYou) section.needsYou++;
  };
  for (const row of rows) {
    sources.set(row.source, (sources.get(row.source) ?? 0) + 1);
    if (hidden.has(row.source)) continue;
    const key = sessionGroupKey(row.key);
    const noGroup =
      key === "shared/" || (actor.kind === "user" && key === `personal/${actor.userId}/`);
    let group: SessionTreeGroup | undefined;
    if (!noGroup) {
      group = groups.get(key);
      if (!group) {
        group = { key, ...counts(), lastActivityAt: row.lastActivityAt };
        groups.set(key, group);
      }
      if (row.lastActivityAt > group.lastActivityAt) group.lastActivityAt = row.lastActivityAt;
    }
    if (row.readState === "later" || row.readState === "done") add(result[row.readState], row);
    else {
      add(result.inbox, row);
      if (noGroup) add(result.noGroup, row);
      else if (group) add(group, row);
    }
  }
  result.groups = [...groups.values()].sort((a, b) => a.key.localeCompare(b.key));
  result.sources = [...sources]
    .map(([source, total]) => ({ source, total }))
    .sort((a, b) => b.total - a.total || a.source.localeCompare(b.source));
  return result;
}

/** Triage actions on a whole list: the bulk bar's "Select all N". */
export type SessionListTriage = "done" | "inbox" | "read" | "unread";

/** The read cursor of "unread". The dashboard and the my-swarm app write the same value. */
const UNREAD_CURSOR = "1970-01-01T00:00:00.000Z";

/**
 * Apply one triage action to every session a sidebar list shows `userId`
 * (the same filters as `GET /api/sessions?scope=tree`), in one statement.
 * The rows match what the dashboard writes for one session: Done, back to
 * the Inbox, read up to the newest activity, or unread. Returns the number
 * of sessions written.
 */
export async function triageSessionList(
  userId: string,
  filters: Pick<SessionFilters, "triage" | "noGroup" | "groupKey" | "mine" | "hideSource" | "now">,
  action: SessionListTriage,
): Promise<number> {
  const now = filters.now ?? new Date().toISOString();
  const query = sessionSummaryQuery({
    ...filters,
    now,
    viewer: { userId, scope: "all" },
    tree: true,
  });
  const status = action === "done" ? "done" : "open";
  // `read` moves the cursor to each session's newest activity, `unread` to the epoch.
  const lastReadAt =
    action === "read" ? "a.lastActivityAt" : action === "unread" ? `'${UNREAD_CURSOR}'` : "NULL";
  const setsLastRead = action === "read" || action === "unread";
  // The conflict rules copy `upsertInboxState` in src/be/db.ts (sticky readAt,
  // lastReadAt only when the action sets it, snooze and dismiss cleared). Keep
  // the two in step. `WHERE true` is required: SQLite cannot parse
  // INSERT ... SELECT ... ON CONFLICT when the SELECT has no WHERE clause.
  const result = await getDbClient().run(
    `INSERT INTO inbox_item_state
      (userId, itemType, itemId, status, snoozeUntil, dismissedAt, doneAt, readAt, lastReadAt, createdAt, lastUpdatedAt)
    SELECT ?, 'to_read', a.root_id, ?, NULL, NULL, ?, ?, ${lastReadAt}, ?, ?
    FROM (${query.sql}) a WHERE true
    ON CONFLICT(userId, itemType, itemId) DO UPDATE SET
      status = excluded.status,
      snoozeUntil = NULL,
      dismissedAt = NULL,
      doneAt = excluded.doneAt,
      readAt = COALESCE(inbox_item_state.readAt, excluded.readAt),
      lastReadAt = ${setsLastRead ? "excluded.lastReadAt" : "inbox_item_state.lastReadAt"},
      lastUpdatedAt = excluded.lastUpdatedAt`,
    [
      userId,
      status,
      action === "done" ? now : null,
      action === "read" ? now : null,
      now,
      now,
      ...query.params,
    ],
  );
  return result.changes;
}
