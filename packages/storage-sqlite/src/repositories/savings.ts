import {
  BaseSavingsRepository,
  EMPTY,
  type SavingsAgentSpendRow,
  type SavingsBucketFilter,
  type SavingsBucketSize,
  type SavingsCalibrationSessionRow,
  type SavingsDayCountRow,
  type SavingsDispatchStepRow,
  type SavingsEffectStepRow,
  type SavingsLinkRow,
  type SavingsOwnedTaskRow,
  type SavingsReader,
  type SavingsScriptBucket,
  type SavingsScriptEffectRow,
  type SavingsScriptLinkRow,
  type SavingsScriptRunRow,
  type SavingsSpan,
  type SavingsStepFactRow,
  type SavingsTaskTreeRow,
  type SavingsTriggerRow,
  type SavingsWorkflowLinkRow,
  SqlQuery,
  sql,
  sqlJoin,
  sqlList,
} from "@desplega/storage";

/** The SQL key of an ISO time column for `bucket`: `substr(col,1,10)` (day) or 16 (minute). */
const bucketOf = (column: SqlQuery, bucket: SavingsBucketSize): SqlQuery =>
  sql`substr(${column},1,${bucket === "minute" ? sql`16` : sql`10`})`;

/** A string inlined as an SQL literal (a code constant, never input). */
const literal = (text: string): SqlQuery => new SqlQuery([`'${text.replace(/'/g, "''")}'`], []);

// A run "caused a downstream effect" when it created an agent task or started a child workflow run.
const EFFECT = sql`(EXISTS(SELECT 1 FROM agent_tasks k WHERE k."workflowRunId"=r.id) OR EXISTS(SELECT 1 FROM workflow_run_steps s2 JOIN workflow_runs c ON c."parentStepId"=s2.id WHERE s2."runId"=r.id))`;
const AWAITS = sql`(length(source)-length(replace(source,'await','')))/5`;
/** Source that can create an agent task or start a workflow. */
const DISPATCH = sql`(source LIKE '%task_send%' OR source LIKE '%send_task%' OR source LIKE '%sendTask%' OR source LIKE '%workflow_trigger%')`;

export class SqliteSavingsRepository extends BaseSavingsRepository {
  async replaceScriptBucket(b: SavingsScriptBucket): Promise<void> {
    await this.db.run(sql`
      INSERT OR REPLACE INTO automation_savings_daily
        (day, "jobKind", "jobId", "jobKey", "jobName", "subKind", runs, "countedRuns", "effectRuns", "opsSum", "computeSecs", "modelVersion", "computedAt")
      VALUES (${b.day}, 'script', ${b.jobId}, ${b.jobKey}, ${b.jobName}, ${b.subKind}, ${b.runs}, ${b.countedRuns},
        ${b.effectRuns}, ${b.opsSum}, ${b.computeSecs}, ${b.modelVersion}, ${b.computedAt})`);
  }

  async replaceLink(l: SavingsLinkRow): Promise<void> {
    await this.db.run(sql`
      INSERT OR REPLACE INTO automation_savings_links
        (day, "parentJobId", "childKind", "childJobId", "linkKind", n, "actualUsd", "keptUsd", "modelVersion", "computedAt")
      VALUES (${l.day}, ${l.parentJobId}, ${l.childKind}, ${l.childJobId}, ${l.linkKind}, ${l.n}, ${l.actualUsd},
        ${l.keptUsd}, ${l.modelVersion}, ${l.computedAt})`);
  }

  // A one-job read goes through that job's index. Without ANALYZE statistics
  // (production has none) the planner would pick the kind-and-day index and
  // read every job's buckets of the window.
  protected override bucketSource(filter: SavingsBucketFilter): SqlQuery {
    if (filter.kind === "workflow" && filter.jobKey !== undefined) {
      return sql`automation_savings_daily INDEXED BY idx_automation_savings_daily_key`;
    }
    if (filter.kind === "script" && filter.jobId !== undefined) {
      return sql`automation_savings_daily INDEXED BY idx_automation_savings_daily_job`;
    }
    return sql`automation_savings_daily`;
  }

