import {
  type AttributionReachRow,
  type AttributionRootRow,
  type AttributionWindow,
  BaseTasksRepository,
  buildTaskFtsMatch,
  HUMAN_FREE_TAGS,
  type HumanFreeClassifyInput,
  readableSessionSql,
  SqlQuery,
  sql,
  sqlList,
  sqlWhere,
  TASK_FTS_COMPLETE,
  TASK_PREVIEW_LENGTH,
  TASK_SIBLING_BLOCK,
  type TaskLineageRow,
  type TaskListFields,
  type TaskListFilters,
  type TaskListPage,
  type TaskListRow,
  type TaskRow,
  taskRunModelColumn,
} from "@desplega/storage";

/** Raw SQL text written by this file (never input). */
const raw = (text: string) => new SqlQuery([text], []);

/**
 * SQL column lists for the list projections. `task` is cut to the UTF-8 bytes
 * that can hold one char past the preview length (a UTF-16 unit is at most 4
 * bytes), so the JS side never materializes the full prompt, output or
 * provider blobs. The cut runs on the BLOB: SQLite's text `substr` stops at
 * the first embedded NUL, which the full-text preview keeps. A leading
 * sibling block and the `\n\n` after it are skipped; a block with no closing
 * tag stays.
 */
const TASK_PREVIEW_BYTES = 4 * (TASK_PREVIEW_LENGTH + 1);
const SIBLING_OPEN = TASK_SIBLING_BLOCK.open;
const SIBLING_CLOSE = TASK_SIBLING_BLOCK.close;
const TASK_BLOB = "CAST(agent_tasks.task AS BLOB)";
const SIBLING_CLOSE_AT = `instr(${TASK_BLOB}, CAST('${SIBLING_CLOSE}' AS BLOB))`;
const SIBLING_END = `(${SIBLING_CLOSE_AT} + ${SIBLING_CLOSE.length})`;
const TASK_PREVIEW_START = `CASE
    WHEN substr(${TASK_BLOB}, 1, ${SIBLING_OPEN.length}) = CAST('${SIBLING_OPEN}' AS BLOB)
      AND ${SIBLING_CLOSE_AT} > 0
    THEN ${SIBLING_END} + (substr(${TASK_BLOB}, ${SIBLING_END}, 2) = x'0a0a') * 2
    ELSE 1 END`;
const TASK_PREVIEW_SQL = `substr(${TASK_BLOB}, ${TASK_PREVIEW_START}, ${TASK_PREVIEW_BYTES}) AS task`;

const LIST_COLUMNS: Record<TaskListFields, string> = {
  full: "agent_tasks.*",
  slim: `agent_tasks.id, agent_tasks."key", agent_tasks."agentId", agent_tasks."creatorAgentId",
    ${TASK_PREVIEW_SQL}, agent_tasks.title, agent_tasks.status, agent_tasks.source,
    agent_tasks."taskType", agent_tasks.tags, agent_tasks.priority, agent_tasks."dependsOn",
    agent_tasks."offeredTo", agent_tasks."acceptedAt", agent_tasks."parentTaskId",
    agent_tasks."scheduleId", agent_tasks.model, agent_tasks."modelTier",
    agent_tasks."resolvedModel", agent_tasks."modelSource", agent_tasks."modelAlias", agent_tasks.effort,
    agent_tasks."resolvedEffort", agent_tasks.profile, agent_tasks."resolvedProfile",
    agent_tasks."modelGroup",
    agent_tasks.provider, agent_tasks."requestedByUserId", agent_tasks.progress,
    agent_tasks."createdAt", agent_tasks."lastUpdatedAt", agent_tasks."finishedAt",
    agent_tasks."statusKind", agent_tasks."peakContextPercent"`,
  timeline: `agent_tasks.id, agent_tasks."agentId", agent_tasks."parentTaskId", ${TASK_PREVIEW_SQL},
    agent_tasks.title, agent_tasks.status, agent_tasks."createdAt", agent_tasks."lastUpdatedAt",
    agent_tasks."finishedAt", agent_tasks."peakContextTokens"`,
};

const LINEAGE_COLUMNS = `${LIST_COLUMNS.slim}, agent_tasks."workflowRunId",
  (SELECT SUM("totalCostUsd") FROM session_costs WHERE session_costs."taskId" = agent_tasks.id) AS "totalCostUsd"`;

/** Parent hops the row-at-a-time readability walk takes before it falls back to the set form. */
const READABLE_WALK_MAX_DEPTH = 64;

// At or below this many candidate rows, a page reads them by rowid and sorts
// them. Above it, the page walks the lastUpdatedAt index and tests each row
// against the index instead: sorting thousands of hits means reading each
// row's record, and a long task body spills over many overflow pages.
const ROWID_SET_MAX = 500;

const HUMAN_FREE_TAG_SQL = HUMAN_FREE_TAGS.map(
  (tag) => `COALESCE(task.tags, '[]') LIKE '%"${tag}"%'`,
).join("\n        OR ");

/**
 * Non-propagated part of the human-free classification, over the alias `task`
 * (the row) and `parent` (a LEFT JOIN of `agent_tasks` on `task."parentTaskId"`).
 */
const HUMAN_FREE_BASE_SQL = `(
        COALESCE(task."taskType", '') IN ('heartbeat', 'heartbeat-checklist', 'boot-triage')
        OR ${HUMAN_FREE_TAG_SQL}
        OR (COALESCE(task.source, '') = 'schedule' AND task."requestedByUserId" IS NULL)
        OR (
          task."parentTaskId" IS NULL
          AND COALESCE(task.source, '') = 'workflow'
          AND task."requestedByUserId" IS NULL
          AND EXISTS (
            SELECT 1
            FROM workflow_runs run
            WHERE run.id = task."workflowRunId"
              AND run."triggerType" = 'schedule'
              AND run.created_by IS NULL
          )
        )
        OR (
          COALESCE(task.source, '') = 'system'
          AND parent.id IS NOT NULL
          AND parent."requestedByUserId" IS NULL
        )
      )`;

