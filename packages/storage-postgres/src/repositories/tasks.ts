import {
  BaseTasksRepository,
  HUMAN_FREE_TAGS,
  type HumanFreeClassifyInput,
  jsonText,
  likeAsciiCi,
  nowIso,
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
  type TaskRow,
} from "@desplega/storage";
import { notOnPostgresYet } from "./not-yet";

/** Raw SQL text written by this file (never input). */
const raw = (text: string) => new SqlQuery([text], []);

/**
 * The list projections. `task` is the same UTF-8 byte cut as on SQLite (a
 * `bytea`, read as a `Uint8Array`): the bytes that can hold one char past the
 * preview length, after a leading sibling block and the `\n\n` after it. A
 * block with no closing tag stays. Postgres text holds no NUL byte, so the
 * text-to-bytes conversion loses nothing.
 */
const TASK_PREVIEW_BYTES = 4 * (TASK_PREVIEW_LENGTH + 1);
const SIBLING_OPEN = TASK_SIBLING_BLOCK.open;
const SIBLING_CLOSE = TASK_SIBLING_BLOCK.close;
const TASK_BYTES = "convert_to(agent_tasks.task, 'UTF8')";
const SIBLING_CLOSE_AT = `position(convert_to('${SIBLING_CLOSE}', 'UTF8') in ${TASK_BYTES})`;
const SIBLING_END = `(${SIBLING_CLOSE_AT} + ${SIBLING_CLOSE.length})`;
const TASK_PREVIEW_START = `CASE
    WHEN substring(${TASK_BYTES} from 1 for ${SIBLING_OPEN.length}) = convert_to('${SIBLING_OPEN}', 'UTF8')
      AND ${SIBLING_CLOSE_AT} > 0
    THEN ${SIBLING_END}
      + CASE WHEN substring(${TASK_BYTES} from ${SIBLING_END} for 2) = '\\x0a0a'::bytea THEN 2 ELSE 0 END
    ELSE 1 END`;
const TASK_PREVIEW_SQL = `substring(${TASK_BYTES} from ${TASK_PREVIEW_START} for ${TASK_PREVIEW_BYTES}) AS task`;

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

const TOTAL_COST_SQL = `(SELECT SUM("totalCostUsd") FROM session_costs WHERE session_costs."taskId" = agent_tasks.id) AS "totalCostUsd"`;

const LINEAGE_COLUMNS = `${LIST_COLUMNS.slim}, agent_tasks."workflowRunId", ${TOTAL_COST_SQL}`;

/** The text elements of a jsonb array; no rows for NULL or a non-array value. */
function jsonArrayElements(value: SqlQuery): SqlQuery {
  return sql`jsonb_array_elements_text(CASE WHEN jsonb_typeof(${value}) = 'array' THEN ${value} END)`;
}

/** The elements of a bound id list, as `(value)` rows. */
function idRows(ids: readonly string[]): SqlQuery {
  return sql`jsonb_array_elements_text(${jsonText(JSON.stringify(ids))}) AS j(value)`;
}

/**
 * The FTS5 query `"<search>"*` as a tsquery: the search's letter/digit runs as
 * a phrase, the last one a prefix. ASCII letters fold to lowercase, as the
 * C-ctype `to_tsvector('simple', ...)` does.
 */
function taskTsQuery(search: string): string | null {
  const tokens = search.match(/[\p{L}\p{N}]+/gu);
  if (!tokens) return null;
  return `${tokens.map((t) => `'${t.replace(/[A-Z]+/g, (s) => s.toLowerCase())}'`).join(" <-> ")}:*`;
}

const TASK_TSVECTOR = sql`to_tsvector('simple', agent_tasks.task || ' ' || COALESCE(agent_tasks.title, ''))`;

