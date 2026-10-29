import {
  keyPrefixRange,
  normalizeAssetKey,
  SESSION_LEAF_KINDS,
  sessionGroupKey,
} from "../../assets/key";
import {
  effectiveSource,
  isSourceThreadKey,
  NESTED_THREAD_MIN_ROOTS,
  SESSION_SOURCES,
  sessionThreadGroupKey,
  sourceOfKey,
} from "../../assets/source-key";
import { isTerminalTaskStatus, TERMINAL_TASK_STATUSES } from "../../types";
import { getDbClient, literalPrefixPattern } from "../db";
import {
  type SessionViewer,
  sessionMineCondition,
  sessionViewerCondition,
} from "./session-visibility";

export type SessionReadState = "unread" | "read" | "later" | "done";
export interface SessionFilters {
  /** Restrict roots to these raw task sources (`agent_tasks.source`). */
  source?: string[];
  /**
   * Leave out roots of these effective sources (the older sessions v2 source
   * filter). The effective source of a root under a source key prefix such as
   * `shared/slack/` is that source, else its raw task source.
   */
  hideSource?: string[];
  /**
   * Keep only roots of these effective sources (the sessions v2 source filter,
   * see `hideSource`). Unlike `source`, an empty list matches no root.
   */
  showSource?: string[];
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

/** How long a finished, read Inbox session stays quiet before it moves to Done on its own. */
const AUTO_DONE_QUIET_MS = 24 * 3600000;

/** The chain aggregates the read-state rule reads, as SQL expressions. */
interface ReadStateColumns {
  lastActivityAt: string;
  openTasks: string;
  pendingApproval: string;
  /** Whether the chain changed in a way that reopens a Done session; read only for a Done row `s`. */
  reopensDone: string;
}

/** The columns of the chain walk's `agg` rows (`legacySessionSummaryQuery`). */
const LEGACY_READ_STATE_COLUMNS: ReadStateColumns = {
  lastActivityAt: "a.lastActivityAt",
  openTasks: "a.openTasks",
  pendingApproval: "a.pendingApproval",
  reopensDone: "a.reopensDone > 0",
};

/**
 * Shared read-state rule with bound ISO timestamps for the list and tree.
 * Done holds through agent activity (progress, status changes, child tasks):
 * only `reopensDone` brings it back.
 *
 * Auto-Done: an Inbox session (`inboxScopeCondition` on its root `r`) reads
 * as Done once it reads as read, every chain task is finished, no approval
 * waits, and neither the chain nor the viewer's triage row changed for 24
 * hours. Nothing is written, so any new activity brings it back to the Inbox,
 * and a "back to Inbox" (which writes the row) holds for another 24 hours.
 * Later, Done marks, and groups are never auto-Done.
 */
function sessionReadStateSql(
  userId: string | null | undefined,
  now = new Date().toISOString(),
  a: ReadStateColumns = LEGACY_READ_STATE_COLUMNS,
): SqlFragment {
  const quiet = new Date(Date.parse(now) - AUTO_DONE_QUIET_MS).toISOString();
  const scope = inboxScopeCondition(userId);
  const autoDone = `(${a.openTasks} = 0 AND ${a.pendingApproval} = 0 AND ${a.lastActivityAt} <= ? AND ${scope.sql})`;
  const autoDoneParams = [quiet, ...scope.params];
  return {
    sql: `CASE
      WHEN s.id IS NULL THEN CASE
        WHEN ${a.lastActivityAt} > ? THEN 'unread'
        WHEN ${autoDone} THEN 'done'
        ELSE 'read' END
      WHEN s.status = 'dismissed' THEN 'done'
      WHEN s.status = 'done' THEN CASE WHEN ${a.reopensDone} THEN 'unread' ELSE 'done' END
      WHEN s.status = 'snoozed' THEN CASE WHEN s.snoozeUntil > ? THEN 'later' ELSE 'unread' END
      WHEN ${a.lastActivityAt} > COALESCE(s.lastReadAt, s.lastUpdatedAt) THEN 'unread'
      WHEN ${autoDone} AND s.lastUpdatedAt <= ? THEN 'done'
      ELSE 'read'
    END`,
    params: [
      new Date(Date.parse(now) - 7 * 86400000).toISOString(),
      ...autoDoneParams,
      now,
      ...autoDoneParams,
      quiet,
    ],
  };
}

function sourceKeyRanges() {
  return SESSION_SOURCES.map((source) => ({ source, ...keyPrefixRange(`shared/${source}/`) }));
}

/** Whether `r."key"` is a source thread key (`isSourceThreadKey`). */
function sourceThreadKeySql(): SqlFragment {
  const key = 'r."key"';
  // Trim the final slash, then all non-slash characters to locate the last segment.
  // For example, shared/slack/c1/thread:1.2/ gives thread:1.2/.
  const leaf = `substr(${key}, length(rtrim(rtrim(${key}, '/'), replace(${key}, '/', ''))) + 1)`;
  const ranges = sourceKeyRanges();
  return {
    sql: `(${ranges.map(() => `(${key} >= ? AND ${key} < ?)`).join(" OR ")}) AND ${leaf} GLOB 'thread:?*/'`,
    params: ranges.flatMap(({ lo, hi }) => [lo, hi]),
  };
}

/** Count every owned root at the exact source thread key, independent of viewer filters. */
export function threadRootsSql(): SqlFragment {
  const thread = sourceThreadKeySql();
  return {
    sql: `(CASE WHEN ${thread.sql}
      THEN (SELECT COUNT(*) FROM session_summaries session_thread_root
        WHERE session_thread_root."key" = r."key" AND session_thread_root.requestedByUserId IS NOT NULL)
      ELSE 0 END)`,
    params: thread.params,
  };
}

/** {@link threadRootsSql} for every source thread key at once: one grouped read for the tree. */
async function threadRootCounts(): Promise<Map<string, number>> {
  const thread = sourceThreadKeySql();
  const rows = await getDbClient().query<{ key: string; threadRoots: number }>(
    `SELECT r."key", COUNT(*) AS threadRoots FROM session_summaries r
    WHERE r.requestedByUserId IS NOT NULL AND ${thread.sql} GROUP BY r."key"`,
    thread.params,
  );
  return new Map(rows.map((row) => [row.key, row.threadRoots]));
}

/** A task's group with the list row's rule (`groupKey` on `GET /api/sessions`). */
export async function getSessionGroupKey(task: { id: string; key: string }): Promise<string> {
  const threadRoots = threadRootsSql();
  const row = await getDbClient().get<{ threadRoots: number }>(
    `SELECT ${threadRoots.sql} AS threadRoots FROM agent_tasks r WHERE r.id = ?`,
    [...threadRoots.params, task.id],
  );
  return sessionThreadGroupKey(task.key, row?.threadRoots ?? 0);
}

/**
 * `scan` keeps the key index out of the range (unary `+`). A broad prefix such
 * as `shared/` holds most roots, where one pass over the narrow summaries
 * beats an index lookup per row; without planner statistics SQLite cannot tell.
 */
function groupCondition(group: string, scan = false): SqlFragment {
  const { lo, hi } = keyPrefixRange(group);
  // The remaining key must be one resource leaf, with no nested path.
  // SQLite substr/length count code points, so count them here too (not UTF-16 units).
  const start = [...lo].length + 1;
  const threadRoots = threadRootsSql();
  return {
    sql: `(${scan ? "+" : ""}r."key" >= ? AND ${scan ? "+" : ""}r."key" < ? AND (r."key" = ? OR (
      instr(substr(r."key", ?, length(r."key") - ?), '/') = 0 AND
      (${SESSION_LEAF_KINDS.map(() => 'substr(r."key", ?) GLOB ?').join(" OR ")}) AND
      ${threadRoots.sql} < ?
    )))`,
    params: [
      lo,
      hi,
      lo,
      start,
      start,
      ...SESSION_LEAF_KINDS.flatMap((kind) => [start, `${kind}:?*/`]),
      ...threadRoots.params,
      NESTED_THREAD_MIN_ROOTS,
    ],
  };
}

/** No group: roots at `shared/` and at the viewer's `personal/<me>/`, with their direct leaves. */
function noGroupCondition(userId: string | null | undefined): SqlFragment {
  const groups = [groupCondition("shared/", true)];
  if (userId) groups.push(groupCondition(`personal/${userId}/`, true));
  return {
    sql: `(${groups.map((g) => g.sql).join(" OR ")})`,
    params: groups.flatMap((g) => g.params),
  };
}

/**
 * Roots the Inbox holds: No group and the source sections (Slack, Telegram,
 * Discord), which file sessions on their own. A session that a person filed
 * into a group (My groups, Shared with me) shows under that group only.
 */
function inboxScopeCondition(userId: string | null | undefined): SqlFragment {
  const ranges = sourceKeyRanges();
  const noGroup = noGroupCondition(userId);
  return {
    sql: `(${ranges.map(() => '(+r."key" >= ? AND +r."key" < ?)').join(" OR ")} OR ${noGroup.sql})`,
    params: [...ranges.flatMap(({ lo, hi }) => [lo, hi]), ...noGroup.params],
  };
}

/** `effectiveSource` of the root `r` in SQL, with key ranges so the key index still serves it. */
function effectiveSourceSql(): SqlFragment {
  const ranges = sourceKeyRanges();
  return {
    sql: `(CASE ${ranges.map(() => `WHEN r."key" >= ? AND r."key" < ? THEN ?`).join(" ")} ELSE r.source END)`,
    params: ranges.flatMap(({ source, lo, hi }) => [lo, hi, source]),
  };
}

/**
 * One row per session root: `session_summaries` (migration 253) with the root
 * id as `id`, so the root filters below apply to it as they would to the root
 * task. SQLite flattens the subquery, so the summary indexes still serve them.
 */
const SESSION_ROOTS = "(SELECT rootId AS id, * FROM session_summaries)";

/**
 * Conditions on a session root `r`: a {@link SESSION_ROOTS} row or a root task
 * (`legacySessionSummaryQuery`). Only `q` reads the root task itself.
 */
export function sessionRootFilter(opts: SessionFilters = {}): SqlFragment {
  const conditions: string[] = [];
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
  if (hidden.length) {
    const source = effectiveSourceSql();
    add({
      sql: `${source.sql} NOT IN (${hidden.map(() => "?").join(",")})`,
      params: [...source.params, ...hidden],
    });
  }
  if (opts.showSource) {
    const shown = opts.showSource.filter(Boolean);
    const source = effectiveSourceSql();
    add(
      shown.length
        ? {
            sql: `${source.sql} IN (${shown.map(() => "?").join(",")})`,
            params: [...source.params, ...shown],
          }
        : { sql: "0", params: [] },
    );
  }
  if (opts.q?.trim()) {
    const like = `%${opts.q.trim().toLowerCase()}%`;
    add({
      sql: `EXISTS (SELECT 1 FROM agent_tasks rt WHERE rt.id = r.id
        AND (lower(rt.task) LIKE ? OR lower(COALESCE(rt.title, '')) LIKE ?))`,
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
    // Unary +: a full pass over the narrow summaries beats the partial thread index here.
    if (opts.tree) conditions.push("+r.requestedByUserId IS NOT NULL");
    if (opts.mine) add(sessionMineCondition(opts.viewer.userId));
  }
  if (opts.keyPrefix) {
    const { lo, hi } = keyPrefixRange(opts.keyPrefix);
    add({ sql: 'r."key" >= ? AND r."key" < ?', params: [lo, hi] });
  }
  if (opts.groupKey) add(groupCondition(normalizeAssetKey(opts.groupKey)));
  if (opts.noGroup) add(noGroupCondition(opts.viewer?.userId));
  if (opts.triage === "inbox") add(inboxScopeCondition(opts.viewer?.userId));
  if (opts.triage === "later" || opts.triage === "done") {
    const marked: SqlFragment = {
      sql: `r.id IN (SELECT itemId FROM inbox_item_state
        WHERE userId = ? AND itemType = 'to_read' AND status IN (${opts.triage === "later" ? "'snoozed'" : "'done','dismissed'"}))`,
      params: [opts.viewer?.userId ?? null],
    };
    // Done also holds auto-Done Inbox sessions, which have no Done row.
    const scope = inboxScopeCondition(opts.viewer?.userId);
    add(
      opts.triage === "done" && opts.viewer?.userId
        ? { sql: `(${marked.sql} OR ${scope.sql})`, params: [...marked.params, ...scope.params] }
        : marked,
    );
  }
  return { sql: conditions.length ? conditions.join(" AND ") : "1", params };
}

function excludesTriaged(opts: SessionFilters): boolean {
  return !!(opts.viewer?.userId && (opts.groupKey || opts.keyPrefix || opts.noGroup));
}

function hasSessionChainFilter(opts: SessionFilters): boolean {
  return !!(opts.triage || opts.status || opts.withUserId || excludesTriaged(opts));
}

const terminalSql = TERMINAL_TASK_STATUSES.map((s) => `'${s}'`).join(",");
const runningSql = `latestStatus NOT IN (${terminalSql})`;
const openTaskSql = `chain.status NOT IN (${terminalSql})`;

/**
 * Sources of tasks that agents and the server create: delegation and scripts
 * (`mcp`), follow-ups (`system`), deferred wake-ups (`schedule`) and workflow
 * steps. Agents also set `requestedByUserId` explicitly on these, so a requester
 * alone does not mark a human message.
 */
const AGENT_TASK_SOURCES = ["mcp", "system", "schedule", "workflow"] as const;

/**
 * Per chain row, over `chain` and the viewer's Done row `d`: whether the row
 * needs the user since they marked the session Done. That is a human message
 * (a task attributed to a person directly, not copied from its parent, from a
 * human channel), a person's steering message on a chain task (steer or
 * queue, not cancelled), or a pending approval, created after the Done mark.
 * Steering `created_at` and the Done mark's `lastUpdatedAt` are both written
 * as `%Y-%m-%dT%H:%M:%fZ`, so they compare as text.
 */
const reopensDoneSql = `(d.id IS NOT NULL AND (
        (chain.createdAt > d.lastUpdatedAt
          AND chain.requestedByUserId IS NOT NULL
          AND chain.requestedByUserIdInherited = 0
          AND COALESCE(chain.source, '') NOT IN (${AGENT_TASK_SOURCES.map((s) => `'${s}'`).join(",")}))
        OR EXISTS (SELECT 1 FROM task_steering_messages sm
          WHERE sm.task_id = chain.id AND sm.created_by_kind = 'user'
            AND sm.status != 'cancelled' AND sm.created_at > d.lastUpdatedAt)
        OR EXISTS (SELECT 1 FROM approval_requests ar
          WHERE ar.sourceTaskId = chain.id AND ar.status = 'pending' AND ar.createdAt > d.lastUpdatedAt)
      ))`;

/** Filters on summary rows `a` (read state, latest status, participants), after aggregation. */
function summaryRowFilters(opts: SessionFilters): SqlFragment {
  const params: SqlFragment["params"] = [];
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
  return { sql: filters.length ? `WHERE ${filters.join(" AND ")}` : "", params };
}

/**
 * One row per visible session root, with its chain aggregates, the viewer's
 * read state and `needsYou`. It reads the trigger-kept `session_summaries`, so
 * no request walks a chain: root filters, then one primary-key join for the
 * viewer's triage row. Same rule and columns as {@link legacySessionSummaryQuery},
 * plus the root columns the list and tree order and group by.
 */
export function sessionSummaryQuery(opts: SessionFilters = {}): SqlFragment {
  const root = sessionRootFilter(opts);
  const read = opts.viewer?.userId
    ? sessionReadStateSql(opts.viewer.userId, opts.now, {
        lastActivityAt: "r.lastActivityAt",
        openTasks: "r.openTaskCount",
        pendingApproval: "r.pendingApprovalCount",
        // The newest human event is newer than the Done mark (`reopensDoneSql`).
        reopensDone: "r.lastHumanAt > s.lastUpdatedAt",
      })
    : { sql: "NULL", params: [] };
  const filters = summaryRowFilters(opts);
  // Sessions where the user requested any chain task, from the requester index.
  const withUser = opts.withUserId
    ? `r.id IN (SELECT m.rootId FROM agent_tasks t JOIN session_members m ON m.taskId = t.id
        WHERE t.requestedByUserId = ?) AS withUser,`
    : "";
  return {
    sql: `WITH state AS (
      SELECT r.id AS root_id, r.createdAt AS rootCreatedAt, r."key", r.source, r.slackChannelId,
        r.chainCount, r.latestStatus, r.lastActivityAt, ${withUser}
        r.pendingApprovalCount AS pendingApproval, r.openTaskCount AS openTasks,
        ${read.sql} AS readState, s.snoozeUntil
      FROM ${SESSION_ROOTS} r LEFT JOIN inbox_item_state s
        ON s.userId = ? AND s.itemType = 'to_read' AND s.itemId = r.id
      WHERE ${root.sql}
    ), summary AS (
      SELECT *, (COALESCE(readState = 'unread' AND latestStatus = 'failed', 0) OR pendingApproval) AS needsYou
      FROM state
    )
    SELECT a.* FROM summary a ${filters.sql}`,
    params: [
      ...(opts.withUserId ? [opts.withUserId] : []),
      ...read.params,
      opts.viewer?.userId ?? null,
      ...root.params,
      ...filters.params,
    ],
  };
}

/**
 * The chain walk the summaries replace: a session starts at a parentTaskId IS
 * NULL root, and one recursive CTE computes chain-wide latest activity. Root
 * filters precede recursion; read state and chain filters follow aggregation.
 * Off the request path: tests compare {@link sessionSummaryQuery} with it.
 */
export function legacySessionSummaryQuery(opts: SessionFilters = {}): SqlFragment {
  const root = sessionRootFilter(opts);
  const read = opts.viewer?.userId
    ? sessionReadStateSql(opts.viewer.userId, opts.now)
    : { sql: "NULL", params: [] };
  const filters = summaryRowFilters(opts);
  const params = [...root.params];
  if (opts.withUserId) params.push(opts.withUserId);
  params.push(opts.viewer?.userId ?? null, ...read.params, opts.viewer?.userId ?? null);
  params.push(...filters.params);
  return {
    // SQLite takes the bare status from the row with MAX(lastUpdatedAt).
    // Keep this as the only MIN/MAX aggregate so status follows activity.
    // `d` is the viewer's Done row, so `reopensDone` can compare chain rows
    // against the Done mark (SUM keeps MAX the only MIN/MAX aggregate).
    sql: `WITH RECURSIVE chain(root_id, id, lastUpdatedAt, status, requestedByUserId,
        createdAt, source, requestedByUserIdInherited) AS (
      SELECT r.id, r.id, r.lastUpdatedAt, r.status, r.requestedByUserId,
        r.createdAt, r.source, r.requestedByUserIdInherited
      FROM agent_tasks r WHERE r.parentTaskId IS NULL AND ${root.sql}
      UNION ALL
      SELECT c.root_id, t.id, t.lastUpdatedAt, t.status, t.requestedByUserId,
        t.createdAt, t.source, t.requestedByUserIdInherited
      FROM chain c JOIN agent_tasks t ON t.parentTaskId = c.id
    ), agg AS (
      SELECT chain.root_id, COUNT(*) AS chainCount,
        chain.status AS latestStatus, MAX(chain.lastUpdatedAt) AS lastActivityAt,
        ${opts.withUserId ? "SUM(chain.requestedByUserId = ?) AS withUser," : ""}
        SUM(EXISTS (SELECT 1 FROM approval_requests ar
          WHERE ar.sourceTaskId = chain.id AND ar.status = 'pending')) AS pendingApproval,
        SUM(${openTaskSql}) AS openTasks,
        SUM(${reopensDoneSql}) AS reopensDone
      FROM chain LEFT JOIN inbox_item_state d
        ON d.userId = ? AND d.itemType = 'to_read' AND d.itemId = chain.root_id AND d.status = 'done'
      GROUP BY chain.root_id
    ), state AS (
      SELECT a.*, ${read.sql} AS readState, s.snoozeUntil
      FROM agg a CROSS JOIN agent_tasks r ON r.id = a.root_id LEFT JOIN inbox_item_state s
        ON s.userId = ? AND s.itemType = 'to_read' AND s.itemId = a.root_id
    ), summary AS (
      SELECT *, (COALESCE(readState = 'unread' AND latestStatus = 'failed', 0) OR pendingApproval) AS needsYou
      FROM state
    )
    SELECT a.* FROM summary a ${filters.sql}`,
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
      : `SELECT COUNT(*) AS count FROM ${SESSION_ROOTS} r WHERE ${query.sql}`,
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
      `SELECT m.rootId AS root_id, t.requestedByUserId AS id, u.name,
        CASE WHEN t.source = 'system' AND t.taskType = 'follow-up' THEN NULL ELSE NULLIF(trim(substr(t.output, 1, 200)), '') END AS preview
      FROM session_members m CROSS JOIN agent_tasks t ON t.id = m.taskId
      LEFT JOIN users u ON u.id = t.requestedByUserId
      WHERE m.rootId IN (${ids.map(() => "?").join(",")})
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
  /** Each effective root source in this view with its session count, hidden sources included, most first. */
  sources: { source: string; total: number }[];
  /** Every source group key in this view, hidden sources included, so a pane of a hidden source still gets its label. */
  sourceGroups: string[];
  /** Slack channel ids backed by visible roots with matching Slack fields, including hidden sources. */
  slackChannels: string[];
  /**
   * The oldest visible root of each nested source thread, including hidden
   * sources: its title, else a preview of its prompt without the thread context.
   */
  threadLabels: Record<string, string>;
}

/**
 * The first `<thread_context>` block of a prompt, as the Slack and Chat SDK
 * templates write it (each tag alone on its line). It holds the earlier thread
 * messages, so a label cut from the start of the prompt never reaches the ask.
 */
const THREAD_OPEN = "<thread_context>";
const THREAD_CLOSE = "</thread_context>";
const THREAD_OPEN_AT = `instr(r.task, '${THREAD_OPEN}' || char(10))`;
const THREAD_CLOSE_AT = `instr(r.task, char(10) || '${THREAD_CLOSE}')`;
/**
 * The task list preview length. The UI reads this length plus "…" as a list
 * preview and repairs a Slack token or a block that the cut splits
 * (`isListPreview` in `apps/ui/src/lib/prompt-display.ts`).
 */
const THREAD_LABEL_LENGTH = 300;
/** Extra characters for the blank lines that `threadPromptPreview` trims, so the preview stays full. */
const THREAD_LABEL_TRIM_MARGIN = 100;
/** The prompt of `r` without its first thread context block, cut for `threadPromptPreview`. */
const THREAD_PROMPT_SQL = `substr(CASE
    WHEN ${THREAD_OPEN_AT} > 0 AND ${THREAD_CLOSE_AT} > ${THREAD_OPEN_AT}
    THEN substr(r.task, 1, ${THREAD_OPEN_AT} - 1) || substr(r.task, ${THREAD_CLOSE_AT} + ${THREAD_CLOSE.length + 1})
    ELSE r.task END, 1, ${THREAD_LABEL_LENGTH + THREAD_LABEL_TRIM_MARGIN})`;

function threadPromptPreview(prompt: string): string {
  const text = prompt.trim();
  return text.length > THREAD_LABEL_LENGTH ? `${text.slice(0, THREAD_LABEL_LENGTH)}…` : text;
}

export async function getSessionTree(
  actor: { kind: "bypass" } | { kind: "user"; userId: string | null },
  now?: string,
  opts: { mine?: boolean; hideSource?: string[]; showSource?: string[] } = {},
): Promise<SessionTree> {
  // No source filter in SQL: the source counts must include hidden sources,
  // so the filter menu can offer them back. The loop skips them instead.
  const query = sessionSummaryQuery({
    ...(actor.kind === "user" ? { viewer: { userId: actor.userId, scope: "all" } as const } : {}),
    now,
    tree: true,
    mine: opts.mine,
  });
  const [rows, threadRoots] = await Promise.all([
    getDbClient().query<{
      root_id: string;
      key: string;
      source: string;
      slackChannelId: string | null;
      lastActivityAt: string;
      latestStatus: string;
      readState: SessionReadState | null;
      needsYou: number;
    }>(
      `SELECT a.root_id, a."key", a.source, a.slackChannelId, a.lastActivityAt, a.latestStatus,
        a.readState, a.needsYou
      FROM (${query.sql}) a`,
      query.params,
    ),
    threadRootCounts(),
  ]);
  const counts = (): SessionSectionCounts => ({ total: 0, unread: 0, running: 0, needsYou: 0 });
  const result: SessionTree = {
    groups: [],
    inbox: counts(),
    later: counts(),
    done: counts(),
    noGroup: counts(),
    sources: [],
    sourceGroups: [],
    slackChannels: [],
    threadLabels: {},
  };
  const hidden = new Set(opts.hideSource);
  const shown = opts.showSource ? new Set(opts.showSource) : null;
  const sources = new Map<string, number>();
  const sourceGroups = new Set<string>();
  const slackChannels = new Set<string>();
  const threadRootIds: string[] = [];
  const groups = new Map<string, SessionTreeGroup>();
  const add = (section: SessionSectionCounts, row: (typeof rows)[number]) => {
    section.total++;
    if (row.readState === "unread") section.unread++;
    if (!isTerminalTaskStatus(row.latestStatus)) section.running++;
    if (row.needsYou) section.needsYou++;
  };
  for (const row of rows) {
    const source = effectiveSource(row.key, row.source);
    sources.set(source, (sources.get(source) ?? 0) + 1);
    const rowThreadRoots = threadRoots.get(row.key) ?? 0;
    const key = sessionThreadGroupKey(row.key, rowThreadRoots);
    const sourceGroupKey = sessionGroupKey(row.key);
    const channelId = /^shared\/slack\/([^/]+)\/$/.exec(sourceGroupKey)?.[1];
    if (channelId && row.slackChannelId?.toLowerCase() === channelId) {
      slackChannels.add(channelId);
    }
    if (rowThreadRoots >= NESTED_THREAD_MIN_ROOTS && isSourceThreadKey(row.key)) {
      threadRootIds.push(row.root_id);
      sourceGroups.add(sourceGroupKey);
    }
    if (sourceOfKey(key)) sourceGroups.add(key);
    if (hidden.has(source) || (shown && !shown.has(source))) continue;
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
      // A session filed into a group shows under it only (`inboxScopeCondition`).
      if (noGroup || sourceOfKey(key)) add(result.inbox, row);
      if (noGroup) add(result.noGroup, row);
      else if (group) add(group, row);
    }
  }
  result.groups = [...groups.values()].sort((a, b) => a.key.localeCompare(b.key));
  result.sources = [...sources]
    .map(([source, total]) => ({ source, total }))
    .sort((a, b) => b.total - a.total || a.source.localeCompare(b.source));
  result.sourceGroups = [...sourceGroups].sort();
  result.slackChannels = [...slackChannels].sort();
  if (threadRootIds.length) {
    // A missing or empty title falls back to a preview of the prompt without its thread context.
    const labels = await getDbClient().query<{ key: string; title: string | null; prompt: string }>(
      `SELECT "key", title, prompt FROM (
        SELECT r."key", NULLIF(trim(r.title), '') AS title, ${THREAD_PROMPT_SQL} AS prompt,
          ROW_NUMBER() OVER (PARTITION BY r."key" ORDER BY r.createdAt, r.rowid) AS ordinal
        FROM agent_tasks r WHERE r.id IN (${threadRootIds.map(() => "?").join(",")})
      ) WHERE ordinal = 1`,
      threadRootIds,
    );
    result.threadLabels = Object.fromEntries(
      labels.map((row) => [row.key, row.title ?? threadPromptPreview(row.prompt)]),
    );
  }
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
  filters: Pick<
    SessionFilters,
    "triage" | "noGroup" | "groupKey" | "mine" | "hideSource" | "showSource" | "now"
  >,
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