/** A task stays unattributed: no requester, or one copied from the parent. */
const UNATTRIBUTED_SQL =
  '(task."requestedByUserId" IS NULL OR task."requestedByUserIdInherited" = 1)';

/** The classification as 0/1; `parentFlag` is the parent's decided flag. */
function humanFreeCase(parentFlag: string): string {
  return `CASE
        WHEN ${HUMAN_FREE_BASE_SQL} THEN 1
        WHEN ${parentFlag} = 1 AND ${UNATTRIBUTED_SQL} THEN 1
        ELSE 0
      END`;
}

export class SqliteTasksRepository extends BaseTasksRepository {
  async listDeliveredSlackMessageTs(
    channelId: string,
    threadTs: string,
  ): Promise<(string | null)[]> {
    const rows = await this.db.query<{ ts: string | null }>(sql`
      SELECT "slackTriggerMessageTs" AS ts FROM agent_tasks
        WHERE "slackChannelId" = ${channelId} AND "slackThreadTs" = ${threadTs}
          AND "slackTriggerMessageTs" IS NOT NULL
      UNION
      SELECT CASE WHEN json_valid(l.metadata) THEN json_extract(l.metadata, '$.slackMessageTs') END AS ts
        FROM agent_log l
        JOIN agent_tasks t ON t.id = l."taskId"
        WHERE t."slackChannelId" = ${channelId} AND t."slackThreadTs" = ${threadTs}
          AND l."eventType" = 'task_steering' AND l."newValue" = 'slack_reaction'`);
    return rows.map((row) => row.ts);
  }

  protected insertionOrder(alias?: string): SqlQuery {
    return new SqlQuery([alias ? `${alias}.rowid` : "rowid"], []);
  }

  listSupersededWithUnsettledDependents(
    finishedBefore: string,
    finishedAfter: string,
    neverStartedStatuses: readonly string[],
  ): Promise<{ taskId: string; resumeTaskId: string }[]> {
    return this.db.query<{ taskId: string; resumeTaskId: string }>(sql`
      SELECT "taskId", "resumeTaskId" FROM (
        SELECT t.id AS "taskId", t."finishedAt" AS "finishedAt",
               (SELECT c.id FROM agent_tasks c
                  WHERE c."parentTaskId" = t.id AND c."taskType" = 'resume'
                  ORDER BY c."createdAt" DESC LIMIT 1) AS "resumeTaskId"
          FROM agent_tasks t
          WHERE t.status = 'superseded'
            AND t."finishedAt" < ${finishedBefore}
            AND t."finishedAt" > ${finishedAfter}
            AND EXISTS (
              SELECT 1 FROM agent_tasks d, json_each(d."dependsOn") AS j
               WHERE j.value = t.id AND d.status IN (${sqlList(neverStartedStatuses)})
            ))
      WHERE "resumeTaskId" IS NOT NULL
      ORDER BY "finishedAt" ASC`);
  }

  listTasksDispatchedFrom(taskIds: readonly string[]): Promise<TaskRow[]> {
    if (taskIds.length === 0) return Promise.resolve([]);
    const ids = JSON.stringify(taskIds);
    return this.db.query<TaskRow>(sql`
      SELECT t.*,
        (SELECT SUM("totalCostUsd") FROM session_costs WHERE session_costs."taskId" = t.id) AS "totalCostUsd"
      FROM agent_tasks t
      WHERE t."dispatchedByTaskId" IN (SELECT value FROM json_each(${ids}))
        AND t.id NOT IN (SELECT value FROM json_each(${ids}))
      ORDER BY t."createdAt", t.rowid`);
  }

  async countAgentDispatchesInThread(
    channelId: string,
    threadTs: string,
    creatorAgentId: string,
    since: string,
  ): Promise<number> {
    const row = await this.db.get<{ c: number }>(sql`
      SELECT COUNT(*) AS c FROM (
        SELECT MIN("createdAt") AS "firstAt" FROM agent_tasks
          WHERE "slackChannelId" = ${channelId}
          AND "slackThreadTs" = ${threadTs}
          AND "creatorAgentId" = ${creatorAgentId}
          AND source = 'mcp'
          AND ("createdAt" > ${since} OR "taskType" = 'script-run-step')
          GROUP BY CASE
            WHEN "taskType" = 'script-run-step' AND "contextKey" LIKE 'script-run:%:%'
              THEN substr("contextKey", 1, instr(substr("contextKey", 12), ':') + 10)
            ELSE id
          END
      ) WHERE "firstAt" > ${since}`);
    return Number(row?.c ?? 0);
  }

  /**
   * The row-at-a-time form of `readableSessionSql`, for a query that stops at
   * a LIMIT. It walks up from each row it tests to the root, so a page costs a
   * few key lookups per row instead of the set of every hidden task. A row
   * whose walk finds no root within READABLE_WALK_MAX_DEPTH hops (a very deep
   * chain, or a parent cycle written before migration 253) falls back to the
   * set form, which SQLite then builds once for the statement.
   */
  private readableSessionRowSql(userId: string | null): SqlQuery {
    const otherOwner = userId
      ? sql`up."requestedByUserId" IS NOT NULL AND up."requestedByUserId" != ${userId}`
      : sql`up."requestedByUserId" IS NOT NULL`;
    const shareMatch = userId
      ? sql`(s."userId" IS NULL OR s."userId" = ${userId})`
      : sql`s."userId" IS NULL`;
    const set = readableSessionSql(userId, sql`agent_tasks.id`);
    return sql`(CASE (
      WITH RECURSIVE up(id, "parentTaskId", "requestedByUserId", "scheduleId", depth) AS (
        SELECT u.id, u."parentTaskId", u."requestedByUserId", u."scheduleId", 0
        FROM agent_tasks u WHERE u.id = agent_tasks.id
        UNION ALL
        SELECT p.id, p."parentTaskId", p."requestedByUserId", p."scheduleId", up.depth + 1
        FROM up JOIN agent_tasks p ON p.id = up."parentTaskId"
        WHERE up.depth < ${raw(String(READABLE_WALK_MAX_DEPTH))}
      )
      SELECT CASE WHEN ${otherOwner} AND up."scheduleId" IS NULL
          AND NOT EXISTS (SELECT 1 FROM session_shares s
            WHERE s."rootTaskId" = up.id AND s."revokedAt" IS NULL AND ${shareMatch})
        THEN 1 ELSE 0 END
      FROM up
      WHERE up."parentTaskId" IS NULL
        OR NOT EXISTS (SELECT 1 FROM agent_tasks p WHERE p.id = up."parentTaskId")
      LIMIT 1
    ) WHEN 0 THEN 1 WHEN 1 THEN 0 ELSE ${set} END)`;
  }

