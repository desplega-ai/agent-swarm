/**
 * SQLite text of the session tree reads (`session_summaries` roots, the
 * legacy chain walk, read state, triage). The application resolves the asset
 * key rules into ranges and patterns; this module only writes SQL. It keeps
 * SQLite's GLOB, `instr`, unary `+` index hints and integer booleans.
 */
import {
  EMPTY,
  type SessionGroupSpec,
  type SessionInboxScope,
  type SessionReadStateSpec,
  type SessionRootFilterSpec,
  type SessionSummarySpec,
  type SessionTreeRules,
  type SessionViewerSpec,
  SqlQuery,
  sql,
  sqlJoin,
  sqlList,
} from "@desplega/storage";

const or = (parts: readonly SqlQuery[]): SqlQuery => sqlJoin(parts, sql` OR `);

/** Code constants written as SQL string literals (as the queries always had them). */
function literals(values: readonly string[]): SqlQuery {
  for (const value of values) {
    if (!/^[a-z][a-z0-9_-]*$/.test(value)) throw new Error(`Not a plain literal: ${value}`);
  }
  return new SqlQuery([values.map((value) => `'${value}'`).join(",")], []);
}

/**
 * One row per session root: `session_summaries` (migration 253) with the root
 * id as `id`, so the root filters apply to it as they would to the root task.
 * SQLite flattens the subquery, so the summary indexes still serve them.
 */
export const SESSION_ROOTS = sql`(SELECT "rootId" AS id, * FROM session_summaries)`;

/** Whether `r."key"` is a source thread key. */
export function sourceThreadKeySql(rules: SessionTreeRules): SqlQuery {
  const key = sql`r."key"`;
  // Trim the final slash, then all non-slash characters to locate the last segment.
  // For example, shared/slack/c1/thread:1.2/ gives thread:1.2/.
  const leaf = sql`substr(${key}, length(rtrim(rtrim(${key}, '/'), replace(${key}, '/', ''))) + 1)`;
  const ranges = or(
    rules.sourceRanges.map(({ lo, hi }) => sql`(${key} >= ${lo} AND ${key} < ${hi})`),
  );
  return sql`(${ranges}) AND ${leaf} GLOB 'thread:?*/'`;
}

/** Count every owned root at the exact source thread key, independent of viewer filters. */
export function threadRootsSql(rules: SessionTreeRules): SqlQuery {
  return sql`(CASE WHEN ${sourceThreadKeySql(rules)}
      THEN (SELECT COUNT(*) FROM session_summaries session_thread_root
        WHERE session_thread_root."key" = r."key" AND session_thread_root."requestedByUserId" IS NOT NULL)
      ELSE 0 END)`;
}

/** `scan` keeps the key index out of the range (unary `+`). */
function groupSql(rules: SessionTreeRules, group: SessionGroupSpec): SqlQuery {
  const plus = group.scan ? sql`+` : EMPTY;
  const leaves = or(
    group.leafPatterns.map((pattern) => sql`substr(r."key", ${group.start}) GLOB ${pattern}`),
  );
  return sql`(${plus}r."key" >= ${group.lo} AND ${plus}r."key" < ${group.hi} AND (r."key" = ${group.lo} OR (
      instr(substr(r."key", ${group.start}, length(r."key") - ${group.start}), '/') = 0 AND
      (${leaves}) AND
      ${threadRootsSql(rules)} < ${rules.nestedThreadMinRoots}
    )))`;
}

function noGroupSql(rules: SessionTreeRules, groups: readonly SessionGroupSpec[]): SqlQuery {
  return sql`(${or(groups.map((group) => groupSql(rules, group)))})`;
}

function inboxScopeSql(rules: SessionTreeRules, scope: SessionInboxScope): SqlQuery {
  const ranges = or(
    scope.ranges.map(({ lo, hi }) => sql`(+r."key" >= ${lo} AND +r."key" < ${hi})`),
  );
  return sql`(${ranges} OR ${noGroupSql(rules, scope.noGroup)})`;
}

/** The effective source of the root `r`, with key ranges so the key index still serves it. */
function effectiveSourceSql(rules: SessionTreeRules): SqlQuery {
  const whens = sqlJoin(
    rules.sourceRanges.map(
      ({ source, lo, hi }) => sql`WHEN r."key" >= ${lo} AND r."key" < ${hi} THEN ${source}`,
    ),
    sql` `,
  );
  return sql`(CASE ${whens} ELSE r.source END)`;
}

