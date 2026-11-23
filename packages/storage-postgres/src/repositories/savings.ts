import type {
  SavingsAgentSpendRow,
  SavingsBucketSize,
  SavingsCalibrationSessionRow,
  SavingsDayCountRow,
  SavingsDispatchStepRow,
  SavingsEffectStepRow,
  SavingsOwnedTaskRow,
  SavingsReader,
  SavingsScriptEffectRow,
  SavingsScriptLinkRow,
  SavingsScriptRunRow,
  SavingsSpan,
  SavingsStepFactRow,
  SavingsTaskTreeRow,
  SavingsTriggerRow,
  SavingsWorkflowLinkRow,
} from "@desplega/storage";
import {
  BaseSavingsRepository,
  EMPTY,
  jsonText,
  likeAsciiCi,
  type SavingsLinkRow,
  type SavingsScriptBucket,
  SqlQuery,
  sql,
  sqlJoin,
  sqlList,
} from "@desplega/storage";

/** A string inlined as an SQL literal (a code constant, never input). */
const literal = (text: string): SqlQuery => new SqlQuery([`'${text.replace(/'/g, "''")}'`], []);

/** The bucket key of a timestamptz column: its UTC ISO text cut to the day or the minute. */
const bucketOfTime = (column: SqlQuery, bucket: SavingsBucketSize): SqlQuery =>
  bucket === "minute"
    ? sql`to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI')`
    : sql`to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD')`;

/** The bucket key of an ISO text column (`script_runs."startedAt"`). */
const bucketOfText = (column: SqlQuery, bucket: SavingsBucketSize): SqlQuery =>
  sql`substr(${column},1,${bucket === "minute" ? sql`16` : sql`10`})`;