  async listTasks<F extends TaskListFields>(
    filters: TaskListFilters,
    page: TaskListPage,
    fields: F,
  ): Promise<TaskListRow<F>[]> {
    const conditions = await this.taskFilterConditions(filters, "page");
    // Without selective filters, tiny LIMITs can make SQLite choose a full
    // scan and sort when ANALYZE statistics are absent. Keep filtered pages
    // planner-controlled so they can use their selective indexes.
    const pageIndex =
      conditions.length === 0 && !filters.readableBy && page.orderBy !== "createdAt"
        ? raw(" INDEXED BY idx_agent_tasks_last_updated")
        : raw("");
    if (!filters.includeHeartbeat) conditions.push(this.notHeartbeat());
    // The page stops at LIMIT, so test only the rows it reads.
    if (filters.readableBy) conditions.push(this.readableSessionRowSql(filters.readableBy.userId));
    // SQLite-only text, kept unquoted as written before the move: the page
    // query's ORDER BY is pinned by src/tests/db-tasks-read.test.ts.
    const orderColumns =
      page.orderBy === "createdAt"
        ? ["createdAt DESC", "rowid DESC"]
        : ["lastUpdatedAt DESC", "priority DESC"];
    // Page the rowids first, then read the projected columns and the cost
    // subquery for that page only, so no candidate row's prompt/output blobs
    // are materialized unless the row is on the page. The page query keeps the
    // exact ORDER BY: a `rowid` tiebreak there makes SQLite drop the
    // lastUpdatedAt index for a full scan. The outer sort adds it only to fix
    // the order of exact ties inside the page.
    const outerOrder = [...new Set([...orderColumns, "rowid DESC"])]
      .map((column) => `agent_tasks.${column}`)
      .join(", ");
    return this.db.query<TaskListRow<F>>(sql`WITH page AS (
      SELECT rowid AS rid FROM agent_tasks${pageIndex}${sqlWhere(conditions)}
      ORDER BY ${raw(orderColumns.join(", "))} LIMIT ${raw(String(page.limit))} OFFSET ${raw(String(page.offset))}
    )
    SELECT ${raw(LIST_COLUMNS[fields])},
    (SELECT SUM("totalCostUsd") FROM session_costs WHERE session_costs."taskId" = agent_tasks.id) AS "totalCostUsd"
    ${fields === "slim" ? taskRunModelColumn("rowid") : raw("")}
    FROM page JOIN agent_tasks ON agent_tasks.rowid = page.rid
    ORDER BY ${raw(outerOrder)}`);
  }

  /**
   * A token and phrase match on the task text and title through
   * agent_tasks_fts, or a prefix of the task id. Until the post-boot backfill
   * has indexed every row it is the old substring LIKE, so results never miss
   * rows the index has not reached yet. A page with few candidates reads them
   * by rowid; a page with many walks its ORDER BY index and tests membership
   * (`+rowid` keeps the planner off the rowid set), stopping at the page size.
   * A count always drives from the candidate set.
   */
  protected async taskSearchCondition(
    search: string,
    purpose: "page" | "count",
  ): Promise<SqlQuery> {
    const indexedThrough = await this.getTaskFtsIndexedThrough();
    if (indexedThrough === null || indexedThrough < TASK_FTS_COMPLETE) {
      const pattern = `%${search}%`;
      return sql`(task LIKE ${pattern} OR title LIKE ${pattern} OR id LIKE ${pattern})`;
    }

    const match = buildTaskFtsMatch(search);
    // Task ids are lowercase UUIDs; a prefix is a range on the primary key.
    const idLow = search.trim().toLowerCase();
    const idRange = idLow ? ([idLow, `${idLow}\uffff`] as const) : null;
    if (!match && !idRange) return sql`0`;

    const arms: SqlQuery[] = [];
    if (match) {
      arms.push(sql`SELECT rowid AS rid FROM agent_tasks_fts WHERE agent_tasks_fts MATCH ${match}`);
    }
    if (idRange) {
      arms.push(
        sql`SELECT rowid AS rid FROM agent_tasks WHERE id >= ${idRange[0]} AND id < ${idRange[1]}`,
      );
    }
    const union = arms.length === 2 ? sql`${arms[0]!} UNION ${arms[1]!}` : arms[0]!;
    const candidates = await this.db.query<{ rid: number }>(
      sql`${union} LIMIT ${raw(String(ROWID_SET_MAX + 1))}`,
    );
    if (candidates.length === 0) return sql`0`;
    if (candidates.length <= ROWID_SET_MAX) {
      return raw(`agent_tasks.rowid IN (${candidates.map((row) => Number(row.rid)).join(", ")})`);
    }

    const rowid = raw(purpose === "page" ? "+agent_tasks.rowid" : "agent_tasks.rowid");
    const terms: SqlQuery[] = [];
    if (match) {
      terms.push(
        sql`${rowid} IN (SELECT rowid FROM agent_tasks_fts WHERE agent_tasks_fts MATCH ${match})`,
      );
    }
    if (idRange) {
      terms.push(sql`(agent_tasks.id >= ${idRange[0]} AND agent_tasks.id < ${idRange[1]})`);
    }
    return terms.length === 2 ? sql`(${terms[0]!} OR ${terms[1]!})` : sql`(${terms[0]!})`;
  }