  listScriptAwaitCounts(
    names: string[],
    reader?: SavingsReader,
  ): Promise<{ name: string; aw: number }[]> {
    if (names.length === 0) return Promise.resolve([]);
    return this.via(reader).query(
      sql`SELECT name, ${AWAITS} aw FROM scripts WHERE "isScratch"=0 AND name IN (${sqlList(names)}) ORDER BY scope='global'`,
    );
  }

  async listDispatchingScripts(names: string[], reader?: SavingsReader): Promise<string[]> {
    if (names.length === 0) return [];
    const rows = await this.via(reader).query<{ name: string }>(
      sql`SELECT DISTINCT name FROM scripts WHERE "isScratch"=0 AND name IN (${sqlList(names)}) AND ${DISPATCH}`,
    );
    return rows.map((r) => String(r.name));
  }

  async countWorkflowRunsInSpan(
    workflowId: string,
    span: SavingsSpan,
    reader?: SavingsReader,
  ): Promise<number> {
    // Kept as the exact text the first-day scan has always opened with (unquoted
    // names: SQLite folds identifier case), so a reader can recognise it.
    const query = new SqlQuery(
      [
        "SELECT count(*) n FROM workflow_runs WHERE workflowId=",
        " AND startedAt>=",
        " AND startedAt<",
        "",
      ],
      [workflowId, span.start, span.end],
    );
    const rows = await this.via(reader).query<{ n: number }>(query);
    return Number(rows[0]?.n) || 0;
  }

  workflowRunsByTrigger(
    workflowId: string,
    span: SavingsSpan,
    bucket: SavingsBucketSize,
    reader?: SavingsReader,
  ): Promise<SavingsTriggerRow[]> {
    // Without the hint the planner picks the triggerType index and scans every run.
    return this.via(reader).query(
      sql`SELECT ${bucketOf(sql`r."startedAt"`, bucket)} d, r."triggerType" tt, r.status st, count(*) n FROM workflow_runs r INDEXED BY idx_workflow_runs_workflow_started WHERE r."workflowId"=${workflowId} AND r."startedAt">=${span.start} AND r."startedAt"<${span.end} GROUP BY 1,2,3`,
    );
  }

  workflowScheduledEffectRuns(
    workflowId: string,
    span: SavingsSpan,
    bucket: SavingsBucketSize,
    reader?: SavingsReader,
  ): Promise<SavingsDayCountRow[]> {
    return this.via(reader).query(
      sql`SELECT ${bucketOf(sql`r."startedAt"`, bucket)} d, count(*) n FROM workflow_runs r WHERE r."workflowId"=${workflowId} AND r."startedAt">=${span.start} AND r."startedAt"<${span.end} AND r."triggerType"='schedule' AND r.status NOT IN ('skipped','cancelled') AND ${EFFECT} GROUP BY 1`,
    );
  }

