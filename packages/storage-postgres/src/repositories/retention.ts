import {
  BaseRetentionRepository,
  jsonText,
  type RetentionSweep,
  SqlQuery,
  sql,
  sqlIdent,
  sqlJoin,
  sqlList,
  type WorkflowRunRetentionCandidate,
} from "@desplega/storage";

// Table and column names come from code (the closed policy list in
// `src/be/db-retention.ts`); `sqlIdent` quotes them so camelCase names keep
// their case. `_rowid` stands for SQLite's rowid (schema notes section 3).

const TERMINAL = sql`('completed', 'failed', 'skipped', 'cancelled')`;

function depthLimit(maxDepth: number): SqlQuery {
  if (!Number.isSafeInteger(maxDepth) || maxDepth < 0) {
    throw new Error(`invalid workflow run depth ${maxDepth}`);
  }
  return new SqlQuery([String(maxDepth)], []);
}

/** The SQLite `workflowRunEligibleSql`, with the cutoff bound at each use. */
function workflowRunEligible(cutoff: string, maxDepth: number): SqlQuery {
  const depth = depthLimit(maxDepth);
  return sql`r.status IN ${TERMINAL} AND r."finishedAt" < ${cutoff}
  AND NOT EXISTS (SELECT 1 FROM workflow_run_steps parent WHERE parent.id = r."parentStepId")
  AND NOT EXISTS (
    WITH RECURSIVE descendants(id, status, "finishedAt", depth) AS (
      SELECT r.id, r.status, r."finishedAt", 0
      UNION ALL
      SELECT child.id, child.status, child."finishedAt", descendants.depth + 1
      FROM descendants
      JOIN workflow_run_steps step ON step."runId" = descendants.id
      JOIN workflow_runs child ON child."parentStepId" = step.id
      WHERE descendants.depth < ${depth}
    )
    SELECT 1 FROM descendants
    WHERE status NOT IN ${TERMINAL} OR "finishedAt" IS NULL OR "finishedAt" >= ${cutoff}
      OR depth = ${depth}
  )`;
}

/** `agentId, field` -> `"agentId", "field"`. */
function columnList(list: string): SqlQuery {
  return sqlJoin(
    list.split(",").map((name) => sql`${sqlIdent(name.trim())}`),
    sql`, `,
  );
}

type AgeSweep = Extract<RetentionSweep, { policy: "age" }>;

function ageWhere(sweep: AgeSweep): SqlQuery {
  const table = sqlIdent(sweep.table);
  const conditions: SqlQuery[] = [];
  if (sweep.terminalStatuses !== undefined && sweep.statusColumn !== undefined) {
    conditions.push(
      sql`${sqlIdent(sweep.statusColumn)} IN (${sqlList([...sweep.terminalStatuses])})`,
    );
  }
  conditions.push(sql`${sqlIdent(sweep.timeColumn)} < ${sweep.cutoff}`);
  if (sweep.keepWhenSet !== undefined) {
    conditions.push(
      sql`"_rowid" NOT IN (SELECT "_rowid" FROM ${table} WHERE ${sqlIdent(sweep.keepWhenSet)} IS NOT NULL)`,
    );
  }
  return sqlJoin(conditions, sql` AND `);
}

type KeepLatestSweep = Extract<RetentionSweep, { policy: "keepLatest" }>;

function ranked(sweep: KeepLatestSweep): SqlQuery {
  return sql`SELECT "_rowid" AS rid, ROW_NUMBER() OVER (PARTITION BY ${columnList(sweep.partitionBy)} ORDER BY ${sqlIdent(sweep.rankBy)} DESC) AS rn FROM ${sqlIdent(sweep.table)}`;
}