function sharedWithSql(userId: string | null): SqlQuery {
  // Uncorrelated, so SQLite builds the shared set once instead of probing per root.
  return sql`r.id IN (SELECT s."rootTaskId" FROM session_shares s
      WHERE s."revokedAt" IS NULL AND (s."userId" IS NULL OR s."userId" = ${userId}))`;
}

/** Roots (alias `r`) a viewer may open in a session list. */
export function sessionViewerSql(viewer: SessionViewerSpec): SqlQuery {
  if (viewer.scope === "all" && viewer.readAll) return sql`1`;
  if (viewer.scope === "mine") return sql`r."requestedByUserId" = ${viewer.userId}`;
  if (viewer.scope === "shared") {
    return sql`(r."requestedByUserId" IS NOT NULL AND r."requestedByUserId" IS NOT ${viewer.userId} AND ${sharedWithSql(viewer.userId)})`;
  }
  return sql`(r."requestedByUserId" IS NULL OR r."requestedByUserId" = ${viewer.userId} OR r."scheduleId" IS NOT NULL OR ${sharedWithSql(viewer.userId)})`;
}

/** The Mine view on roots `r`: human-started roots of the user, plus shared ones. */
export function sessionMineSql(
  rules: SessionTreeRules,
  userId: string | null,
  readAll?: boolean,
): SqlQuery {
  const humanStarted = sql`(r.source NOT IN (${sqlList(rules.machineSources)})
        OR (r.source = 'system' AND r."taskType" IN (${sqlList(rules.humanSystemTaskTypes)})))`;
  return readAll
    ? sql`(${humanStarted} OR ${sharedWithSql(userId)})`
    : sql`((r."requestedByUserId" = ${userId} AND ${humanStarted}) OR ${sharedWithSql(userId)})`;
}

export function sessionRootFilterSql(
  rules: SessionTreeRules,
  spec: SessionRootFilterSpec,
): SqlQuery {
  const conditions: SqlQuery[] = [];
  const includeScheduled = (condition: SqlQuery): SqlQuery =>
    spec.includeScheduleRuns ? sql`(${condition} OR r."scheduleId" IS NOT NULL)` : condition;
  if (spec.rootId) conditions.push(sql`r.id = ${spec.rootId}`);
  if (spec.rootIds) {
    conditions.push(spec.rootIds.length ? sql`r.id IN (${sqlList(spec.rootIds)})` : sql`0`);
  }
  if (spec.exceptRootIds?.length) {
    conditions.push(sql`r.id NOT IN (${sqlList(spec.exceptRootIds)})`);
  }
  if (spec.sources?.length) conditions.push(sql`r.source IN (${sqlList(spec.sources)})`);
  if (spec.hideSources?.length) {
    conditions.push(sql`${effectiveSourceSql(rules)} NOT IN (${sqlList(spec.hideSources)})`);
  }
  if (spec.showSources) {
    conditions.push(
      includeScheduled(
        spec.showSources.length
          ? sql`${effectiveSourceSql(rules)} IN (${sqlList(spec.showSources)})`
          : sql`0`,
      ),
    );
  }
  if (spec.textLike !== undefined) {
    conditions.push(sql`EXISTS (SELECT 1 FROM agent_tasks rt WHERE rt.id = r.id
        AND (lower(rt.task) LIKE ${spec.textLike} OR lower(COALESCE(rt.title, '')) LIKE ${spec.textLike}))`);
  }
  if (spec.requestedByUserId !== undefined) {
    conditions.push(sql`r."requestedByUserId" = ${spec.requestedByUserId}`);
  }
  if (spec.contextKeyPattern !== undefined) {
    conditions.push(sql`r."contextKey" LIKE ${spec.contextKeyPattern} ESCAPE '\\'`);
  }
  if (spec.viewer) {
    conditions.push(sessionViewerSql(spec.viewer));
    // Unary +: a full pass over the narrow summaries beats the partial thread index here.
    if (spec.tree) conditions.push(includeScheduled(sql`+r."requestedByUserId" IS NOT NULL`));
    if (spec.mine) {
      conditions.push(
        includeScheduled(sessionMineSql(rules, spec.viewer.userId, spec.viewer.readAll)),
      );
    }
  }
  if (spec.keyRange) {
    conditions.push(sql`r."key" >= ${spec.keyRange.lo} AND r."key" < ${spec.keyRange.hi}`);
  }
  if (spec.keyRanges?.length) {
    conditions.push(
      sql`(${or(spec.keyRanges.map(({ lo, hi }) => sql`(r."key" >= ${lo} AND r."key" < ${hi})`))})`,
    );
  }
  if (spec.group) conditions.push(groupSql(rules, spec.group));
  if (spec.noGroup) conditions.push(noGroupSql(rules, spec.noGroup));
  if (spec.inbox) conditions.push(inboxScopeSql(rules, spec.inbox));
  if (spec.marked) {
    const statuses = spec.marked.triage === "later" ? sql`'snoozed'` : sql`'done','dismissed'`;
    const marked = sql`r.id IN (SELECT "itemId" FROM inbox_item_state
        WHERE "userId" = ${spec.marked.userId} AND "itemType" = 'to_read' AND status IN (${statuses}))`;
    // Done also holds auto-Done Inbox sessions, which have no Done row.
    conditions.push(
      spec.marked.orInbox
        ? sql`(${marked} OR ${inboxScopeSql(rules, spec.marked.orInbox)})`
        : marked,
    );
  }
  return conditions.length ? sqlJoin(conditions, sql` AND `) : sql`1`;
}