  workflowStepFacts(
    workflowId: string,
    span: SavingsSpan,
    bucket: SavingsBucketSize,
    reader?: SavingsReader,
  ): Promise<SavingsStepFactRow[]> {
    return this.via(reader).query(
      sql`SELECT ${bucketOf(sql`r."startedAt"`, bucket)} d, s."nodeId" nid, count(*) n, sum(CASE WHEN s."nodeType" NOT IN ('agent-task','wait','human-in-the-loop','foreach','sub-workflow') THEN (julianday(coalesce(s."finishedAt",s."startedAt"))-julianday(s."startedAt"))*86400 ELSE 0 END) secs,
      sum(CASE WHEN s."nodeType" LIKE 'system-one%' THEN json_extract(s.output,'$.usage.input_tokens') END) itok,
      sum(CASE WHEN s."nodeType"='raw-llm' THEN length(json_extract(s.output,'$.result')) END) rchars,
      sum(CASE WHEN s."nodeId"='report' THEN json_extract(s.output,'$.result.summary.jevCostUsd') END) jev,
      sum(CASE WHEN s."nodeId"='report' THEN json_extract(s.output,'$.result.cost.clairicUsd') END) clairic
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
      sql`SELECT ${bucketOf(sql`r."startedAt"`, bucket)} d, count(DISTINCT t.id) tasks, sum(c.u) usd, sum(c.ms) ms
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
    return this.via(reader).query(
      sql`SELECT ${bucketOf(sql`r."startedAt"`, bucket)} d, sum(c2."totalCostUsd") fup FROM workflow_runs r JOIN agent_tasks t2 ON t2."workflowRunId"=r.id JOIN agent_tasks k ON k."parentTaskId"=t2.id AND (k.task LIKE 'Worker task completed%' OR k.task LIKE 'Worker task failed%') JOIN session_costs c2 ON c2."taskId"=k.id WHERE r."workflowId"=${workflowId} AND r."startedAt">=${span.start} AND r."startedAt"<${span.end} GROUP BY 1`,
    );
  }

  workflowEffectSteps(
    workflowId: string,
    span: SavingsSpan,
    bucket: SavingsBucketSize,
    reader?: SavingsReader,
  ): Promise<SavingsEffectStepRow[]> {
    return this.via(reader).query(
      sql`WITH e AS (SELECT s."runId" id FROM workflow_runs c INDEXED BY "idx_workflow_runs_parentStep_attempt" JOIN workflow_run_steps s ON s.id=c."parentStepId" JOIN workflow_runs p ON p.id=s."runId"
        WHERE c."parentStepId" IS NOT NULL AND p."workflowId"=${workflowId} AND p."startedAt">=${span.start} AND p."startedAt"<${span.end}
      UNION SELECT k."workflowRunId" FROM agent_tasks k INDEXED BY idx_agent_tasks_workflow_run JOIN workflow_runs p ON p.id=k."workflowRunId" WHERE k."workflowRunId" IS NOT NULL AND p."workflowId"=${workflowId} AND p."startedAt">=${span.start} AND p."startedAt"<${span.end}),
    ed AS (SELECT e.id, ${bucketOf(sql`r."startedAt"`, bucket)} d FROM e JOIN workflow_runs r ON r.id=e.id)
    SELECT d, NULL nid, count(*) n FROM ed GROUP BY d
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
    return this.via(reader).query(
      sql`SELECT ${bucketOf(sql`"startedAt"`, bucket)} d, coalesce("scriptName",${literal(filter.inlineName)}) nm, count(*) n, sum("apiEndpointId" IS NOT NULL) api,
      sum((julianday(coalesce("finishedAt","startedAt"))-julianday("startedAt"))*86400) secs
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
    const tasksTo = sql`strftime('%Y-%m-%dT%H:%M:%fZ',${span.end},'+20 minutes')`;
    const probe =
      dispatchers.length > 0
        ? sql`UNION SELECT ${bucketOf(sql`r."startedAt"`, bucket)} d, r."scriptName" nm, (r."apiEndpointId" IS NOT NULL) api, r.id
        FROM agent_tasks t INDEXED BY idx_agent_tasks_created
        JOIN script_runs r INDEXED BY "idx_script_runs_scriptName_startedAt" ON r."scriptName" IN (${sqlList(dispatchers)})
          AND r."startedAt">=strftime('%Y-%m-%dT%H:%M:%fZ',t."createdAt",'-20 minutes') AND r."startedAt"<=t."createdAt" AND r.output LIKE '%'||t.id||'%'
          AND r."startedAt">=${span.start} AND r."startedAt"<${span.end}
        WHERE t."createdAt">=${span.start} AND t."createdAt"<${tasksTo} AND t."sourceScriptRunId" IS NULL`
        : EMPTY;
    const one =
      filter.scriptName === undefined
        ? EMPTY
        : sql`AND coalesce(r."scriptName", ${filter.inlineName})=${filter.scriptName}`;
    return this.via(reader).query(
      sql`SELECT d, nm, api, count(DISTINCT id) n FROM (
       SELECT ${bucketOf(sql`r."startedAt"`, bucket)} d, coalesce(r."scriptName",${literal(filter.inlineName)}) nm, (r."apiEndpointId" IS NOT NULL) api, r.id
       FROM agent_tasks t INDEXED BY "idx_agent_tasks_sourceScriptRun_created" JOIN script_runs r ON r.id=t."sourceScriptRunId"
       WHERE t."sourceScriptRunId" IS NOT NULL AND t."createdAt">=${span.start} AND t."createdAt"<${tasksTo}
         AND r."startedAt">=${span.start} AND r."startedAt"<${span.end} ${one}
       ${probe}
     ) GROUP BY 1,2,3`,
    );
  }

  subWorkflowLinks(span: SavingsSpan, reader?: SavingsReader): Promise<SavingsWorkflowLinkRow[]> {
    return this.via(reader).query(
      sql`SELECT p."workflowId" pid, c."workflowId" cid, count(*) n FROM workflow_runs c INDEXED BY "idx_workflow_runs_parentStep_attempt"
      JOIN workflow_run_steps s ON s.id=c."parentStepId" JOIN workflow_runs p ON p.id=s."runId"
      WHERE c."parentStepId" IS NOT NULL AND c."startedAt">=${span.start} AND c."startedAt"<${span.end} GROUP BY 1,2`,
    );
  }

  stampedWorkflowLinks(
    span: SavingsSpan,
    reader?: SavingsReader,
  ): Promise<SavingsWorkflowLinkRow[]> {
    return this.via(reader).query(
      sql`SELECT p."workflowId" pid, c."workflowId" cid, count(*) n FROM workflow_runs c INDEXED BY "idx_workflow_runs_sourceStep_started"
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
      sql`SELECT p."workflowId" pid, coalesce(r."scriptName",${literal(inlineName)}) nm, count(*) n FROM script_runs r INDEXED BY "idx_script_runs_sourceStep_started"
      JOIN workflow_run_steps s ON s.id=r."sourceStepId" JOIN workflow_runs p ON p.id=s."runId"
      WHERE r."sourceStepId" IS NOT NULL AND r."startedAt">=${span.start} AND r."startedAt"<${span.end} GROUP BY 1,2`,
    );
  }

  listStepTasks(span: SavingsSpan, reader?: SavingsReader): Promise<SavingsOwnedTaskRow[]> {
    return this.via(reader).query(
      sql`SELECT p."workflowId" pid, t.id FROM agent_tasks t INDEXED BY "idx_agent_tasks_sourceStep_created"
      JOIN workflow_run_steps s ON s.id=t."sourceStepId" JOIN workflow_runs p ON p.id=s."runId"
      WHERE t."sourceStepId" IS NOT NULL AND t."createdAt">=${span.start} AND t."createdAt"<${span.end}`,
    );
  }

  listNodeTasks(span: SavingsSpan, reader?: SavingsReader): Promise<SavingsOwnedTaskRow[]> {
    return this.via(reader).query(
      sql`SELECT p."workflowId" pid, t.id FROM agent_tasks t INDEXED BY idx_agent_tasks_created JOIN workflow_runs p ON p.id=t."workflowRunId"
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
      sql`WITH RECURSIVE r(id) AS (SELECT value FROM json_each(${JSON.stringify(roots)})),
           d(root, id, depth) AS (
             SELECT id, id, 0 FROM r
             UNION ALL SELECT d.root, k.id, d.depth+1 FROM d JOIN agent_tasks k INDEXED BY "idx_agent_tasks_parentTaskId" ON k."parentTaskId"=d.id
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
      nodeIds.map((id) => sql`s."nodeId" LIKE ${`${id}#%`}`),
      sql` OR `,
    );
    return this.via(reader).query(
      sql`SELECT s.id, s."startedAt" sa, coalesce(s."finishedAt",s."startedAt") fa, s.output FROM workflow_runs p INDEXED BY idx_workflow_runs_workflow_started
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
    return this.via(reader).query(
      sql`SELECT s.id AS id, s."numTurns" AS turns, s."durationMs" AS "durationMs",
       json_extract(j.value,'$.inputTokens') AS "inputTokens", json_extract(j.value,'$.outputTokens') AS "outputTokens",
       json_extract(j.value,'$.cacheReadTokens') AS "cacheReadTokens", json_extract(j.value,'$.cacheWriteTokens') AS "cacheWriteTokens",
       json_extract(j.value,'$.costUsd') AS "costUsd", s."totalCostUsd" AS "totalCostUsd"
     FROM session_costs s, json_each(CASE WHEN json_valid(s."modelBreakdown") THEN s."modelBreakdown" ELSE '[]' END) j
     WHERE s.model = ${model} AND json_extract(j.value,'$.model') = ${model} AND s."createdAt" >= ${span.start} AND s."createdAt" < ${span.end}
       AND s."numTurns" BETWEEN 1 AND ${maxTurns} AND s.id > ${after} ORDER BY s.id LIMIT ${limit}`,
    );
  }
}