  listTaskDescendants(startId: string, maxDepth: number, limit: number): Promise<TaskLineageRow[]> {
    // LIMIT inside the recursive CTE stops the walk itself, not just the output.
    return this.db.query<TaskLineageRow>(sql`
      WITH RECURSIVE down(id, depth) AS (
          SELECT ${startId}, 0
          UNION ALL
          SELECT t.id, down.depth + 1 FROM down
          JOIN agent_tasks t ON t."parentTaskId" = down.id
          WHERE down.depth < ${maxDepth}
          ORDER BY 2
          LIMIT ${limit}
        )
        SELECT ${raw(LINEAGE_COLUMNS)} FROM down
        CROSS JOIN agent_tasks ON agent_tasks.id = down.id
        ORDER BY down.depth, agent_tasks."createdAt", agent_tasks.rowid`);
  }

  listTaskLineageRows(ids: readonly string[]): Promise<TaskLineageRow[]> {
    if (ids.length === 0) return Promise.resolve([]);
    return this.db.query<TaskLineageRow>(
      sql`SELECT ${raw(LINEAGE_COLUMNS)} FROM agent_tasks WHERE id IN (${sqlList(ids)})`,
    );
  }

  async getTaskFtsIndexedThrough(): Promise<number | null> {
    const state = await this.db.get<{ indexedThrough: number }>(
      sql`SELECT "indexedThrough" FROM agent_tasks_fts_state WHERE id = 1`,
    );
    return state ? state.indexedThrough : null;
  }

  async indexTaskFtsBatch(batchSize: number): Promise<{ changes: number; done: boolean }> {
    const indexedThrough = await this.getTaskFtsIndexedThrough();
    if (indexedThrough === null || indexedThrough >= TASK_FTS_COMPLETE) {
      return { changes: 0, done: true };
    }
    const last = await this.db.get<{ rid: number }>(sql`
      SELECT rowid AS rid FROM agent_tasks WHERE rowid > ${indexedThrough}
      ORDER BY rowid LIMIT 1 OFFSET ${batchSize - 1}`);
    const through = last?.rid ?? TASK_FTS_COMPLETE;
    const result = await this.db.run(sql`
      INSERT INTO agent_tasks_fts(rowid, task, title)
      SELECT rowid, task, title FROM agent_tasks WHERE rowid > ${indexedThrough} AND rowid <= ${through}`);
    await this.db.run(
      sql`UPDATE agent_tasks_fts_state SET "indexedThrough" = ${through} WHERE id = 1`,
    );
    return { changes: result.changes, done: through >= TASK_FTS_COMPLETE };
  }

  async mainDatabaseFile(): Promise<string | null> {
    const main = await this.db.get<{ file: string }>(
      sql`SELECT file FROM pragma_database_list WHERE name = 'main'`,
    );
    return main?.file ? main.file : null;
  }

  repointDependents(
    supersededId: string,
    resumeTaskId: string,
    statuses: readonly string[],
  ): Promise<{ id: string; agentId: string | null }[]> {
    // One statement: the new array is built from the row's current
    // `dependsOn`, so settlements of a shared dependent compose, and the
    // status predicate is evaluated at write time.
    return this.db.query<{ id: string; agentId: string | null }>(sql`
      UPDATE agent_tasks
          SET "dependsOn" = (
                SELECT json_group_array(value ORDER BY k) FROM (
                  SELECT CASE WHEN j.value = ${supersededId} THEN ${resumeTaskId} ELSE j.value END AS value,
                         MIN(j.key) AS k
                    FROM json_each(agent_tasks."dependsOn") AS j
                   GROUP BY 1)),
              "lastUpdatedAt" = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        WHERE status IN (${sqlList(statuses)})
          AND EXISTS (SELECT 1 FROM json_each(agent_tasks."dependsOn") WHERE value = ${supersededId})
        RETURNING id, "agentId"`);
  }

  async classifyHumanFree(input: HumanFreeClassifyInput): Promise<boolean> {
    const row = await this.db.get<{ humanFree: number }>(sql`
      WITH task("taskType", tags, source, "requestedByUserId", "requestedByUserIdInherited", "parentTaskId", "workflowRunId") AS (
          VALUES (${input.taskType}, ${input.tags}, ${input.source}, ${input.requestedByUserId},
            ${input.requestedByUserIdInherited ? 1 : 0}, ${input.parentTaskId}, ${input.workflowRunId})
        )
        SELECT ${raw(humanFreeCase('parent."isHumanFree"'))} AS "humanFree"
        FROM task
        LEFT JOIN agent_tasks parent ON parent.id = task."parentTaskId"`);
    return row?.humanFree === 1;
  }

  async enqueueHumanFreeWork(
    taskIds: readonly string[],
    scope: "self" | "children",
    hops: number,
  ): Promise<void> {
    if (taskIds.length === 0) return;
    // `WHERE true` keeps the parser from reading ON CONFLICT as a join clause.
    await this.db.run(sql`
      INSERT INTO human_free_reclassify_queue ("taskId", scope, "afterRowid", hops)
        SELECT value, ${scope}, 0, ${hops} FROM json_each(${JSON.stringify(taskIds)}) WHERE true
        ON CONFLICT ("taskId", scope) DO UPDATE SET
          "afterRowid" = 0,
          hops = MAX(hops, excluded.hops)`);
  }

