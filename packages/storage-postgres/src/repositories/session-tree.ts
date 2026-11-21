/**
 * Postgres text of the session tree reads (`session_summaries` roots, the
 * legacy chain walk, read state, triage), written against the SQLite module
 * `packages/storage-sqlite/src/repositories/session-tree.ts`: same rows, same
 * order. Differences from the SQLite text:
 *
 * - GLOB patterns become LIKE patterns (`?` -> `_`, `*` -> `%`); LIKE is
 *   case-sensitive on Postgres, as GLOB is on SQLite.
 * - `instr` -> `strpos`, `char(10)` -> `chr(10)`, no unary `+` index hints.
 * - Integer booleans: a comparison SQLite sums or returns as 0/1 is cast to
 *   integer (a boolean result column comes back as 0/1 through the codec).
 * - `inbox_item_state."lastReadAt"` and `"snoozeUntil"` are text columns:
 *   they compare as text against ISO text, as SQLite compares them.
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

/** A timestamptz as the ISO text SQLite stores (`2026-11-21T10:00:00.000Z`). */
export const isoText = (column: SqlQuery): SqlQuery =>
  sql`to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

/** Code constants written as SQL string literals (as the queries always had them). */
function literals(values: readonly string[]): SqlQuery {
  for (const value of values) {
    if (!/^[a-z][a-z0-9_-]*$/.test(value)) throw new Error(`Not a plain literal: ${value}`);
  }
  return new SqlQuery([values.map((value) => `'${value}'`).join(",")], []);
}

/**
 * A SQLite GLOB pattern as a Postgres LIKE pattern with backslash escapes.
 * Only `?` and `*` are wildcards here: a character class has no LIKE form.
 */
export function globToLike(pattern: string): string {
  let out = "";
  for (const ch of pattern) {
    if (ch === "?") out += "_";
    else if (ch === "*") out += "%";
    else if (ch === "[") throw new Error(`GLOB character classes have no LIKE form: ${pattern}`);
    else if (ch === "%" || ch === "_" || ch === "\\") out += `\\${ch}`;
    else out += ch;
  }
  return out;
}

/** `value GLOB pattern` for a pattern chosen by code. */
const globMatch = (value: SqlQuery, pattern: string): SqlQuery =>
  sql`${value} LIKE ${globToLike(pattern)} ESCAPE '\\'`;

/** One row per session root: `session_summaries` with the root id as `id`. */
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
  return sql`(${ranges}) AND ${globMatch(leaf, "thread:?*/")}`;
}

/** Count every owned root at the exact source thread key, independent of viewer filters. */
export function threadRootsSql(rules: SessionTreeRules): SqlQuery {
  return sql`(CASE WHEN ${sourceThreadKeySql(rules)}
      THEN (SELECT COUNT(*) FROM session_summaries session_thread_root
        WHERE session_thread_root."key" = r."key" AND session_thread_root."requestedByUserId" IS NOT NULL)
      ELSE 0 END)`;
}

function groupSql(rules: SessionTreeRules, group: SessionGroupSpec): SqlQuery {
  const leaves = or(
    group.leafPatterns.map((pattern) =>
      globMatch(sql`substr(r."key", ${group.start}::integer)`, pattern),
    ),
  );
  // SQLite's substr takes a negative length as the characters before the
  // start; Postgres rejects it. The length is -1 only for the group key
  // itself, which the first branch already matches.
  return sql`(r."key" >= ${group.lo} AND r."key" < ${group.hi} AND (r."key" = ${group.lo} OR (
      strpos(substr(r."key", ${group.start}::integer, GREATEST(length(r."key") - ${group.start}::integer, 0)), '/') = 0 AND
      (${leaves}) AND
      ${threadRootsSql(rules)} < ${rules.nestedThreadMinRoots}
    )))`;
}

function noGroupSql(rules: SessionTreeRules, groups: readonly SessionGroupSpec[]): SqlQuery {
  return sql`(${or(groups.map((group) => groupSql(rules, group)))})`;
}

function inboxScopeSql(rules: SessionTreeRules, scope: SessionInboxScope): SqlQuery {
  const ranges = or(scope.ranges.map(({ lo, hi }) => sql`(r."key" >= ${lo} AND r."key" < ${hi})`));
  return sql`(${ranges} OR ${noGroupSql(rules, scope.noGroup)})`;
}

/** The effective source of the root `r`. */
function effectiveSourceSql(rules: SessionTreeRules): SqlQuery {
  const whens = sqlJoin(
    rules.sourceRanges.map(
      ({ source, lo, hi }) =>
        sql`WHEN r."key" >= ${lo} AND r."key" < ${hi} THEN CAST(${source} AS text)`,
    ),
    sql` `,
  );
  return sql`(CASE ${whens} ELSE r.source END)`;
}

function sharedWithSql(userId: string | null): SqlQuery {
  return sql`r.id IN (SELECT s."rootTaskId" FROM session_shares s
      WHERE s."revokedAt" IS NULL AND (s."userId" IS NULL OR s."userId" = ${userId}))`;
}

/** Roots (alias `r`) a viewer may open in a session list. */
export function sessionViewerSql(viewer: SessionViewerSpec): SqlQuery {
  if (viewer.scope === "all" && viewer.readAll) return sql`TRUE`;
  if (viewer.scope === "mine") return sql`r."requestedByUserId" = ${viewer.userId}`;
  if (viewer.scope === "shared") {
    return sql`(r."requestedByUserId" IS NOT NULL AND r."requestedByUserId" IS DISTINCT FROM CAST(${viewer.userId} AS text) AND ${sharedWithSql(viewer.userId)})`;
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
    conditions.push(spec.rootIds.length ? sql`r.id IN (${sqlList(spec.rootIds)})` : sql`FALSE`);
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
          : sql`FALSE`,
      ),
    );
  }
  if (spec.textLike !== undefined) {
    // SQLite's LIKE has no escape character and folds ASCII case; the pattern
    // and the lowered text hold no upper-case ASCII letter.
    conditions.push(sql`EXISTS (SELECT 1 FROM agent_tasks rt WHERE rt.id = r.id
        AND (lower(rt.task) LIKE ${spec.textLike} ESCAPE '' OR lower(COALESCE(rt.title, '')) LIKE ${spec.textLike} ESCAPE ''))`);
  }
  if (spec.requestedByUserId !== undefined) {
    conditions.push(sql`r."requestedByUserId" = ${spec.requestedByUserId}`);
  }
  if (spec.contextKeyPattern !== undefined) {
    // SQLite folds ASCII case in LIKE: ILIKE folds ASCII only under the C ctype.
    conditions.push(sql`r."contextKey" ILIKE ${spec.contextKeyPattern} ESCAPE '\\'`);
  }
  if (spec.viewer) {
    conditions.push(sessionViewerSql(spec.viewer));
    if (spec.tree) conditions.push(includeScheduled(sql`r."requestedByUserId" IS NOT NULL`));
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
    conditions.push(
      spec.marked.orInbox
        ? sql`(${marked} OR ${inboxScopeSql(rules, spec.marked.orInbox)})`
        : marked,
    );
  }
  return conditions.length ? sqlJoin(conditions, sql` AND `) : sql`TRUE`;
}

type ReadStateColumns = {
  lastActivityAt: SqlQuery;
  openTasks: SqlQuery;
  pendingApproval: SqlQuery;
  reopensDone: SqlQuery;
};

const LEGACY_READ_STATE_COLUMNS: ReadStateColumns = {
  lastActivityAt: sql`a."lastActivityAt"`,
  openTasks: sql`a."openTasks"`,
  pendingApproval: sql`a."pendingApproval"`,
  reopensDone: sql`a."reopensDone" > 0`,
};

/** The read-state rule (see the SQLite module). */
function readStateSql(
  rules: SessionTreeRules,
  read: SessionReadStateSpec,
  a: ReadStateColumns = LEGACY_READ_STATE_COLUMNS,
): SqlQuery {
  const quietBefore = sql`CAST(${read.quietBefore} AS timestamptz)`;
  const autoDone = sql`(${a.openTasks} = 0 AND ${a.pendingApproval} = 0 AND ${a.lastActivityAt} <= ${quietBefore} AND ${inboxScopeSql(rules, read.inbox)})`;
  // lastReadAt is a text column: SQLite compares the ISO texts.
  const readCursor = sql`COALESCE(s."lastReadAt", ${isoText(sql`s."lastUpdatedAt"`)})`;
  return sql`CASE
      WHEN s.id IS NULL THEN CASE
        WHEN ${a.lastActivityAt} > CAST(${read.unreadSince} AS timestamptz) THEN 'unread'
        WHEN ${autoDone} THEN 'done'
        ELSE 'read' END
      WHEN s.status = 'dismissed' THEN 'done'
      WHEN s.status = 'done' THEN CASE WHEN ${a.reopensDone} THEN 'unread' ELSE 'done' END
      WHEN s.status = 'snoozed' THEN CASE WHEN s."snoozeUntil" > CAST(${read.now} AS text) THEN 'later' ELSE 'unread' END
      WHEN ${isoText(a.lastActivityAt)} > ${readCursor} THEN 'unread'
      WHEN ${autoDone} AND s."lastUpdatedAt" <= ${quietBefore} THEN 'done'
      ELSE 'read'
    END`;
}

/** Filters on summary rows `a` (read state, latest status, participants), after aggregation. */
function summaryRowFiltersSql(rules: SessionTreeRules, spec: SessionSummarySpec): SqlQuery {
  const running = sql`"latestStatus" NOT IN (${literals(rules.terminalStatuses)})`;
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

/** SQLite: `COALESCE(unread AND failed, 0) OR pendingApproval`, an integer 0/1 (NULL stays NULL). */
const NEEDS_YOU = sql`CAST((COALESCE("readState" = 'unread' AND "latestStatus" = 'failed', FALSE) OR "pendingApproval" <> 0) AS integer) AS "needsYou"`;

/** One row per visible session root over the trigger-kept `session_summaries`. */
export function sessionSummarySql(rules: SessionTreeRules, spec: SessionSummarySpec): SqlQuery {
  const root = sessionRootFilterSql(rules, spec.root);
  const read = spec.read
    ? readStateSql(rules, spec.read, {
        lastActivityAt: sql`r."lastActivityAt"`,
        openTasks: sql`r."openTaskCount"`,
        pendingApproval: sql`r."pendingApprovalCount"`,
        reopensDone: sql`r."lastHumanAt" > s."lastUpdatedAt"`,
      })
    : sql`CAST(NULL AS text)`;
  const withUser = spec.withUserId
    ? sql`CAST(r.id IN (SELECT m."rootId" FROM agent_tasks t JOIN session_members m ON m."taskId" = t.id
        WHERE t."requestedByUserId" = ${spec.withUserId}) AS integer) AS "withUser",`
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

/** The chain walk the summaries replace (see the SQLite module). */
export function legacySessionSummarySql(
  rules: SessionTreeRules,
  spec: SessionSummarySpec,
): SqlQuery {
  const root = sessionRootFilterSql(rules, spec.root);
  const read = spec.read ? readStateSql(rules, spec.read) : sql`CAST(NULL AS text)`;
  const openTask = sql`CAST(chain.status NOT IN (${literals(rules.terminalStatuses)}) AS integer)`;
  const reopensDone = sql`CAST((d.id IS NOT NULL AND (
        (chain."createdAt" > d."lastUpdatedAt"
          AND chain."requestedByUserId" IS NOT NULL
          AND chain."requestedByUserIdInherited" = FALSE
          AND COALESCE(chain.source, '') NOT IN (${literals(rules.agentTaskSources)}))
        OR EXISTS (SELECT 1 FROM task_steering_messages sm
          WHERE sm.task_id = chain.id AND sm.created_by_kind = 'user'
            AND sm.status != 'cancelled' AND sm.created_at > d."lastUpdatedAt")
        OR EXISTS (SELECT 1 FROM approval_requests ar
          WHERE ar."sourceTaskId" = chain.id AND ar.status = 'pending' AND ar."createdAt" > d."lastUpdatedAt")
      )) AS integer)`;
  const withUser = spec.withUserId
    ? sql`SUM(CAST(chain."requestedByUserId" = ${spec.withUserId} AS integer)) AS "withUser",`
    : EMPTY;
  // SQLite takes the bare status from the row with MAX(lastUpdatedAt).
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
        (array_agg(chain.status ORDER BY chain."lastUpdatedAt" DESC))[1] AS "latestStatus",
        MAX(chain."lastUpdatedAt") AS "lastActivityAt",
        ${withUser}
        SUM(CASE WHEN EXISTS (SELECT 1 FROM approval_requests ar
          WHERE ar."sourceTaskId" = chain.id AND ar.status = 'pending') THEN 1 ELSE 0 END) AS "pendingApproval",
        SUM(${openTask}) AS "openTasks",
        SUM(${reopensDone}) AS "reopensDone"
      FROM chain LEFT JOIN inbox_item_state d
        ON d."userId" = ${spec.viewerUserId} AND d."itemType" = 'to_read' AND d."itemId" = chain.root_id AND d.status = 'done'
      GROUP BY chain.root_id
    ), state AS (
      SELECT a.*, ${read} AS "readState", s."snoozeUntil"
      FROM agg a JOIN agent_tasks r ON r.id = a.root_id LEFT JOIN inbox_item_state s
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
    ? sql`SELECT COUNT(*) AS count FROM (${sessionSummarySql(rules, spec)}) AS counted`
    : sql`SELECT COUNT(*) AS count FROM ${SESSION_ROOTS} r WHERE ${sessionRootFilterSql(rules, spec.root)}`;
}

const THREAD_OPEN_AT = sql`strpos(r.task, '<thread_context>' || chr(10))`;
const THREAD_CLOSE_AT = sql`strpos(r.task, chr(10) || '</thread_context>')`;
/** `</thread_context>` plus its newline. */
const THREAD_CLOSE_SKIP = "</thread_context>".length + 1;

/** The prompt of `r` without its first thread context block, cut to `chars`. */
export function threadPromptSql(chars: number): SqlQuery {
  return sql`substr(CASE
    WHEN ${THREAD_OPEN_AT} > 0 AND ${THREAD_CLOSE_AT} > ${THREAD_OPEN_AT}
    THEN substr(r.task, 1, ${THREAD_OPEN_AT} - 1) || substr(r.task, ${THREAD_CLOSE_AT} + ${THREAD_CLOSE_SKIP}::integer)
    ELSE r.task END, 1, ${chars}::integer)`;
}