/** A timestamptz as the ISO text SQLite stores (`strftime('%Y-%m-%dT%H:%M:%fZ', ...)`). */
const isoText = (value: SqlQuery): SqlQuery =>
  sql`to_char(${value} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

/** Seconds between two timestamptz values (SQLite: julianday difference times 86400). */
const secondsBetween = (from: SqlQuery, to: SqlQuery): SqlQuery =>
  sql`extract(epoch FROM (${to} - ${from}))::double precision`;

/** SQLite's `json_extract` of a number (or a boolean, as 1/0) under `path` of a text column; other values read NULL. */
const jsonNumber = (doc: SqlQuery, path: string): SqlQuery => {
  const p = literal(`{${path}}`);
  return sql`(CASE json_typeof(${doc} #> ${p}) WHEN 'number' THEN (${doc} #>> ${p})::double precision WHEN 'boolean' THEN (CASE WHEN ${doc} #>> ${p} = 'true' THEN 1 ELSE 0 END)::double precision END)`;
};

// A run "caused a downstream effect" when it created an agent task or started a child workflow run.
const EFFECT = sql`(EXISTS(SELECT 1 FROM agent_tasks k WHERE k."workflowRunId"=r.id) OR EXISTS(SELECT 1 FROM workflow_run_steps s2 JOIN workflow_runs c ON c."parentStepId"=s2.id WHERE s2."runId"=r.id))`;
const AWAITS = sql`(length(source)-length(replace(source,'await','')))/5`;
/** Source that can create an agent task or start a workflow (SQLite LIKE: ASCII case-insensitive). */
const DISPATCH = sql`(${sqlJoin(
  ["%task_send%", "%send_task%", "%sendTask%", "%workflow_trigger%"].map(
    (p) => sql`${likeAsciiCi(sql`source`, literal(p))}`,
  ),
  sql` OR `,
)})`;

// SQLite's INSERT OR REPLACE deletes the conflicting row and inserts a new
// one: every column the statement does not name goes back to its default and
// the row gets a new rowid. The upserts below reset the same columns.
export class PostgresSavingsRepository extends BaseSavingsRepository {
  async replaceScriptBucket(b: SavingsScriptBucket): Promise<void> {
    await this.db.run(sql`
      INSERT INTO automation_savings_daily
        (day, "jobKind", "jobId", "jobKey", "jobName", "subKind", runs, "countedRuns", "effectRuns", "opsSum", "computeSecs", "modelVersion", "computedAt")
      VALUES (${b.day}, 'script', ${b.jobId}, ${b.jobKey}, ${b.jobName}, ${b.subKind}, ${b.runs}, ${b.countedRuns},
        ${b.effectRuns}, ${b.opsSum}, ${b.computeSecs}, ${b.modelVersion}, ${b.computedAt})
      ON CONFLICT (day, "jobKind", "jobId", "subKind") DO UPDATE SET
        "jobKey" = excluded."jobKey", "jobName" = excluded."jobName", runs = excluded.runs,
        "countedRuns" = excluded."countedRuns", "effectRuns" = excluded."effectRuns",
        "opsSum" = excluded."opsSum", "computeSecs" = excluded."computeSecs",
        "modelVersion" = excluded."modelVersion", "computedAt" = excluded."computedAt",
        "schedRuns" = DEFAULT, "schedEffectRuns" = DEFAULT, "eventRuns" = DEFAULT,
        "effectOpsSum" = DEFAULT, "agentTasks" = DEFAULT, "agentUsd" = DEFAULT,
        "agentMs" = DEFAULT, "followupUsd" = DEFAULT, "recordedLlmUsd" = DEFAULT,
        "estimatedLlmUsd" = DEFAULT, "childTaskUsd" = DEFAULT, "childTaskMs" = DEFAULT,
        "_rowid" = DEFAULT`);
  }

  async replaceLink(l: SavingsLinkRow): Promise<void> {
    await this.db.run(sql`
      INSERT INTO automation_savings_links
        (day, "parentJobId", "childKind", "childJobId", "linkKind", n, "actualUsd", "keptUsd", "modelVersion", "computedAt")
      VALUES (${l.day}, ${l.parentJobId}, ${l.childKind}, ${l.childJobId}, ${l.linkKind}, ${l.n}, ${l.actualUsd},
        ${l.keptUsd}, ${l.modelVersion}, ${l.computedAt})
      ON CONFLICT (day, "parentJobId", "childKind", "childJobId", "linkKind") DO UPDATE SET
        n = excluded.n, "actualUsd" = excluded."actualUsd", "keptUsd" = excluded."keptUsd",
        "modelVersion" = excluded."modelVersion", "computedAt" = excluded."computedAt",
        "_rowid" = DEFAULT`);
  }

  listScriptAwaitCounts(
    names: string[],
    reader?: SavingsReader,
  ): Promise<{ name: string; aw: number }[]> {
    if (names.length === 0) return Promise.resolve([]);
    return this.via(reader).query(
      sql`SELECT name, ${AWAITS} aw FROM scripts WHERE "isScratch"=${false} AND name IN (${sqlList(names)}) ORDER BY scope='global'`,
    );
  }

  async listDispatchingScripts(names: string[], reader?: SavingsReader): Promise<string[]> {
    if (names.length === 0) return [];
    const rows = await this.via(reader).query<{ name: string }>(
      sql`SELECT DISTINCT name FROM scripts WHERE "isScratch"=${false} AND name IN (${sqlList(names)}) AND ${DISPATCH}`,
    );
    return rows.map((r) => String(r.name));
  }

  async countWorkflowRunsInSpan(
    workflowId: string,
    span: SavingsSpan,
    reader?: SavingsReader,
  ): Promise<number> {
    const rows = await this.via(reader).query<{ n: number }>(
      sql`SELECT count(*) n FROM workflow_runs WHERE "workflowId"=${workflowId} AND "startedAt">=${span.start} AND "startedAt"<${span.end}`,
    );
    return Number(rows[0]?.n) || 0;
  }

  workflowRunsByTrigger(
    workflowId: string,
    span: SavingsSpan,
    bucket: SavingsBucketSize,
    reader?: SavingsReader,
  ): Promise<SavingsTriggerRow[]> {
    return this.via(reader).query(
      sql`SELECT ${bucketOfTime(sql`r."startedAt"`, bucket)} d, r."triggerType" tt, r.status st, count(*) n FROM workflow_runs r WHERE r."workflowId"=${workflowId} AND r."startedAt">=${span.start} AND r."startedAt"<${span.end} GROUP BY 1,2,3`,
    );
  }

  workflowScheduledEffectRuns(
    workflowId: string,
    span: SavingsSpan,
    bucket: SavingsBucketSize,
    reader?: SavingsReader,
  ): Promise<SavingsDayCountRow[]> {
    return this.via(reader).query(
      sql`SELECT ${bucketOfTime(sql`r."startedAt"`, bucket)} d, count(*) n FROM workflow_runs r WHERE r."workflowId"=${workflowId} AND r."startedAt">=${span.start} AND r."startedAt"<${span.end} AND r."triggerType"='schedule' AND r.status NOT IN ('skipped','cancelled') AND ${EFFECT} GROUP BY 1`,
    );
  }

  workflowStepFacts(
    workflowId: string,
    span: SavingsSpan,
    bucket: SavingsBucketSize,
    reader?: SavingsReader,
  ): Promise<SavingsStepFactRow[]> {
    // json (not jsonb) keeps the stored text, as SQLite's json_extract reads it.
    const out = sql`(s.output::json)`;
    return this.via(reader).query(
      sql`SELECT ${bucketOfTime(sql`r."startedAt"`, bucket)} d, s."nodeId" nid, count(*) n, sum(CASE WHEN s."nodeType" NOT IN ('agent-task','wait','human-in-the-loop','foreach','sub-workflow') THEN ${secondsBetween(sql`s."startedAt"`, sql`coalesce(s."finishedAt",s."startedAt")`)} ELSE 0 END) secs,
      sum(CASE WHEN ${likeAsciiCi(sql`s."nodeType"`, sql`'system-one%'`)} THEN ${jsonNumber(out, "usage,input_tokens")} END) itok,
      sum(CASE WHEN s."nodeType"='raw-llm' THEN length(${out} ->> 'result') END) rchars,
      sum(CASE WHEN s."nodeId"='report' THEN ${jsonNumber(out, "result,summary,jevCostUsd")} END) jev,
      sum(CASE WHEN s."nodeId"='report' THEN ${jsonNumber(out, "result,cost,clairicUsd")} END) clairic
      FROM workflow_runs r JOIN workflow_run_steps s ON s."runId"=r.id WHERE r."workflowId"=${workflowId} AND r."startedAt">=${span.start} AND r."startedAt"<${span.end} GROUP BY 1,2`,
    );
  }

  workflowAgentSpend(
    workflowId: string,
    span: SavingsSpan,
    bucket: SavingsBucketSize,
    reader?: SavingsReader,
  ): Promise<SavingsAgentSpendRow[]> {
    return this.via(reader).query(
      sql`SELECT ${bucketOfTime(sql`r."startedAt"`, bucket)} d, count(DISTINCT t.id) tasks, sum(c.u) usd, sum(c.ms) ms
      FROM workflow_runs r JOIN agent_tasks t ON t."workflowRunId"=r.id LEFT JOIN (SELECT "taskId", sum("totalCostUsd") u, sum("durationMs") ms FROM session_costs GROUP BY "taskId") c ON c."taskId"=t.id
      WHERE r."workflowId"=${workflowId} AND r."startedAt">=${span.start} AND r."startedAt"<${span.end} GROUP BY 1`,
    );
  }

  workflowFollowupSpend(
    workflowId: string,
    span: SavingsSpan,
    bucket: SavingsBucketSize,
    reader?: SavingsReader,
  ): Promise<{ d: string; fup: number | null }[]> {
    const followUp = sql`(${likeAsciiCi(sql`k.task`, sql`'Worker task completed%'`)} OR ${likeAsciiCi(sql`k.task`, sql`'Worker task failed%'`)})`;
    return this.via(reader).query(
      sql`SELECT ${bucketOfTime(sql`r."startedAt"`, bucket)} d, sum(c2."totalCostUsd") fup FROM workflow_runs r JOIN agent_tasks t2 ON t2."workflowRunId"=r.id JOIN agent_tasks k ON k."parentTaskId"=t2.id AND ${followUp} JOIN session_costs c2 ON c2."taskId"=k.id WHERE r."workflowId"=${workflowId} AND r."startedAt">=${span.start} AND r."startedAt"<${span.end} GROUP BY 1`,
    );
  }

  workflowEffectSteps(
    workflowId: string,
    span: SavingsSpan,
    bucket: SavingsBucketSize,
    reader?: SavingsReader,
  ): Promise<SavingsEffectStepRow[]> {
    return this.via(reader).query(
      sql`WITH e AS (SELECT s."runId" id FROM workflow_runs c JOIN workflow_run_steps s ON s.id=c."parentStepId" JOIN workflow_runs p ON p.id=s."runId"
        WHERE c."parentStepId" IS NOT NULL AND p."workflowId"=${workflowId} AND p."startedAt">=${span.start} AND p."startedAt"<${span.end}
      UNION SELECT k."workflowRunId" FROM agent_tasks k JOIN workflow_runs p ON p.id=k."workflowRunId" WHERE k."workflowRunId" IS NOT NULL AND p."workflowId"=${workflowId} AND p."startedAt">=${span.start} AND p."startedAt"<${span.end}),
    ed AS (SELECT e.id, ${bucketOfTime(sql`r."startedAt"`, bucket)} d FROM e JOIN workflow_runs r ON r.id=e.id)
    SELECT d, CAST(NULL AS text) nid, count(*) n FROM ed GROUP BY d
    UNION ALL SELECT ed.d, s."nodeId", count(*) n FROM ed JOIN workflow_run_steps s ON s."runId"=ed.id GROUP BY 1,2`,
    );
  }

  scriptRunsByName(
    span: SavingsSpan,
    bucket: SavingsBucketSize,
    filter: { scriptName?: string; inlineName: string },
    reader?: SavingsReader,
  ): Promise<SavingsScriptRunRow[]> {
    const one =
      filter.scriptName === undefined
        ? EMPTY
        : sql` AND coalesce("scriptName", ${filter.inlineName})=${filter.scriptName}`;
    // "startedAt" is ISO text here; "finishedAt" a timestamptz.
    const started = sql`CAST("startedAt" AS timestamptz)`;
    return this.via(reader).query(
      sql`SELECT ${bucketOfText(sql`"startedAt"`, bucket)} d, coalesce("scriptName",${literal(filter.inlineName)}) nm, count(*) n, sum(CASE WHEN "apiEndpointId" IS NOT NULL THEN 1 ELSE 0 END) api,
      sum(${secondsBetween(started, sql`coalesce("finishedAt",${started})`)}) secs
      FROM script_runs WHERE "startedAt">=${span.start} AND "startedAt"<${span.end}${one} GROUP BY 1,2`,
    );
  }

  scriptEffectRuns(
    span: SavingsSpan,
    bucket: SavingsBucketSize,
    filter: { scriptName?: string; inlineName: string },
    dispatchers: string[],
    reader?: SavingsReader,
  ): Promise<SavingsScriptEffectRow[]> {
    // A task stamped with the run that created it (its run token) links
    // exactly; the output probe covers unstamped tasks of dispatching scripts.
    // script_runs."startedAt" is ISO text: it compares with the task time as
    // ISO text, as on SQLite.
    const tasksTo = sql`(CAST(${span.end} AS timestamptz) + interval '20 minutes')`;
    const probe =
      dispatchers.length > 0
        ? sql`UNION SELECT ${bucketOfText(sql`r."startedAt"`, bucket)} d, r."scriptName" nm, (r."apiEndpointId" IS NOT NULL) api, r.id
        FROM agent_tasks t
        JOIN script_runs r ON r."scriptName" IN (${sqlList(dispatchers)})
          AND r."startedAt">=${isoText(sql`(t."createdAt" - interval '20 minutes')`)} AND r."startedAt"<=${isoText(sql`t."createdAt"`)} AND ${likeAsciiCi(sql`r.output`, sql`'%'||t.id||'%'`)}
          AND r."startedAt">=${span.start} AND r."startedAt"<${span.end}
        WHERE t."createdAt">=${span.start} AND t."createdAt"<${tasksTo} AND t."sourceScriptRunId" IS NULL`
        : EMPTY;
    const one =
      filter.scriptName === undefined
        ? EMPTY
        : sql`AND coalesce(r."scriptName", ${filter.inlineName})=${filter.scriptName}`;
    return this.via(reader).query(
      sql`SELECT d, nm, api, count(DISTINCT id) n FROM (
       SELECT ${bucketOfText(sql`r."startedAt"`, bucket)} d, coalesce(r."scriptName",${literal(filter.inlineName)}) nm, (r."apiEndpointId" IS NOT NULL) api, r.id
       FROM agent_tasks t JOIN script_runs r ON r.id=t."sourceScriptRunId"
       WHERE t."sourceScriptRunId" IS NOT NULL AND t."createdAt">=${span.start} AND t."createdAt"<${tasksTo}
         AND r."startedAt">=${span.start} AND r."startedAt"<${span.end} ${one}
       ${probe}
     ) x GROUP BY 1,2,3`,
    );
  }

  subWorkflowLinks(span: SavingsSpan, reader?: SavingsReader): Promise<SavingsWorkflowLinkRow[]> {
    return this.via(reader).query(
      sql`SELECT p."workflowId" pid, c."workflowId" cid, count(*) n FROM workflow_runs c
      JOIN workflow_run_steps s ON s.id=c."parentStepId" JOIN workflow_runs p ON p.id=s."runId"
      WHERE c."parentStepId" IS NOT NULL AND c."startedAt">=${span.start} AND c."startedAt"<${span.end} GROUP BY 1,2`,
    );
  }

  stampedWorkflowLinks(
    span: SavingsSpan,
    reader?: SavingsReader,
  ): Promise<SavingsWorkflowLinkRow[]> {
    return this.via(reader).query(
      sql`SELECT p."workflowId" pid, c."workflowId" cid, count(*) n FROM workflow_runs c
      JOIN workflow_run_steps s ON s.id=c."sourceStepId" JOIN workflow_runs p ON p.id=s."runId"
      WHERE c."sourceStepId" IS NOT NULL AND c."startedAt">=${span.start} AND c."startedAt"<${span.end} GROUP BY 1,2`,
    );
  }

  stampedScriptLinks(
    span: SavingsSpan,
    inlineName: string,
    reader?: SavingsReader,
  ): Promise<SavingsScriptLinkRow[]> {
    return this.via(reader).query(
      sql`SELECT p."workflowId" pid, coalesce(r."scriptName",${literal(inlineName)}) nm, count(*) n FROM script_runs r
      JOIN workflow_run_steps s ON s.id=r."sourceStepId" JOIN workflow_runs p ON p.id=s."runId"
      WHERE r."sourceStepId" IS NOT NULL AND r."startedAt">=${span.start} AND r."startedAt"<${span.end} GROUP BY 1,2`,
    );
  }

  listStepTasks(span: SavingsSpan, reader?: SavingsReader): Promise<SavingsOwnedTaskRow[]> {
    return this.via(reader).query(
      sql`SELECT p."workflowId" pid, t.id FROM agent_tasks t
      JOIN workflow_run_steps s ON s.id=t."sourceStepId" JOIN workflow_runs p ON p.id=s."runId"
      WHERE t."sourceStepId" IS NOT NULL AND t."createdAt">=${span.start} AND t."createdAt"<${span.end}`,
    );
  }

  listNodeTasks(span: SavingsSpan, reader?: SavingsReader): Promise<SavingsOwnedTaskRow[]> {
    return this.via(reader).query(
      sql`SELECT p."workflowId" pid, t.id FROM agent_tasks t JOIN workflow_runs p ON p.id=t."workflowRunId"
      WHERE t."createdAt">=${span.start} AND t."createdAt"<${span.end} AND t."workflowRunId" IS NOT NULL`,
    );
  }

  listTaskTrees(
    roots: string[],
    maxDepth: number,
    reader?: SavingsReader,
  ): Promise<SavingsTaskTreeRow[]> {
    if (roots.length === 0) return Promise.resolve([]);
    const depth = new SqlQuery([String(Math.trunc(maxDepth))], []);
    return this.via(reader).query(
      sql`WITH RECURSIVE r(id) AS (SELECT jsonb_array_elements_text(${jsonText(JSON.stringify(roots))})),
           d(root, id, depth) AS (
             SELECT id, id, 0 FROM r
             UNION ALL SELECT d.root, k.id, d.depth+1 FROM d JOIN agent_tasks k ON k."parentTaskId"=d.id
               WHERE k."workflowRunId" IS NULL AND k."sourceStepId" IS NULL AND k.id NOT IN (SELECT id FROM r)
                 AND d.depth<${depth})
           SELECT root, depth>0 below, count(*) n,
             sum((SELECT sum("totalCostUsd") FROM session_costs c WHERE c."taskId"=d.id)) usd,
             sum((SELECT sum("durationMs") FROM session_costs c WHERE c."taskId"=d.id)) ms
           FROM d GROUP BY 1,2`,
    );
  }

  listDispatchSteps(
    workflowId: string,
    span: SavingsSpan,
    nodeIds: string[],
    reader?: SavingsReader,
  ): Promise<SavingsDispatchStepRow[]> {
    if (nodeIds.length === 0) return Promise.resolve([]);
    const iterations = sqlJoin(
      nodeIds.map((id) => sql`${likeAsciiCi(sql`s."nodeId"`, sql`${`${id}#%`}`)}`),
      sql` OR `,
    );
    return this.via(reader).query(
      sql`SELECT s.id, s."startedAt" sa, coalesce(s."finishedAt",s."startedAt") fa, s.output FROM workflow_runs p
        JOIN workflow_run_steps s ON s."runId"=p.id
        WHERE p."workflowId"=${workflowId} AND p."startedAt">=${span.start} AND p."startedAt"<${span.end} AND s."nodeType"='swarm-script' AND s.output IS NOT NULL
          AND (s."nodeId" IN (${sqlList(nodeIds)}) OR ${iterations})`,
    );
  }

  listCalibrationSessions(
    model: string,
    span: SavingsSpan,
    maxTurns: number,
    after: string,
    limit: number,
    reader: SavingsReader,
  ): Promise<SavingsCalibrationSessionRow[]> {
    // SQLite's json_each walks an array's elements or an object's values;
    // text that is not valid JSON reads as an empty array.
    const mb = sql`s."modelBreakdown"`;
    return this.via(reader).query(
      sql`SELECT s.id AS id, s."numTurns" AS turns, s."durationMs" AS "durationMs",
       ${jsonNumber(sql`j.value`, "inputTokens")} AS "inputTokens", ${jsonNumber(sql`j.value`, "outputTokens")} AS "outputTokens",
       ${jsonNumber(sql`j.value`, "cacheReadTokens")} AS "cacheReadTokens", ${jsonNumber(sql`j.value`, "cacheWriteTokens")} AS "cacheWriteTokens",
       ${jsonNumber(sql`j.value`, "costUsd")} AS "costUsd", s."totalCostUsd" AS "totalCostUsd"
     FROM session_costs s CROSS JOIN LATERAL (
       SELECT a.value FROM json_array_elements(CASE WHEN ${mb} IS JSON ARRAY THEN ${mb}::json ELSE '[]'::json END) a
       UNION ALL SELECT ${mb}::json -> o.key FROM json_object_keys(CASE WHEN ${mb} IS JSON OBJECT THEN ${mb}::json ELSE '{}'::json END) o(key)
     ) j
     WHERE s.model = ${model} AND j.value ->> 'model' = ${model} AND s."createdAt" >= ${span.start} AND s."createdAt" < ${span.end}
       AND s."numTurns" BETWEEN 1 AND ${maxTurns} AND s.id > ${after} ORDER BY s.id LIMIT ${limit}`,
    );
  }
}