/** The chain aggregates the read-state rule reads, as SQL expressions. */
type ReadStateColumns = {
  lastActivityAt: SqlQuery;
  openTasks: SqlQuery;
  pendingApproval: SqlQuery;
  /** Whether the chain changed in a way that reopens a Done session; read only for a Done row `s`. */
  reopensDone: SqlQuery;
};

/** The columns of the chain walk's `agg` rows (`legacySessionSummarySql`). */
const LEGACY_READ_STATE_COLUMNS: ReadStateColumns = {
  lastActivityAt: sql`a."lastActivityAt"`,
  openTasks: sql`a."openTasks"`,
  pendingApproval: sql`a."pendingApproval"`,
  reopensDone: sql`a."reopensDone" > 0`,
};

/**
 * The read-state rule. Done holds through agent activity: only `reopensDone`
 * brings it back. An Inbox session reads as Done once it reads as read, every
 * chain task is finished, no approval waits, and neither the chain nor the
 * viewer's triage row changed since `quietBefore`.
 */
function readStateSql(
  rules: SessionTreeRules,
  read: SessionReadStateSpec,
  a: ReadStateColumns = LEGACY_READ_STATE_COLUMNS,
): SqlQuery {
  const autoDone = sql`(${a.openTasks} = 0 AND ${a.pendingApproval} = 0 AND ${a.lastActivityAt} <= ${read.quietBefore} AND ${inboxScopeSql(rules, read.inbox)})`;
  return sql`CASE
      WHEN s.id IS NULL THEN CASE
        WHEN ${a.lastActivityAt} > ${read.unreadSince} THEN 'unread'
        WHEN ${autoDone} THEN 'done'
        ELSE 'read' END
      WHEN s.status = 'dismissed' THEN 'done'
      WHEN s.status = 'done' THEN CASE WHEN ${a.reopensDone} THEN 'unread' ELSE 'done' END
      WHEN s.status = 'snoozed' THEN CASE WHEN s."snoozeUntil" > ${read.now} THEN 'later' ELSE 'unread' END
      WHEN ${a.lastActivityAt} > COALESCE(s."lastReadAt", s."lastUpdatedAt") THEN 'unread'
      WHEN ${autoDone} AND s."lastUpdatedAt" <= ${read.quietBefore} THEN 'done'
      ELSE 'read'
    END`;
}