export class PostgresRetentionRepository extends BaseRetentionRepository {
  async countBacklog(sweep: RetentionSweep): Promise<number> {
    let query: SqlQuery;
    if (sweep.policy === "workflowRuns") {
      query = sql`SELECT COUNT(*) AS n FROM workflow_runs r WHERE ${workflowRunEligible(sweep.cutoff, sweep.maxDepth)}`;
    } else if (sweep.policy === "keepLatest") {
      query = sql`SELECT COUNT(*) AS n FROM (${ranked(sweep)}) ranked WHERE rn > ${sweep.keep}`;
    } else {
      query = sql`SELECT COUNT(*) AS n FROM ${sqlIdent(sweep.table)} WHERE ${ageWhere(sweep)}`;
    }
    const row = await this.db.get<{ n: number }>(query);
    return Number(row?.n ?? 0);
  }

  async deleteBatch(
    sweep: RetentionSweep,
    limit: number,
  ): Promise<{ changes: number; executionMs: number }> {
    if (sweep.policy === "workflowRuns") {
      throw new Error("workflow runs retire through deleteWorkflowRuns, in one transaction");
    }
    const table = sqlIdent(sweep.table);
    if (sweep.policy === "keepLatest") {
      return await this.db.runTimed(sql`DELETE FROM ${table} WHERE "_rowid" IN (
         SELECT rid FROM (${ranked(sweep)}) ranked WHERE rn > ${sweep.keep} ORDER BY rn DESC LIMIT ${limit}
       )`);
    }
    return await this.db.runTimed(sql`DELETE FROM ${table} WHERE "_rowid" IN (
         SELECT "_rowid" FROM ${table} WHERE ${ageWhere(sweep)} ORDER BY ${sqlIdent(sweep.timeColumn)}, "_rowid" LIMIT ${limit}
       )`);
  }

  listWorkflowRunCandidates(
    cutoff: string,
    limit: number,
    maxDepth: number,
  ): Promise<WorkflowRunRetentionCandidate[]> {
    return this.db.query<WorkflowRunRetentionCandidate>(sql`SELECT r.id, r."definitionHash"
  FROM workflow_runs r WHERE ${workflowRunEligible(cutoff, maxDepth)} ORDER BY r."finishedAt", r.id LIMIT ${limit}`);
  }

  async deleteWorkflowRuns(runIds: string[]): Promise<string[]> {
    const ids = JSON.stringify(runIds);
    const runIdsSql = () => sql`SELECT jsonb_array_elements_text(${jsonText(ids)})`;
    const stepIds = () => sql`SELECT id FROM workflow_run_steps WHERE "runId" IN (${runIdsSql()})`;
    const taskWhere = () =>
      sql`"workflowRunId" IN (${runIdsSql()}) OR "workflowRunStepId" IN (${stepIds()})`;
    const tasks = await this.db.query<{ id: string }>(
      sql`SELECT id FROM agent_tasks WHERE ${taskWhere()}`,
    );
    await this.db.run(
      sql`UPDATE agent_tasks SET "workflowRunId" = NULL, "workflowRunStepId" = NULL WHERE ${taskWhere()}`,
    );
    // These logical dependents have no ON DELETE action. Remove them before
    // their steps so pollers cannot keep trying to resume deleted history.
    for (const table of ["approval_requests", "wait_states"] as const) {
      await this.db.run(
        sql`DELETE FROM ${sqlIdent(table)} WHERE "workflowRunId" IN (${runIdsSql()}) OR "workflowRunStepId" IN (${stepIds()})`,
      );
    }
    await this.db.run(sql`DELETE FROM workflow_run_steps WHERE "runId" IN (${runIdsSql()})`);
    await this.db.run(sql`DELETE FROM workflow_runs WHERE id IN (${runIdsSql()})`);
    return tasks.map((task) => task.id);
  }

  async incrementalVacuum(pages: number): Promise<void> {
    if (!Number.isSafeInteger(pages) || pages < 0) throw new Error(`invalid page count ${pages}`);
    // Postgres returns free space through autovacuum; a plain VACUUM cannot
    // run inside a transaction block and is never issued from a sweep.
  }
}