  async humanFreeAffected(seedIds: readonly string[], limit: number): Promise<string[]> {
    // The recursive walk over task ids alone, like the rule itself, so it still
    // terminates on a parent cycle. LIMIT stops the recursion once the batch is full.
    const rows = await this.db.query<{ id: string }>(sql`
      WITH RECURSIVE affected(id) AS (
          SELECT value FROM json_each(${JSON.stringify(seedIds)})

          UNION

          SELECT task.id
          FROM affected
          JOIN agent_tasks task ON task."parentTaskId" = affected.id
          LIMIT ${limit}
        )
        SELECT id FROM affected`);
    return rows.map((row) => row.id);
  }

  async applyHumanFreeBatch(affected: readonly string[]): Promise<number> {
    // The "WITH RECURSIVE affected" prefix is what the tests count subtree
    // recomputations by. The unary plus in the recursive step keeps the planner
    // from probing `task` by id once per batch member for every free row; it
    // walks the `parentTaskId` index instead, and the IN only filters.
    const result = await this.db.run(sql`
      WITH RECURSIVE affected(id) AS (
          SELECT value FROM json_each(${JSON.stringify(affected)})
        ),
        free(id) AS (
          SELECT task.id
          FROM agent_tasks task
          LEFT JOIN agent_tasks parent ON parent.id = task."parentTaskId"
          WHERE task.id IN (SELECT id FROM affected)
            AND (
              ${raw(HUMAN_FREE_BASE_SQL)}
              OR (
                parent."isHumanFree" = 1
                AND parent.id NOT IN (SELECT id FROM affected)
                AND ${raw(UNATTRIBUTED_SQL)}
              )
            )

          UNION

          SELECT task.id
          FROM free
          JOIN agent_tasks task ON task."parentTaskId" = free.id
          WHERE +task.id IN (SELECT id FROM affected)
            AND ${raw(UNATTRIBUTED_SQL)}
        )
        UPDATE agent_tasks
        SET "isHumanFree" = CASE WHEN id IN (SELECT id FROM free) THEN 1 ELSE 0 END
        WHERE id IN (SELECT id FROM affected)
          AND "isHumanFree" != CASE WHEN id IN (SELECT id FROM free) THEN 1 ELSE 0 END`);
    return result.changes;
  }

  async humanFreeUnfinished(batch: readonly string[]): Promise<string[]> {
    // EXISTS stops at the first such child, so the cost tracks the batch, not the fan-out.
    const rows = await this.db.query<{ id: string }>(sql`
      WITH batch(id) AS (
          SELECT value FROM json_each(${JSON.stringify(batch)})
        )
        SELECT batch.id
        FROM batch
        WHERE EXISTS (
          SELECT 1
          FROM agent_tasks child
          WHERE child."parentTaskId" = batch.id
            AND child.id NOT IN (SELECT id FROM batch)
        )`);
    return rows.map((row) => row.id);
  }

  listChildPage(
    parentId: string,
    after: number,
    limit: number,
  ): Promise<{ id: string; position: number }[]> {
    // The parentTaskId index is ordered by rowid, so each page is an index range scan.
    return this.db.query<{ id: string; position: number }>(sql`
      SELECT id, rowid AS position
        FROM agent_tasks
        WHERE "parentTaskId" = ${parentId} AND rowid > ${after}
        ORDER BY rowid
        LIMIT ${limit}`);
  }

  findOpenChannelChecklistItem(
    scope: string,
    userId: string | null,
    adapter: string,
  ): Promise<{ id: string } | null> {
    return this.db.get<{ id: string }>(sql`
      SELECT id FROM checklist_items
      WHERE kind = 'channel' AND status = 'open' AND scope = ${scope} AND "userId" IS ${userId}
        AND CASE WHEN json_valid(meta) THEN json_extract(meta, '$.adapter') END = ${adapter}`);
  }

  listTaskAttachmentUrls(taskId: string): Promise<{ kind: string; url: string | null }[]> {
    return this.db.query<{ kind: string; url: string | null }>(sql`
      SELECT kind, url FROM task_attachments WHERE task_id = ${taskId} ORDER BY created_at, rowid`);
  }

  async releasePendingPoolTask(taskId: string, agentId: string, now: string): Promise<number> {
    // The statement head stays as written before the move: the
    // runtime-pool-routing test intercepts this write by its text.
    const result = await this.db.run(sql`
      ${raw("UPDATE agent_tasks SET agentId = NULL")}, status = 'unassigned', "lastUpdatedAt" = ${now}
      WHERE id = ${taskId} AND status = 'pending' AND "agentId" = ${agentId} AND pool_wake_at IS NULL
        AND COALESCE(routing_reason, '') != 'human_pinned'`);
    return result.changes;
  }

  listSupersededWaitMembers(): Promise<{ taskId: string; resumeTaskId: string }[]> {
    return this.db.query<{ taskId: string; resumeTaskId: string }>(sql`
      SELECT DISTINCT m."taskId", (
          SELECT r.id FROM agent_tasks r
          WHERE r."parentTaskId" = t.id AND r."taskType" = 'resume'
          ORDER BY r."createdAt", r.id LIMIT 1
        ) AS "resumeTaskId"
      FROM deferred_task_wait_members m
      JOIN deferred_task_waits w ON w."scheduleId" = m."scheduleId"
      JOIN agent_tasks t ON t.id = m."taskId"
      WHERE w.status = 'pending' AND t.status = 'superseded'
        AND "resumeTaskId" IS NOT NULL`);
  }

  async repointWaitMembers(taskId: string, resumeTaskId: string, now: string): Promise<void> {
    await this.db.run(sql`
      UPDATE OR REPLACE deferred_task_wait_members SET "taskId" = ${resumeTaskId}, updated_at = ${now}
      WHERE "taskId" = ${taskId} AND "scheduleId" IN (
        SELECT "scheduleId" FROM deferred_task_waits WHERE status = 'pending'
      )`);
  }

  listGeneratedUrlAttachments(
    taskId: string,
    capabilityKey: string,
    source: string,
  ): Promise<{ id: string; name: string; url: string }[]> {
    return this.db.query<{ id: string; name: string; url: string }>(sql`
      SELECT id, name, url FROM task_attachments
      WHERE task_id = ${taskId}
        AND kind = 'url'
        AND url IS NOT NULL
        AND json_extract(capabilities, ${`$.${capabilityKey}`}) = ${source}
      ORDER BY rowid`);
  }