/** Filters on summary rows `a` (read state, latest status, participants), after aggregation. */
function summaryRowFiltersSql(rules: SessionTreeRules, spec: SessionSummarySpec): SqlQuery {
  const running = sql`"latestStatus" NOT IN (${literals(rules.terminalStatuses)})`;
  /** Running with nothing for the person to answer: the Working section, not the Inbox. */
  const working = sql`(${running} AND "needsYou" = 0)`;
  const filters: SqlQuery[] = [];
  if (spec.triage === "unread") filters.push(sql`"readState" = 'unread'`);
  else if (spec.triage === "later" || spec.triage === "done") {
    filters.push(sql`"readState" = ${spec.triage}`);
  } else if (spec.triage === "inbox" || spec.triage === "working" || spec.excludesTriaged) {
    filters.push(sql`("readState" IS NULL OR "readState" IN ('read','unread'))`);
  }
  if (spec.triage === "inbox") filters.push(sql`NOT (${working})`);
  if (spec.triage === "working") filters.push(working);
  if (spec.status === "running") filters.push(running);
  if (spec.status === "failed") filters.push(sql`"latestStatus" = 'failed'`);
  if (spec.status === "needs") filters.push(sql`"needsYou" = 1`);
  if (spec.withUserId) {
    filters.push(sql`(a."withUser" > 0 OR EXISTS (SELECT 1 FROM session_shares sh
      WHERE sh."rootTaskId" = a.root_id AND sh."revokedAt" IS NULL AND sh."userId" = ${spec.withUserId}))`);
  }
  return filters.length ? sql`WHERE ${sqlJoin(filters, sql` AND `)}` : EMPTY;
}

const NEEDS_YOU = sql`(COALESCE("readState" = 'unread' AND "latestStatus" = 'failed', 0) OR "pendingApproval") AS "needsYou"`;

/**
 * One row per visible session root over the trigger-kept `session_summaries`:
 * root filters, then one primary-key join for the viewer's triage row.
 */
export function sessionSummarySql(rules: SessionTreeRules, spec: SessionSummarySpec): SqlQuery {
  const root = sessionRootFilterSql(rules, spec.root);
  const read = spec.read
    ? readStateSql(rules, spec.read, {
        lastActivityAt: sql`r."lastActivityAt"`,
        openTasks: sql`r."openTaskCount"`,
        pendingApproval: sql`r."pendingApprovalCount"`,
        // The newest human event is newer than the Done mark.
        reopensDone: sql`r."lastHumanAt" > s."lastUpdatedAt"`,
      })
    : sql`NULL`;
  // Sessions where the user requested any chain task, from the requester index.
  const withUser = spec.withUserId
    ? sql`r.id IN (SELECT m."rootId" FROM agent_tasks t JOIN session_members m ON m."taskId" = t.id
        WHERE t."requestedByUserId" = ${spec.withUserId}) AS "withUser",`
    : EMPTY;
  return sql`WITH state AS (
      SELECT r.id AS root_id, r."createdAt" AS "rootCreatedAt", r."key", r.source, r."slackChannelId",
        r."chainCount", r."latestStatus", r."lastActivityAt", ${withUser}
        r."pendingApprovalCount" AS "pendingApproval", r."openTaskCount" AS "openTasks",
        ${read} AS "readState", s."snoozeUntil"
      FROM ${SESSION_ROOTS} r LEFT JOIN inbox_item_state s
        ON s."userId" = ${spec.viewerUserId} AND s."itemType" = 'to_read' AND s."itemId" = r.id
      WHERE ${root}
    ), summary AS (
      SELECT *, ${NEEDS_YOU}
      FROM state
    )
    SELECT a.* FROM summary a ${summaryRowFiltersSql(rules, spec)}`;
}

/**
 * The chain walk the summaries replace: a session starts at a parentTaskId IS
 * NULL root, and one recursive CTE computes chain-wide latest activity.
 */
