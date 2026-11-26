import {
  type AttributionReachRow,
  type AttributionRootRow,
  type AttributionWindow,
  BaseTasksRepository,
  greatestStrict,
  HUMAN_FREE_TAGS,
  type HumanFreeClassifyInput,
  jsonText,
  likeAsciiCi,
  nowIso,
  readableSessionSql,
  SqlQuery,
  sql,
  sqlJoin,
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

/** A Postgres array literal of text elements, every element quoted. */
function textArrayLiteral(items: readonly string[]): string {
  return `{${items.map((item) => `"${item.replace(/[\\"]/g, "\\$&")}"`).join(",")}}`;
}

/** The elements of a bound id list, as `(value)` rows. */
function idRows(ids: readonly string[]): SqlQuery {
  return sql`jsonb_array_elements_text(${jsonText(JSON.stringify(ids))}) AS j(value)`;
}

/**
 * The FTS5 query `"<search>"*` as a tsquery: the words of the search (as
 * fts_words splits them) as one phrase, the last one a prefix. NULL when the
 * search has no word.
 */
function taskTsQuery(search: string): SqlQuery {
  return sql`to_tsquery('simple', (
    SELECT string_agg(quote_literal(w), ' <-> ') || ':*'
    FROM regexp_split_to_table(btrim(fts_words(CAST(${search} AS text))), ' +') AS w
    WHERE w <> ''))`;
}

// The agent_tasks_fts expressions of migration 368 (indexes agent_tasks_fts_task
// and agent_tasks_fts_title), word for word: the planner uses an index only for
// an equal expression. One vector per column, as an FTS5 phrase never spans two.
// Search reads them only for the tasks past the backfill mark (migration 391).
export const TASK_TEXT_TSVECTOR = sql`to_tsvector('simple', fts_words(agent_tasks.task))`;
export const TASK_TITLE_TSVECTOR = sql`to_tsvector('simple', fts_words(agent_tasks.title))`;

/**
 * Writes the stored search documents (agent_tasks_search, migration 391) of
 * the rows a statement returns, in the same statement. `task_search_document`
 * is the expression of 368. A task row without a document row is written by
 * the backfill or by db-copy.
 */