  listRoutingWorkerStatuses(
    openStatuses: readonly string[],
  ): Promise<
    { agentId: string; status: string; activeTaskCount: number; openTaskCount: number }[]
  > {
    // MATERIALIZED pins the plan: a status seek over the few open tasks. Without
    // it (and with no sqlite_stat1) the planner flattens the CTE back into an OR
    // over agentId/offeredTo that reads each agent's whole task history.
    return this.db.query(sql`
      WITH open_task AS MATERIALIZED (
        SELECT id, "agentId", "offeredTo", status FROM agent_tasks
        WHERE status IN (${sqlList(openStatuses)})
      )
      SELECT agent.id AS "agentId", agent.status,
        COUNT(task.id) AS "openTaskCount",
        SUM(CASE WHEN task.status IN ('in_progress', 'reviewing') THEN 1 ELSE 0 END) AS "activeTaskCount"
      FROM agents agent
      LEFT JOIN open_task task ON task."agentId" = agent.id OR task."offeredTo" = agent.id
      WHERE agent."isLead" = 0
      GROUP BY agent.id, agent.status
      ORDER BY agent.id`);
  }

  listDependentTasks(parentId: string): Promise<TaskRow[]> {
    return this.db.query<TaskRow>(sql`
      SELECT t.* FROM agent_tasks t, json_each(t."dependsOn") AS dep
      WHERE dep.value = ${parentId}
      ORDER BY t.rowid`);
  }

  listStalledInProgressTasks(cutoff: string): Promise<TaskRow[]> {
    // The condition text stays as written before the move: the
    // heartbeat-checklist test intercepts this read by its text.
    return this.db.query<TaskRow>(sql`
      SELECT * FROM agent_tasks WHERE ${raw("status = 'in_progress' AND lastUpdatedAt < ")}${cutoff}
      ORDER BY "lastUpdatedAt" ASC, rowid ASC`);
  }

  async countTasksCreatedLastDay(): Promise<number> {
    const row = await this.db.get<{ count: number }>(sql`
      SELECT COUNT(*) AS count FROM agent_tasks
      WHERE "createdAt" >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-24 hours')`);
    return row?.count ?? 0;
  }

  listRootTaskChain(rootTaskId: string): Promise<TaskRow[]> {
    // `CROSS JOIN` keeps the chain as the outer loop: with a plain JOIN, SQLite
    // scanned all of agent_tasks to skip the sort.
    return this.db.query<TaskRow>(sql`
      WITH RECURSIVE chain(id) AS (
        SELECT id FROM agent_tasks WHERE id = ${rootTaskId}
        UNION ALL
        SELECT t.id FROM agent_tasks t
        JOIN chain c ON t."parentTaskId" = c.id
      )
      SELECT t.*,
        (SELECT SUM("totalCostUsd") FROM session_costs WHERE session_costs."taskId" = t.id) AS "totalCostUsd"
      FROM chain
      CROSS JOIN agent_tasks t ON t.id = chain.id
      ORDER BY t."createdAt", t.rowid`);
  }
  // ---- agent_tasks: reads and writes of callers outside the tasks module ----

  async repointTaskDependency(
    taskId: string,
    status: string,
    fromTaskId: string,
    dependsOnJson: string,
  ): Promise<boolean> {
    // Status + membership predicates make the re-point a no-op if the
    // dependent was claimed or re-pointed since it was read.
    const row = await this.db.get<{ id: string }>(sql`
      UPDATE agent_tasks
         SET "dependsOn" = ${dependsOnJson}, "lastUpdatedAt" = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       WHERE id = ${taskId} AND status = ${status}
         AND EXISTS (SELECT 1 FROM json_each(agent_tasks."dependsOn") WHERE value = ${fromTaskId})
       RETURNING id`);
    return row != null;
  }

  async findOpenHeartbeatChecklistTask(
    agentId: string,
    openStatuses: readonly string[],
  ): Promise<string | null> {
    // Unary + keeps agentId/taskType off their indexes, so the seek runs on
    // status over the few open tasks instead of every past checklist task.
    // The hint text stays unquoted: the query-audit plan test reverts it by text.
    const row = await this.db.get<{ id: string }>(sql`
      SELECT id FROM agent_tasks
       WHERE status IN (${sqlList(openStatuses)})
         AND ${raw("+agentId")} = ${agentId}
         AND ${raw("+taskType")} = 'heartbeat-checklist'
       LIMIT 1`);
    return row?.id ?? null;
  }

  async countInProgressAmong(taskIds: readonly string[]): Promise<number> {
    if (taskIds.length === 0) return 0;
    const row = await this.db.get<{ n: number }>(sql`
      SELECT count(*) AS n FROM agent_tasks
       WHERE status = 'in_progress' AND id IN (SELECT value FROM json_each(${JSON.stringify(taskIds)}))`);
    return row?.n ?? 0;
  }