export function legacySessionSummarySql(
  rules: SessionTreeRules,
  spec: SessionSummarySpec,
): SqlQuery {
  const root = sessionRootFilterSql(rules, spec.root);
  const read = spec.read ? readStateSql(rules, spec.read) : sql`NULL`;
  const openTask = sql`chain.status NOT IN (${literals(rules.terminalStatuses)})`;
  // Per chain row, over `chain` and the viewer's Done row `d`: whether the row
  // needs the user since they marked the session Done.
  const reopensDone = sql`(d.id IS NOT NULL AND (
        (chain."createdAt" > d."lastUpdatedAt"
          AND chain."requestedByUserId" IS NOT NULL
          AND chain."requestedByUserIdInherited" = 0
          AND COALESCE(chain.source, '') NOT IN (${literals(rules.agentTaskSources)}))
        OR EXISTS (SELECT 1 FROM task_steering_messages sm
          WHERE sm.task_id = chain.id AND sm.created_by_kind = 'user'
            AND sm.status != 'cancelled' AND sm.created_at > d."lastUpdatedAt")
        OR EXISTS (SELECT 1 FROM approval_requests ar
          WHERE ar."sourceTaskId" = chain.id AND ar.status = 'pending' AND ar."createdAt" > d."lastUpdatedAt")
      ))`;
  const withUser = spec.withUserId
    ? sql`SUM(chain."requestedByUserId" = ${spec.withUserId}) AS "withUser",`
    : EMPTY;
  // SQLite takes the bare status from the row with MAX(lastUpdatedAt).
  // Keep this as the only MIN/MAX aggregate so status follows activity.
  return sql`WITH RECURSIVE chain(root_id, id, "lastUpdatedAt", status, "requestedByUserId",
        "createdAt", source, "requestedByUserIdInherited") AS (
      SELECT r.id, r.id, r."lastUpdatedAt", r.status, r."requestedByUserId",
        r."createdAt", r.source, r."requestedByUserIdInherited"
      FROM agent_tasks r WHERE r."parentTaskId" IS NULL AND ${root}
      UNION ALL
      SELECT c.root_id, t.id, t."lastUpdatedAt", t.status, t."requestedByUserId",
        t."createdAt", t.source, t."requestedByUserIdInherited"
      FROM chain c JOIN agent_tasks t ON t."parentTaskId" = c.id
    ), agg AS (
      SELECT chain.root_id, COUNT(*) AS "chainCount",
        chain.status AS "latestStatus", MAX(chain."lastUpdatedAt") AS "lastActivityAt",
        ${withUser}
        SUM(EXISTS (SELECT 1 FROM approval_requests ar
          WHERE ar."sourceTaskId" = chain.id AND ar.status = 'pending')) AS "pendingApproval",
        SUM(${openTask}) AS "openTasks",
        SUM(${reopensDone}) AS "reopensDone"
      FROM chain LEFT JOIN inbox_item_state d
        ON d."userId" = ${spec.viewerUserId} AND d."itemType" = 'to_read' AND d."itemId" = chain.root_id AND d.status = 'done'
      GROUP BY chain.root_id
    ), state AS (
      SELECT a.*, ${read} AS "readState", s."snoozeUntil"
      FROM agg a CROSS JOIN agent_tasks r ON r.id = a.root_id LEFT JOIN inbox_item_state s
        ON s."userId" = ${spec.viewerUserId} AND s."itemType" = 'to_read' AND s."itemId" = a.root_id
    ), summary AS (
      SELECT *, ${NEEDS_YOU}
      FROM state
    )
    SELECT a.* FROM summary a ${summaryRowFiltersSql(rules, spec)}`;
}

export function sessionCountSql(
  rules: SessionTreeRules,
  spec: SessionSummarySpec,
  chain: boolean,
): SqlQuery {
  return chain
    ? sql`SELECT COUNT(*) AS count FROM (${sessionSummarySql(rules, spec)})`
    : sql`SELECT COUNT(*) AS count FROM ${SESSION_ROOTS} r WHERE ${sessionRootFilterSql(rules, spec.root)}`;
}

const THREAD_OPEN_AT = sql`instr(r.task, '<thread_context>' || char(10))`;
const THREAD_CLOSE_AT = sql`instr(r.task, char(10) || '</thread_context>')`;
/** `</thread_context>` plus its newline. */
const THREAD_CLOSE_SKIP = "</thread_context>".length + 1;

/** The prompt of `r` without its first thread context block, cut to `chars`. */
export function threadPromptSql(chars: number): SqlQuery {
  return sql`substr(CASE
    WHEN ${THREAD_OPEN_AT} > 0 AND ${THREAD_CLOSE_AT} > ${THREAD_OPEN_AT}
    THEN substr(r.task, 1, ${THREAD_OPEN_AT} - 1) || substr(r.task, ${THREAD_CLOSE_AT} + ${THREAD_CLOSE_SKIP})
    ELSE r.task END, 1, ${chars})`;
}