const UPSERT_TASK_SEARCH = `INSERT INTO agent_tasks_search (task_id, task_doc, title_doc)
  SELECT id, task_search_document(task), task_search_document(title) FROM written
  ON CONFLICT (task_id) DO UPDATE SET task_doc = EXCLUDED.task_doc, title_doc = EXCLUDED.title_doc`;

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

  async listTasks<F extends TaskListFields>(
    filters: TaskListFilters,
    page: TaskListPage,
    fields: F,
  ): Promise<TaskListRow<F>[]> {
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
    return this.db.query<TaskListRow<F>>(sql`WITH page AS (
      SELECT agent_tasks."_rowid" AS rid FROM agent_tasks${sqlWhere(conditions)}
      ORDER BY ${raw(order)} LIMIT ${raw(String(page.limit))} OFFSET ${raw(String(page.offset))}
    )
    SELECT ${raw(LIST_COLUMNS[fields])}, ${raw(TOTAL_COST_SQL)}${fields === "slim" ? taskRunModelColumn("_rowid") : raw("")}
    FROM page JOIN agent_tasks ON agent_tasks."_rowid" = page.rid
    ORDER BY ${raw(order)}`);
  }

  protected override writeTaskText(write: SqlQuery): SqlQuery {
    return sql`WITH written AS (${write}), documents AS (${raw(UPSERT_TASK_SEARCH)})
      SELECT * FROM written`;
  }

  /**
   * A phrase-prefix match on the task text or title, or a prefix of the task
   * id, as the set of matching ids. Every arm reads an index: the GIN indexes
   * of the stored documents (migration 391), the expression indexes of 368 for
   * the tasks past the backfill mark (none once it is complete), and the
   * primary key for the id prefix. A phrase checks its word positions in the
   * stored document, so no task text is parsed at query time.
   *
   * The set is MATERIALIZED: computed once, before the page or the count. The
   * planner can not then read the tasks in list order and test the match on
   * each one, which reads every task when few or none match.
   */
  protected async taskSearchCondition(
    search: string,
    _purpose: "page" | "count",
  ): Promise<SqlQuery> {
    const indexedThrough = (await this.getTaskFtsIndexedThrough()) ?? 0;
    const idLow = search.trim().toLowerCase();
    const arms: SqlQuery[] = [];
    if (/[\p{L}\p{N}]/u.test(search)) {
      const query = taskTsQuery(search);
      arms.push(sql`SELECT task_id AS id FROM agent_tasks_search
        WHERE task_doc @@ ${query} OR title_doc @@ ${query}`);
      if (indexedThrough < TASK_FTS_COMPLETE) {
        arms.push(sql`SELECT id FROM agent_tasks WHERE "_rowid" > ${indexedThrough}
          AND (${TASK_TEXT_TSVECTOR} @@ ${query} OR ${TASK_TITLE_TSVECTOR} @@ ${query})`);
      }
    }
    if (idLow) {
      arms.push(sql`SELECT id FROM agent_tasks WHERE id >= ${idLow} AND id < ${`${idLow}\uffff`}`);
    }
    if (arms.length === 0) return sql`false`;
    return sql`agent_tasks.id IN (
      WITH hits AS MATERIALIZED (${sqlJoin(arms, sql` UNION `)}) SELECT id FROM hits)`;
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
   * Writes the stored search documents of the next `batchSize` tasks past the
   * backfill mark, in insertion order, and advances the mark past them in the
   * same transaction. A task written since has its document already: the
   * batch writes it again from the same row. The last batch sets the mark to
   * TASK_FTS_COMPLETE, which ends the expression arm of the search.
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
    const written = await this.db.run(sql`
      WITH written AS (
        SELECT id, task, title FROM agent_tasks
        WHERE "_rowid" > ${indexedThrough} AND "_rowid" <= ${through}
      ) ${raw(UPSERT_TASK_SEARCH)}`);
    await this.db.run(
      sql`UPDATE agent_tasks_fts_state SET "indexedThrough" = ${through} WHERE id = 1`,
    );
    return { changes: written.changes, done: through >= TASK_FTS_COMPLETE };
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
    // json_extract(capabilities, '$.<key>'): the key is a dotted path chosen by code.
    return this.db.query<{ id: string; name: string; url: string }>(sql`
      SELECT id, name, url FROM task_attachments
      WHERE task_id = ${taskId}
        AND kind = 'url'
        AND url IS NOT NULL
        AND capabilities #>> CAST(${textArrayLiteral(capabilityKey.split("."))} AS text[]) = ${source}
      ORDER BY "_rowid"`);
  }

  listRoutingWorkerStatuses(
    openStatuses: readonly string[],
  ): Promise<
    { agentId: string; status: string; activeTaskCount: number; openTaskCount: number }[]
  > {
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
      WHERE agent."isLead" = ${false}
      GROUP BY agent.id, agent.status
      ORDER BY agent.id`);
  }

  listDependentTasks(parentId: string): Promise<TaskRow[]> {
    return this.db.query<TaskRow>(sql`
      SELECT t.* FROM agent_tasks t, ${jsonArrayElements(sql`t."dependsOn"`)} AS dep(value)
      WHERE dep.value = ${parentId}
      ORDER BY t."_rowid"`);
  }

  listStalledInProgressTasks(cutoff: string): Promise<TaskRow[]> {
    return this.db.query<TaskRow>(sql`
      SELECT * FROM agent_tasks WHERE status = 'in_progress' AND "lastUpdatedAt" < ${cutoff}
      ORDER BY "lastUpdatedAt" ASC, "_rowid" ASC`);
  }

  async countTasksCreatedLastDay(): Promise<number> {
    const row = await this.db.get<{ count: number }>(sql`
      SELECT COUNT(*) AS count FROM agent_tasks
      WHERE "createdAt" >= statement_timestamp() - interval '24 hours'`);
    return Number(row?.count ?? 0);
  }

  listRootTaskChain(rootTaskId: string): Promise<TaskRow[]> {
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
      JOIN agent_tasks t ON t.id = chain.id
      ORDER BY t."createdAt", t."_rowid"`);
  }

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
         SET "dependsOn" = ${jsonText(dependsOnJson)}, "lastUpdatedAt" = ${nowIso}
       WHERE id = ${taskId} AND status = ${status}
         AND EXISTS (SELECT 1 FROM ${jsonArrayElements(sql`agent_tasks."dependsOn"`)} AS dep(value)
                      WHERE dep.value = ${fromTaskId})
       RETURNING id`);
    return row != null;
  }

  async findOpenHeartbeatChecklistTask(
    agentId: string,
    openStatuses: readonly string[],
  ): Promise<string | null> {
    const row = await this.db.get<{ id: string }>(sql`
      SELECT id FROM agent_tasks
       WHERE status IN (${sqlList(openStatuses)})
         AND "agentId" = ${agentId}
         AND "taskType" = 'heartbeat-checklist'
       LIMIT 1`);
    return row?.id ?? null;
  }

  async countInProgressAmong(taskIds: readonly string[]): Promise<number> {
    if (taskIds.length === 0) return 0;
    const row = await this.db.get<{ n: number }>(sql`
      SELECT count(*) AS n FROM agent_tasks
       WHERE status = 'in_progress' AND id IN (SELECT value FROM ${idRows(taskIds)})`);
    return Number(row?.n ?? 0);
  }

  async queueStallOldest(): Promise<{
    claimableCount: number;
    oldestTaskId: string | null;
    oldestClaimableAt: string | null;
  } | null> {
    const deps = (alias: string) =>
      jsonArrayElements(sql`COALESCE(${raw(alias)}."dependsOn", '[]'::jsonb)`);
    const row = await this.db.get<{
      claimableCount: number;
      oldestTaskId: string | null;
      oldestClaimableAt: string | null;
    }>(sql`
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
            ${greatestStrict(
              sql`queued."queueEnteredAt"`,
              sql`COALESCE(
                (
                  SELECT MAX(COALESCE(prerequisite."finishedAt", prerequisite."createdAt"))
                  FROM ${deps("queued")} AS dep(value)
                  JOIN agent_tasks prerequisite ON prerequisite.id = dep.value
                ),
                queued."queueEnteredAt"
              )`,
            )} AS "claimableAt"
          FROM queued
          WHERE NOT EXISTS (
              SELECT 1
              FROM ${deps("queued")} AS dep(value)
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
    return row ? { ...row, claimableCount: Number(row.claimableCount) } : null;
  }

  async listDependedOnTaskIds(terminalStatuses: readonly string[]): Promise<string[]> {
    const rows = await this.db.query<{ id: string }>(sql`
      SELECT DISTINCT dep.value AS id
        FROM agent_tasks t, ${jsonArrayElements(sql`t."dependsOn"`)} AS dep(value)
       WHERE t.status NOT IN (${sqlList(terminalStatuses)})
         AND t."dependsOn" IS NOT NULL AND t."dependsOn" != '[]'::jsonb`);
    return rows.map((row) => row.id);
  }

  listAttributionRoots(
    window: AttributionWindow,
    githubHost: string,
  ): Promise<AttributionRootRow[]> {
    if (!/^[a-z0-9._:-]+$/.test(githubHost))
      throw new Error(`Invalid GitHub host for SQL: ${githubHost}`);
    // Same shape as SQLite: UNION makes rootId unique, so the LEFT JOIN cannot
    // duplicate a root. LIKE folds ASCII case only, as on SQLite (C ctype).
    const pull = `%${githubHost}/%/pull/%`;
    const mergeRequest = "%/-/merge_requests/%";
    return this.db.query<AttributionRootRow>(sql`
      WITH RECURSIVE selected_roots(id, "requestedByUserId", status) AS (
        SELECT t.id, t."requestedByUserId", t.status
        FROM agent_tasks t
        ${attributionWhere(window)} AND t."parentTaskId" IS NULL AND t."isHumanFree" = ${false}
      ),
      task_tree("rootId", "taskId") AS (
        SELECT id, id FROM selected_roots
        UNION ALL
        SELECT tree."rootId", child.id
        FROM agent_tasks child
        JOIN task_tree tree ON child."parentTaskId" = tree."taskId"
      ),
      shipped_roots("rootId") AS (
        SELECT tree."rootId"
        FROM task_tree tree
        JOIN task_attachments ta ON ta.task_id = tree."taskId"
        WHERE ta.kind = 'page'
           OR (ta.kind = 'url' AND (ta.url ILIKE ${pull} ESCAPE '' OR ta.url ILIKE ${mergeRequest} ESCAPE ''))
        UNION
        SELECT tree."rootId"
        FROM task_tree tree
        JOIN agent_tasks described ON described.id = tree."taskId"
        WHERE described.output ILIKE ${pull} ESCAPE '' OR described.output ILIKE ${mergeRequest} ESCAPE ''
      )
      SELECT t."requestedByUserId" AS "userId", COUNT(*) AS initiated,
        SUM(CASE WHEN t.status = 'completed' AND s."rootId" IS NOT NULL THEN 1 ELSE 0 END) AS shipped
      FROM selected_roots t
      LEFT JOIN shipped_roots s ON s."rootId" = t.id
      GROUP BY t."requestedByUserId"`);
  }

  listAttributionReach(window: AttributionWindow): Promise<AttributionReachRow[]> {
    return this.db.query<AttributionReachRow>(sql`
      SELECT t."requestedByUserId" AS "userId",
        COUNT(DISTINCT t."agentId") AS "agentsReached",
        COUNT(DISTINCT t."vcsRepo") AS "reposReached",
        COUNT(DISTINCT t.source) AS "surfacesReached"
      FROM agent_tasks t
      ${attributionWhere(window)} AND t."isHumanFree" = ${false}
      GROUP BY t."requestedByUserId"`);
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

// ECMAScript whitespace plus prose wrappers that terminate URL-like tokens
// (the SQLite list, unchanged).
const githubTokenDelimiterCodePoints = [
  9, 10, 11, 12, 13, 160, 5760, 8192, 8193, 8194, 8195, 8196, 8197, 8198, 8199, 8200, 8201, 8202,
  8232, 8233, 8239, 8287, 12288, 65279, 40, 41, 91, 93, 123, 125, 60, 62, 34, 39, 96,
];

function githubTokenDelimitersSql(): string {
  return githubTokenDelimiterCodePoints.map((code, index) => `(${index + 1}, ${code})`).join(", ");
}

/**
 * The SQLite `githubPullRequestExistsSql`, step for step: GLOB 'p*' is
 * starts_with, GLOB character classes are anchored regular expressions (byte
 * ranges under the C collation, as GLOB compares), instr is strpos, char is
 * chr. `value` is a column reference chosen by code; `host` is a checked
 * lower-case host. Both are inlined as text.
 */
function githubPullRequestExistsSql(value: string, host: string): string {
  return `EXISTS (
    WITH RECURSIVE
    token_delimiters(pos, code_point) AS (
      VALUES ${githubTokenDelimitersSql()}
    ),
    normalized(value, pos) AS (
      SELECT coalesce(${value}, ''), 0

      UNION ALL

      SELECT replace(normalized.value, chr(code_point), ' '), normalized.pos + 1
      FROM normalized
      JOIN token_delimiters ON token_delimiters.pos = normalized.pos + 1
    ),
    tokens(remaining, token) AS (
      SELECT trim(value) || ' ', CAST(NULL AS text)
      FROM normalized
      WHERE pos = (SELECT max(pos) FROM token_delimiters)

      UNION ALL

      SELECT
        ltrim(substr(remaining, strpos(remaining, ' ') + 1)),
        substr(remaining, 1, strpos(remaining, ' ') - 1)
      FROM tokens
      WHERE remaining <> ''
    ),
    github_paths(path) AS (
      SELECT CASE
        WHEN starts_with(lower(token), 'https://${host}/')
          THEN substr(token, length('https://${host}/') + 1)
        WHEN starts_with(lower(token), 'http://${host}/')
          THEN substr(token, length('http://${host}/') + 1)
        ELSE substr(token, length('${host}/') + 1)
      END
      FROM tokens
      WHERE starts_with(lower(token), 'https://${host}/')
         OR starts_with(lower(token), 'http://${host}/')
         OR starts_with(lower(token), '${host}/')
    ),
    github_segments(owner, repo, remainder) AS (
      SELECT
        substr(path, 1, strpos(path, '/') - 1),
        substr(
          substr(path, strpos(path, '/') + 1),
          1,
          strpos(substr(path, strpos(path, '/') + 1), '/') - 1
        ),
        substr(
          substr(path, strpos(path, '/') + 1),
          strpos(substr(path, strpos(path, '/') + 1), '/') + 1
        )
      FROM github_paths
      WHERE strpos(path, '/') > 1
        AND strpos(substr(path, strpos(path, '/') + 1), '/') > 1
    ),
    github_pull_numbers(remainder, pos) AS (
      SELECT remainder, length('pull/') + 1
      FROM github_segments
      WHERE owner !~ '[^A-Za-z0-9._-]'
        AND repo !~ '[^A-Za-z0-9._-]'
        AND owner NOT IN ('.', '..')
        AND repo NOT IN ('.', '..')
        AND lower(remainder) ~ '^pull/[0-9]'

      UNION ALL

      SELECT remainder, pos + 1
      FROM github_pull_numbers
      WHERE substr(remainder, pos, 1) ~ '^[0-9]$'
    )
    SELECT 1
    FROM github_pull_numbers
    WHERE substr(remainder, pos, 1) !~ '^[0-9]$'
      AND (
        substr(remainder, pos, 1) = ''
        OR substr(remainder, pos, 1) IN ('/', '?', '#')
        OR btrim(substr(remainder, pos), ')]},.;:!') = ''
      )
    LIMIT 1
  )`;
}

// ---- attribution report ----

function attributionWhere(window: AttributionWindow): SqlQuery {
  const conditions = [sql`t."requestedByUserId" IS NOT NULL`];
  if (window.startDate !== undefined) conditions.push(sql`t."createdAt" >= ${window.startDate}`);
  if (window.endBefore !== undefined) conditions.push(sql`t."createdAt" < ${window.endBefore}`);
  else if (window.endAtOrBefore !== undefined)
    conditions.push(sql`t."createdAt" <= ${window.endAtOrBefore}`);
  return sqlWhere(conditions);
}