  queueStallOldest(): Promise<{
    claimableCount: number;
    oldestTaskId: string | null;
    oldestClaimableAt: string | null;
  } | null> {
    return this.db.get(sql`
      WITH queued AS (
          SELECT
            t.id,
            t."dependsOn",
            COALESCE(
              (
                SELECT MAX(entry."createdAt")
                FROM agent_log entry
                WHERE entry."taskId" = t.id
                  AND entry."newValue" = t.status
                  AND entry."eventType" IN (
                    'task_created',
                    'task_status_change',
                    'task_released',
                    'task_accepted',
                    'task_rejected'
                  )
              ),
              t."createdAt"
            ) AS "queueEnteredAt"
          FROM agent_tasks t
          WHERE t.status IN ('pending', 'unassigned')
        ),
        claimable AS (
          SELECT
            queued.id,
            MAX(
              queued."queueEnteredAt",
              COALESCE(
                (
                  SELECT MAX(COALESCE(prerequisite."finishedAt", prerequisite."createdAt"))
                  FROM json_each(COALESCE(queued."dependsOn", '[]')) dep
                  JOIN agent_tasks prerequisite ON prerequisite.id = dep.value
                ),
                queued."queueEnteredAt"
              )
            ) AS "claimableAt"
          FROM queued
          WHERE NOT EXISTS (
              SELECT 1
              FROM json_each(COALESCE(queued."dependsOn", '[]')) dep
              LEFT JOIN agent_tasks prerequisite ON prerequisite.id = dep.value
              WHERE prerequisite.id IS NULL OR prerequisite.status != 'completed'
            )
        ),
        oldest AS (
          SELECT id, "claimableAt" FROM claimable ORDER BY "claimableAt" ASC LIMIT 1
        )
        SELECT
          (SELECT COUNT(*) FROM claimable) AS "claimableCount",
          (SELECT id FROM oldest) AS "oldestTaskId",
          (SELECT "claimableAt" FROM oldest) AS "oldestClaimableAt"`);
  }

  async listDependedOnTaskIds(terminalStatuses: readonly string[]): Promise<string[]> {
    const rows = await this.db.query<{ id: string }>(sql`
      SELECT DISTINCT dep.value AS id
        FROM agent_tasks t, json_each(t."dependsOn") AS dep
       WHERE t.status NOT IN (${sqlList(terminalStatuses)})
         AND t."dependsOn" IS NOT NULL AND t."dependsOn" != '[]'`);
    return rows.map((row) => row.id);
  }

  listAttributionRoots(
    window: AttributionWindow,
    githubHost: string,
  ): Promise<AttributionRootRow[]> {
    if (!/^[a-z0-9._:-]+$/.test(githubHost))
      throw new Error(`Invalid GitHub host for SQL: ${githubHost}`);
    return this.db.query<AttributionRootRow>(attributionRootsSqlite(window, githubHost));
  }

  listAttributionReach(window: AttributionWindow): Promise<AttributionReachRow[]> {
    return this.db.query<AttributionReachRow>(attributionReachSqlite(window));
  }

  shippingEvidenceSql(
    alias: string,
    host: string,
  ): { hasArtifact: SqlQuery; hasPullRequest: SqlQuery } {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(alias)) {
      throw new Error(`Invalid task SQL alias: ${alias}`);
    }
    if (!/^[a-z0-9._:-]+$/.test(host)) throw new Error(`Invalid GitHub host for SQL: ${host}`);
    const t = alias;
    const outputHasPullRequest = githubPullRequestExistsSql(`${t}.output`, host);
    const hasAnyAttachment = `EXISTS (
    SELECT 1 FROM task_attachments ta WHERE ta.task_id = ${t}.id
  )`;
    const hasPullRequestAttachment = `EXISTS (
    SELECT 1 FROM task_attachments ta
    WHERE ta.task_id = ${t}.id
      AND ta.kind = 'url'
      AND ${githubPullRequestExistsSql("ta.url", host)}
  )`;
    return {
      hasArtifact: raw(
        `CASE WHEN ${hasAnyAttachment} THEN 1 WHEN ${outputHasPullRequest} THEN 1 ELSE 0 END`,
      ),
      hasPullRequest: raw(
        `CASE WHEN ${hasPullRequestAttachment} THEN 1 WHEN ${outputHasPullRequest} THEN 1 ELSE 0 END`,
      ),
    };
  }
}

// ECMAScript whitespace plus prose wrappers that terminate URL-like tokens.
const githubTokenDelimiterCodePoints = [
  9, 10, 11, 12, 13, 160, 5760, 8192, 8193, 8194, 8195, 8196, 8197, 8198, 8199, 8200, 8201, 8202,
  8232, 8233, 8239, 8287, 12288, 65279, 40, 41, 91, 93, 123, 125, 60, 62, 34, 39, 96,
];

function githubTokenDelimitersSql(): string {
  return githubTokenDelimiterCodePoints.map((code, index) => `(${index + 1}, ${code})`).join(", ");
}

/**
 * Keep aggregate SQL matching aligned with extractGitHubPullRequestUrls()
 * (src/utils/github-pull-request). `value` is a column reference chosen by
 * code; `host` is a checked lower-case host. Both are inlined as text.
 */
function githubPullRequestExistsSql(value: string, host: string): string {
  return `EXISTS (
    WITH RECURSIVE
    token_delimiters(position, code_point) AS (
      VALUES ${githubTokenDelimitersSql()}
    ),
    normalized(value, position) AS (
      SELECT coalesce(${value}, ''), 0

      UNION ALL

      SELECT replace(value, char(code_point), ' '), normalized.position + 1
      FROM normalized
      JOIN token_delimiters ON token_delimiters.position = normalized.position + 1
    ),
    tokens(remaining, token) AS (
      SELECT trim(value) || ' ', NULL
      FROM normalized
      WHERE position = (SELECT max(position) FROM token_delimiters)

      UNION ALL

      SELECT
        ltrim(substr(remaining, instr(remaining, ' ') + 1)),
        substr(remaining, 1, instr(remaining, ' ') - 1)
      FROM tokens
      WHERE remaining <> ''
    ),
    github_paths(path) AS (
      SELECT CASE
        WHEN lower(token) GLOB 'https://${host}/*'
          THEN substr(token, length('https://${host}/') + 1)
        WHEN lower(token) GLOB 'http://${host}/*'
          THEN substr(token, length('http://${host}/') + 1)
        ELSE substr(token, length('${host}/') + 1)
      END
      FROM tokens
      WHERE lower(token) GLOB 'https://${host}/*'
         OR lower(token) GLOB 'http://${host}/*'
         OR lower(token) GLOB '${host}/*'
    ),
    github_segments(owner, repo, remainder) AS (
      SELECT
        substr(path, 1, instr(path, '/') - 1),
        substr(
          substr(path, instr(path, '/') + 1),
          1,
          instr(substr(path, instr(path, '/') + 1), '/') - 1
        ),
        substr(
          substr(path, instr(path, '/') + 1),
          instr(substr(path, instr(path, '/') + 1), '/') + 1
        )
      FROM github_paths
      WHERE instr(path, '/') > 1
        AND instr(substr(path, instr(path, '/') + 1), '/') > 1
    ),
    github_pull_numbers(remainder, position) AS (
      SELECT remainder, length('pull/') + 1
      FROM github_segments
      WHERE owner NOT GLOB '*[^A-Za-z0-9._-]*'
        AND repo NOT GLOB '*[^A-Za-z0-9._-]*'
        AND owner NOT IN ('.', '..')
        AND repo NOT IN ('.', '..')
        AND lower(remainder) GLOB 'pull/[0-9]*'

      UNION ALL

      SELECT remainder, position + 1
      FROM github_pull_numbers
      WHERE substr(remainder, position, 1) GLOB '[0-9]'
    )
    SELECT 1
    FROM github_pull_numbers
    WHERE substr(remainder, position, 1) NOT GLOB '[0-9]'
      AND (
        substr(remainder, position, 1) = ''
        OR substr(remainder, position, 1) IN ('/', '?', '#')
        OR trim(substr(remainder, position), ')]},.;:!') = ''
      )
    LIMIT 1
  )`;
}