const HUMAN_FREE_TAG_SQL = HUMAN_FREE_TAGS.map(
  (tag) => `COALESCE(CAST(task.tags AS text), '[]') ILIKE '%"${tag}"%' ESCAPE ''`,
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
  '(task."requestedByUserId" IS NULL OR task."requestedByUserIdInherited" = true)';

export class PostgresTasksRepository extends BaseTasksRepository {
  async listDeliveredSlackMessageTs(
    channelId: string,
    threadTs: string,
  ): Promise<(string | null)[]> {
    const rows = await this.db.query<{ ts: string | null }>(sql`
      SELECT "slackTriggerMessageTs" AS ts FROM agent_tasks
        WHERE "slackChannelId" = ${channelId} AND "slackThreadTs" = ${threadTs}
          AND "slackTriggerMessageTs" IS NOT NULL
      UNION
      SELECT CASE WHEN l.metadata IS JSON THEN CAST(l.metadata AS jsonb) ->> 'slackMessageTs' END AS ts
        FROM agent_log l
        JOIN agent_tasks t ON t.id = l."taskId"
        WHERE t."slackChannelId" = ${channelId} AND t."slackThreadTs" = ${threadTs}
          AND l."eventType" = 'task_steering' AND l."newValue" = 'slack_reaction'`);
    return rows.map((row) => row.ts);
  }

  protected insertionOrder(alias?: string): SqlQuery {
    return raw(alias ? `${alias}."_rowid"` : `"_rowid"`);
  }

  listSupersededWithUnsettledDependents(
    finishedBefore: string,
    finishedAfter: string,
    neverStartedStatuses: readonly string[],
  ): Promise<{ taskId: string; resumeTaskId: string }[]> {
    return this.db.query<{ taskId: string; resumeTaskId: string }>(sql`
      SELECT "taskId", "resumeTaskId" FROM (
        SELECT t.id AS "taskId", t."finishedAt" AS "finishedAt", t."_rowid" AS rid,
               (SELECT c.id FROM agent_tasks c
                  WHERE c."parentTaskId" = t.id AND c."taskType" = 'resume'
                  ORDER BY c."createdAt" DESC, c."_rowid" DESC LIMIT 1) AS "resumeTaskId"
          FROM agent_tasks t
          WHERE t.status = 'superseded'
            AND t."finishedAt" < ${finishedBefore}
            AND t."finishedAt" > ${finishedAfter}
            AND EXISTS (
              SELECT 1 FROM agent_tasks d, ${jsonArrayElements(sql`d."dependsOn"`)} AS j(value)
               WHERE j.value = t.id AND d.status IN (${sqlList(neverStartedStatuses)})
            )) AS s
      WHERE "resumeTaskId" IS NOT NULL
      ORDER BY "finishedAt" ASC, rid ASC`);
  }

  listTasksDispatchedFrom(taskIds: readonly string[]): Promise<TaskRow[]> {
    if (taskIds.length === 0) return Promise.resolve([]);
    return this.db.query<TaskRow>(sql`
      SELECT t.*,
        (SELECT SUM("totalCostUsd") FROM session_costs WHERE session_costs."taskId" = t.id) AS "totalCostUsd"
      FROM agent_tasks t
      WHERE t."dispatchedByTaskId" IN (SELECT value FROM ${idRows(taskIds)})
        AND t.id NOT IN (SELECT value FROM ${idRows(taskIds)})
      ORDER BY t."createdAt", t."_rowid"`);
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
            WHEN "taskType" = 'script-run-step' AND ${likeAsciiCi(sql`"contextKey"`, sql`'script-run:%:%'`)}
              THEN substr("contextKey", 1, strpos(substr("contextKey", 12), ':') + 10)
            ELSE id
          END
      ) AS dispatches WHERE "firstAt" > ${since}`);
    return Number(row?.c ?? 0);
  }

  async listTasks(
    filters: TaskListFilters,
    page: TaskListPage,
    fields: TaskListFields,
  ): Promise<Record<string, unknown>[]> {
    const conditions = await this.taskFilterConditions(filters, "page");
    if (!filters.includeHeartbeat) conditions.push(this.notHeartbeat());
    if (filters.readableBy) {
      conditions.push(readableSessionSql(filters.readableBy.userId, sql`agent_tasks.id`));
    }
    // The insertion-order tiebreak is in the page query too, so the page holds
    // the same rows the outer sort orders.
    const order =
      page.orderBy === "createdAt"
        ? `agent_tasks."createdAt" DESC, agent_tasks."_rowid" DESC`
        : `agent_tasks."lastUpdatedAt" DESC, agent_tasks.priority DESC, agent_tasks."_rowid" DESC`;
    return this.db.query<Record<string, unknown>>(sql`WITH page AS (
      SELECT agent_tasks."_rowid" AS rid FROM agent_tasks${sqlWhere(conditions)}
      ORDER BY ${raw(order)} LIMIT ${raw(String(page.limit))} OFFSET ${raw(String(page.offset))}
    )
    SELECT ${raw(LIST_COLUMNS[fields])}, ${raw(TOTAL_COST_SQL)}
    FROM page JOIN agent_tasks ON agent_tasks."_rowid" = page.rid
    ORDER BY ${raw(order)}`);
  }

  /**
   * A phrase-prefix match on the task text and title, or a prefix of the task
   * id. Until the backfill mark is complete it is the old substring LIKE, as on
   * SQLite. The match reads `agent_tasks` directly (no index yet: milestone M4).
   */
  protected async taskSearchCondition(
    search: string,
    _purpose: "page" | "count",
  ): Promise<SqlQuery> {
    const indexedThrough = await this.getTaskFtsIndexedThrough();
    if (indexedThrough === null || indexedThrough < TASK_FTS_COMPLETE) {
      const pattern = sql`${`%${search}%`}`;
      return sql`(${likeAsciiCi(sql`agent_tasks.task`, pattern)} OR ${likeAsciiCi(sql`agent_tasks.title`, pattern)} OR ${likeAsciiCi(sql`agent_tasks.id`, pattern)})`;
    }
    const query = taskTsQuery(search);
    const idLow = search.trim().toLowerCase();
    const terms: SqlQuery[] = [];
    if (query) terms.push(sql`${TASK_TSVECTOR} @@ to_tsquery('simple', ${query})`);
    if (idLow) {
      terms.push(sql`(agent_tasks.id >= ${idLow} AND agent_tasks.id < ${`${idLow}\uffff`})`);
    }
    if (terms.length === 0) return sql`false`;
    return terms.length === 2 ? sql`(${terms[0]!} OR ${terms[1]!})` : sql`(${terms[0]!})`;
  }

  listTaskDescendants(startId: string, maxDepth: number, limit: number): Promise<TaskLineageRow[]> {
    // Postgres has no LIMIT in a recursive term; the walk is bounded by maxDepth
    // and the page takes the first `limit` rows breadth first.
    return this.db.query<TaskLineageRow>(sql`
      WITH RECURSIVE down(id, depth) AS (
          SELECT CAST(${startId} AS text), 0
          UNION ALL
          SELECT t.id, down.depth + 1 FROM down
          JOIN agent_tasks t ON t."parentTaskId" = down.id
          WHERE down.depth < ${maxDepth}
        )
        SELECT ${raw(LINEAGE_COLUMNS)} FROM down
        CROSS JOIN agent_tasks
        WHERE agent_tasks.id = down.id
        ORDER BY down.depth, agent_tasks."createdAt", agent_tasks."_rowid"
        LIMIT ${limit}`);
  }

  listTaskLineageRows(ids: readonly string[]): Promise<TaskLineageRow[]> {
    if (ids.length === 0) return Promise.resolve([]);
    return this.db.query<TaskLineageRow>(
      sql`SELECT ${raw(LINEAGE_COLUMNS)} FROM agent_tasks WHERE id IN (${sqlList(ids)}) ORDER BY id`,
    );
  }

  async getTaskFtsIndexedThrough(): Promise<number | null> {
    const state = await this.db.get<{ indexedThrough: number }>(
      sql`SELECT "indexedThrough" FROM agent_tasks_fts_state WHERE id = 1`,
    );
    return state ? state.indexedThrough : null;
  }

  /**
   * Advances the backfill mark by `batchSize` rows in insertion order. The
   * Postgres match reads `agent_tasks` itself, so there is no index row to write.
   */
  async indexTaskFtsBatch(batchSize: number): Promise<{ changes: number; done: boolean }> {
    const indexedThrough = await this.getTaskFtsIndexedThrough();
    if (indexedThrough === null || indexedThrough >= TASK_FTS_COMPLETE) {
      return { changes: 0, done: true };
    }
    const last = await this.db.get<{ rid: number }>(sql`
      SELECT "_rowid" AS rid FROM agent_tasks WHERE "_rowid" > ${indexedThrough}
      ORDER BY "_rowid" LIMIT 1 OFFSET ${batchSize - 1}`);
    const through = last?.rid ?? TASK_FTS_COMPLETE;
    const counted = await this.db.get<{ n: number }>(sql`
      SELECT COUNT(*) AS n FROM agent_tasks WHERE "_rowid" > ${indexedThrough} AND "_rowid" <= ${through}`);
    await this.db.run(
      sql`UPDATE agent_tasks_fts_state SET "indexedThrough" = ${through} WHERE id = 1`,
    );
    return { changes: Number(counted?.n ?? 0), done: through >= TASK_FTS_COMPLETE };
  }

  /** No database file: the backfill's WAL-size throttle reads 0. */
  mainDatabaseFile(): Promise<string | null> {
    return Promise.resolve(null);
  }

  async repointDependents(
    supersededId: string,
    resumeTaskId: string,
    statuses: readonly string[],
  ): Promise<{ id: string; agentId: string | null }[]> {
    // One statement, as on SQLite; RETURNING has no order on Postgres, so the
    // rows come back in insertion order (SQLite's update order).
    const rows = await this.db.query<{ id: string; agentId: string | null; rid: number }>(sql`
      WITH updated AS (
        UPDATE agent_tasks
            SET "dependsOn" = (
                  SELECT jsonb_agg(value ORDER BY k) FROM (
                    SELECT CASE WHEN j.value = ${supersededId} THEN CAST(${resumeTaskId} AS text) ELSE j.value END AS value,
                           MIN(j.k) AS k
                      FROM jsonb_array_elements_text(agent_tasks."dependsOn") WITH ORDINALITY AS j(value, k)
                     GROUP BY 1) AS deps),
                "lastUpdatedAt" = ${nowIso}
          WHERE status IN (${sqlList(statuses)})
            AND EXISTS (SELECT 1 FROM ${jsonArrayElements(sql`agent_tasks."dependsOn"`)} AS d(value)
                         WHERE d.value = ${supersededId})
          RETURNING id, "agentId", "_rowid" AS rid)
      SELECT id, "agentId", rid FROM updated ORDER BY rid`);
    return rows.map(({ id, agentId }) => ({ id, agentId }));
  }

  async classifyHumanFree(input: HumanFreeClassifyInput): Promise<boolean> {
    const row = await this.db.get<{ humanFree: number }>(sql`
      WITH task("taskType", tags, source, "requestedByUserId", "requestedByUserIdInherited", "parentTaskId", "workflowRunId") AS (
          VALUES (CAST(${input.taskType} AS text), CAST(${input.tags} AS text), CAST(${input.source} AS text),
            CAST(${input.requestedByUserId} AS text), ${input.requestedByUserIdInherited},
            CAST(${input.parentTaskId} AS text), CAST(${input.workflowRunId} AS text))
        )
        SELECT CASE
            WHEN ${raw(HUMAN_FREE_BASE_SQL)} THEN 1
            WHEN parent."isHumanFree" = true AND ${raw(UNATTRIBUTED_SQL)} THEN 1
            ELSE 0
          END AS "humanFree"
        FROM task
        LEFT JOIN agent_tasks parent ON parent.id = task."parentTaskId"`);
    return Number(row?.humanFree) === 1;
  }

  async enqueueHumanFreeWork(
    taskIds: readonly string[],
    scope: "self" | "children",
    hops: number,
  ): Promise<void> {
    if (taskIds.length === 0) return;
    // One row per id, in first-occurrence order (the queue's seq order on
    // SQLite); Postgres refuses to update one row twice in one statement.
    await this.db.run(sql`
      INSERT INTO human_free_reclassify_queue ("taskId", scope, "afterRowid", hops)
        SELECT value, CAST(${scope} AS text), 0, CAST(${hops} AS bigint) FROM (
          SELECT value, MIN(k) AS k
            FROM jsonb_array_elements_text(${jsonText(JSON.stringify(taskIds))}) WITH ORDINALITY AS j(value, k)
           GROUP BY value) AS ids
        ORDER BY k
        ON CONFLICT ("taskId", scope) DO UPDATE SET
          "afterRowid" = 0,
          hops = GREATEST(human_free_reclassify_queue.hops, excluded.hops)`);
  }

  async humanFreeAffected(seedIds: readonly string[], limit: number): Promise<string[]> {
    // SQLite's recursive UNION is a queue: seeds first, then the children of
    // each queued id in insertion order, skipping ids already taken (so a parent
    // cycle terminates), stopping at `limit`. Postgres orders a recursive
    // step's rows by its plan, so the walk runs one level per statement.
    const seen = new Set<string>();
    const out: string[] = [];
    const take = (id: string) => {
      if (out.length >= limit || seen.has(id)) return;
      seen.add(id);
      out.push(id);
    };
    for (const id of seedIds) take(id);
    let frontier = out.slice();
    while (frontier.length > 0 && out.length < limit) {
      const rows = await this.db.query<{ id: string }>(sql`
        SELECT task.id
          FROM jsonb_array_elements_text(${jsonText(JSON.stringify(frontier))}) WITH ORDINALITY AS f(id, k)
          JOIN agent_tasks task ON task."parentTaskId" = f.id
         ORDER BY f.k, task."_rowid"
         LIMIT ${limit - out.length + seen.size}`);
      const before = out.length;
      for (const row of rows) take(row.id);
      frontier = out.slice(before);
    }
    return out;
  }

  async applyHumanFreeBatch(affected: readonly string[]): Promise<number> {
    const result = await this.db.run(sql`
      WITH RECURSIVE affected(id) AS (
          SELECT value FROM ${idRows(affected)}
        ),
        free(id) AS (
          SELECT task.id
          FROM agent_tasks task
          LEFT JOIN agent_tasks parent ON parent.id = task."parentTaskId"
          WHERE task.id IN (SELECT id FROM affected)
            AND (
              ${raw(HUMAN_FREE_BASE_SQL)}
              OR (
                parent."isHumanFree" = true
                AND parent.id NOT IN (SELECT id FROM affected)
                AND ${raw(UNATTRIBUTED_SQL)}
              )
            )

          UNION

          SELECT task.id
          FROM free
          JOIN agent_tasks task ON task."parentTaskId" = free.id
          WHERE task.id IN (SELECT id FROM affected)
            AND ${raw(UNATTRIBUTED_SQL)}
        )
        UPDATE agent_tasks
        SET "isHumanFree" = (id IN (SELECT id FROM free))
        WHERE id IN (SELECT id FROM affected)
          AND "isHumanFree" IS DISTINCT FROM (id IN (SELECT id FROM free))`);
    return result.changes;
  }

  async humanFreeUnfinished(batch: readonly string[]): Promise<string[]> {
    const rows = await this.db.query<{ id: string }>(sql`
      WITH batch(id) AS (
          SELECT value FROM ${idRows(batch)}
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
    return this.db.query<{ id: string; position: number }>(sql`
      SELECT id, "_rowid" AS position
        FROM agent_tasks
        WHERE "parentTaskId" = ${parentId} AND "_rowid" > ${after}
        ORDER BY "_rowid"
        LIMIT ${limit}`);
  }

  findOpenChannelChecklistItem(
    scope: string,
    userId: string | null,
    adapter: string,
  ): Promise<{ id: string } | null> {
    return this.db.get<{ id: string }>(sql`
      SELECT id FROM checklist_items
      WHERE kind = 'channel' AND status = 'open' AND scope = ${scope}
        AND "userId" IS NOT DISTINCT FROM CAST(${userId} AS text)
        AND CASE WHEN meta IS JSON THEN CAST(meta AS jsonb) ->> 'adapter' END = ${adapter}
      ORDER BY "_rowid" LIMIT 1`);
  }

  listTaskAttachmentUrls(taskId: string): Promise<{ kind: string; url: string | null }[]> {
    return this.db.query<{ kind: string; url: string | null }>(sql`
      SELECT kind, url FROM task_attachments WHERE task_id = ${taskId} ORDER BY created_at, "_rowid"`);
  }

  async releasePendingPoolTask(taskId: string, agentId: string, now: string): Promise<number> {
    const result = await this.db.run(sql`
      UPDATE agent_tasks SET "agentId" = NULL, status = 'unassigned', "lastUpdatedAt" = ${now}
      WHERE id = ${taskId} AND status = 'pending' AND "agentId" = ${agentId} AND pool_wake_at IS NULL
        AND COALESCE(routing_reason, '') != 'human_pinned'`);
    return result.changes;
  }

  listSupersededWaitMembers(): Promise<{ taskId: string; resumeTaskId: string }[]> {
    return this.db.query<{ taskId: string; resumeTaskId: string }>(sql`
      SELECT DISTINCT "taskId", "resumeTaskId" FROM (
        SELECT m."taskId", (
            SELECT r.id FROM agent_tasks r
            WHERE r."parentTaskId" = t.id AND r."taskType" = 'resume'
            ORDER BY r."createdAt", r.id LIMIT 1
          ) AS "resumeTaskId"
        FROM deferred_task_wait_members m
        JOIN deferred_task_waits w ON w."scheduleId" = m."scheduleId"
        JOIN agent_tasks t ON t.id = m."taskId"
        WHERE w.status = 'pending' AND t.status = 'superseded') AS members
      WHERE "resumeTaskId" IS NOT NULL
      ORDER BY "taskId", "resumeTaskId"`);
  }

  async repointWaitMembers(taskId: string, resumeTaskId: string, now: string): Promise<void> {
    // SQLite's UPDATE OR REPLACE: a member row the re-point would collide with
    // (same schedule, already the resume task) goes first, then the update.
    await this.db.transaction(async () => {
      await this.db.run(sql`
        DELETE FROM deferred_task_wait_members
        WHERE "taskId" = ${resumeTaskId} AND "taskId" != ${taskId}
          AND "scheduleId" IN (
            SELECT "scheduleId" FROM deferred_task_wait_members WHERE "taskId" = ${taskId})
          AND "scheduleId" IN (
            SELECT "scheduleId" FROM deferred_task_waits WHERE status = 'pending')`);
      await this.db.run(sql`
        UPDATE deferred_task_wait_members SET "taskId" = ${resumeTaskId}, updated_at = ${now}
        WHERE "taskId" = ${taskId} AND "scheduleId" IN (
          SELECT "scheduleId" FROM deferred_task_waits WHERE status = 'pending'
        )`);
    });
  }

  listGeneratedUrlAttachments(
    taskId: string,
    capabilityKey: string,
    source: string,
  ): Promise<{ id: string; name: string; url: string }[]> {
    return notOnPostgresYet("PostgresTasksRepository.listGeneratedUrlAttachments");
  }

  listRoutingWorkerStatuses(
    openStatuses: readonly string[],
  ): Promise<
    { agentId: string; status: string; activeTaskCount: number; openTaskCount: number }[]
  > {
    return notOnPostgresYet("PostgresTasksRepository.listRoutingWorkerStatuses");
  }

  listDependentTasks(parentId: string): Promise<TaskRow[]> {
    return notOnPostgresYet("PostgresTasksRepository.listDependentTasks");
  }

  listStalledInProgressTasks(cutoff: string): Promise<TaskRow[]> {
    return notOnPostgresYet("PostgresTasksRepository.listStalledInProgressTasks");
  }

  countTasksCreatedLastDay(): Promise<number> {
    return notOnPostgresYet("PostgresTasksRepository.countTasksCreatedLastDay");
  }

  listRootTaskChain(rootTaskId: string): Promise<TaskRow[]> {
    return notOnPostgresYet("PostgresTasksRepository.listRootTaskChain");
  }

  repointTaskDependency(
    taskId: string,
    status: string,
    fromTaskId: string,
    dependsOnJson: string,
  ): Promise<boolean> {
    return notOnPostgresYet("PostgresTasksRepository.repointTaskDependency");
  }

  findOpenHeartbeatChecklistTask(
    agentId: string,
    openStatuses: readonly string[],
  ): Promise<string | null> {
    return notOnPostgresYet("PostgresTasksRepository.findOpenHeartbeatChecklistTask");
  }

  countInProgressAmong(taskIds: readonly string[]): Promise<number> {
    return notOnPostgresYet("PostgresTasksRepository.countInProgressAmong");
  }

  queueStallOldest(): Promise<{
    claimableCount: number;
    oldestTaskId: string | null;
    oldestClaimableAt: string | null;
  } | null> {
    return notOnPostgresYet("PostgresTasksRepository.queueStallOldest");
  }

  listDependedOnTaskIds(terminalStatuses: readonly string[]): Promise<string[]> {
    return notOnPostgresYet("PostgresTasksRepository.listDependedOnTaskIds");
  }

  shippingEvidenceSql(
    alias: string,
    host: string,
  ): { hasArtifact: SqlQuery; hasPullRequest: SqlQuery } {
    return notOnPostgresYet("PostgresTasksRepository.shippingEvidenceSql");
  }
}