// ---- attribution report (moved from src/be/db.ts; text unchanged) ----

function attributionWhereSqlite(window: AttributionWindow): { where: string; params: string[] } {
  const conditions: string[] = ["t.requestedByUserId IS NOT NULL"];
  const params: string[] = [];
  if (window.startDate !== undefined) {
    conditions.push("t.createdAt >= ?");
    params.push(window.startDate);
  }
  if (window.endBefore !== undefined) {
    conditions.push("t.createdAt < ?");
    params.push(window.endBefore);
  } else if (window.endAtOrBefore !== undefined) {
    conditions.push("t.createdAt <= ?");
    params.push(window.endAtOrBefore);
  }
  return { where: `WHERE ${conditions.join(" AND ")}`, params };
}

/** Text with `?` placeholders and its parameters, as a query. */
function withParams(text: string, params: string[]): SqlQuery {
  const strings = text.split("?");
  if (strings.length !== params.length + 1) throw new Error("attribution SQL: placeholder count");
  return new SqlQuery(strings, params);
}

export function attributionRootsSqlite(window: AttributionWindow, githubHost: string): SqlQuery {
  const { where, params } = attributionWhereSqlite(window);
  return withParams(
    `WITH RECURSIVE selected_roots(id, requestedByUserId, status) AS (
        SELECT t.id, t.requestedByUserId, t.status
        FROM agent_tasks t
        ${where} AND t.parentTaskId IS NULL AND t.isHumanFree = 0
      ),
      -- Ids only: carrying each descendant's \`output\` through the recursion copied
      -- every task's text into the queue. The output fallback below reads it by id.
      task_tree(rootId, taskId) AS (
        SELECT id, id
        FROM selected_roots

        UNION ALL

        SELECT tree.rootId, child.id
        FROM agent_tasks child
        JOIN task_tree tree ON child.parentTaskId = tree.taskId
      ),
      -- Every root with shippable evidence anywhere in its tree, computed ONCE for
      -- the whole window. The old form asked the same question with 3 CORRELATED
      -- EXISTS subqueries, which SQLite re-entered once per root: 2 of them scanned
      -- task_attachments whole and the third scanned the whole tree with two
      -- leading-wildcard LIKEs. That is the O(R x T) shape that took 60 s.
      --
      -- Two rules keep this fast and correct, and both are load-bearing:
      --   1. UNION, never UNION ALL. It makes rootId unique, so the LEFT JOIN below
      --      cannot duplicate a root and COUNT(*) stays exact.
      --   2. LEFT JOIN, never a correlated EXISTS against this CTE. The EXISTS form
      --      returns the same answer but SQLite re-enters the CTE per root:
      --      measured 4,189 ms for a 2-day window against 460 ms for 30 days.
      shipped_roots(rootId) AS (
        SELECT tree.rootId
        FROM task_tree tree
        JOIN task_attachments ta ON ta.task_id = tree.taskId
        WHERE ta.kind = 'page'
           OR (
             ta.kind = 'url'
             AND (
               ta.url LIKE '%${githubHost}/%/pull/%'
               OR ta.url LIKE '%/-/merge_requests/%'
             )
           )

        UNION

        SELECT tree.rootId
        FROM task_tree tree
        -- CROSS JOIN pins the order (tree outer, task by id). Left to itself the
        -- planner scans every task's output and probes the tree instead.
        CROSS JOIN agent_tasks described ON described.id = tree.taskId
        WHERE described.output LIKE '%${githubHost}/%/pull/%'
           OR described.output LIKE '%/-/merge_requests/%'
      )
      SELECT
        t.requestedByUserId as userId,
        COUNT(*) as initiated,
        SUM(CASE WHEN t.status = 'completed' AND s.rootId IS NOT NULL THEN 1 ELSE 0 END) as shipped
      FROM selected_roots t
      LEFT JOIN shipped_roots s ON s.rootId = t.id
      GROUP BY t.requestedByUserId`,
    params,
  );
}

export function attributionReachSqlite(window: AttributionWindow): SqlQuery {
  const { where, params } = attributionWhereSqlite(window);
  return withParams(
    `SELECT
        t.requestedByUserId as userId,
        COUNT(DISTINCT t.agentId) as agentsReached,
        COUNT(DISTINCT t.vcsRepo) as reposReached,
        COUNT(DISTINCT t.source) as surfacesReached
      FROM agent_tasks t
      ${where} AND t.isHumanFree = 0
      GROUP BY t.requestedByUserId`,
    params,
  );
}
