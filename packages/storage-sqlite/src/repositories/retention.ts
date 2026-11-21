import {
  BaseRetentionRepository,
  type DbParam,
  type RetentionSweep,
  SqlQuery,
  type WorkflowRunRetentionCandidate,
} from "@desplega/storage";

// The statement texts below are exported for the query-plan tests
// (src/tests/*-retention.test.ts), which EXPLAIN the exact text the
// repository runs. Every table and column name comes from code.

/** The backlog COUNT and the batched DELETE for one sweep. */
export type RetentionSweepStatements = {
  backlogSql: string;
  /** Takes `params` followed by the batch LIMIT. */
  deleteSql: string;
  params: Array<string | number>;
};

const TERMINAL_SQL = "('completed', 'failed', 'skipped', 'cancelled')";

/**
 * Retire terminal trees from the root down. A surviving parent step always
 * keeps its child, including children from older attempts. Any live/recent
 * descendant protects the whole tree. Remaining expired children cannot retry
 * after their ancestor is removed (getRunLineageBlock fails closed).
 *
 * The depth guard rejects a truncated traversal, including corrupt cycles.
 * Both recursive joins use incoming-reference indexes; no payload is read.
 * Params: ?1 the cutoff.
 */
function workflowRunEligibleSql(maxDepth: number): string {
  return `r.status IN ${TERMINAL_SQL} AND r.finishedAt < ?1
  AND NOT EXISTS (SELECT 1 FROM workflow_run_steps parent WHERE parent.id = r.parentStepId)
  AND NOT EXISTS (
    WITH RECURSIVE descendants(id, status, finishedAt, depth) AS (
      SELECT r.id, r.status, r.finishedAt, 0
      UNION ALL
      SELECT child.id, child.status, child.finishedAt, descendants.depth + 1
      FROM descendants
      JOIN workflow_run_steps step ON step.runId = descendants.id
      JOIN workflow_runs child ON child.parentStepId = step.id
      WHERE descendants.depth < ${maxDepth}
    )
    SELECT 1 FROM descendants
    WHERE status NOT IN ${TERMINAL_SQL} OR finishedAt IS NULL OR finishedAt >= ?1
      OR depth = ${maxDepth}
  )`;
}

/** Params: ?1 the cutoff, ?2 the batch limit. */
export function workflowRetentionCandidatesSql(maxDepth: number): string {
  return `SELECT r.id, r.definitionHash
  FROM workflow_runs r WHERE ${workflowRunEligibleSql(maxDepth)} ORDER BY r.finishedAt, r.id LIMIT ?2`;
}

export function workflowRunRetentionStatements(
  cutoff: string,
  maxDepth: number,
): RetentionSweepStatements {
  const eligible = workflowRunEligibleSql(maxDepth);
  return {
    backlogSql: `SELECT COUNT(*) AS n FROM workflow_runs r WHERE ${eligible}`,
    // Exposed alongside the other policies for EXPLAIN tests. Execution must
    // use the workflow-run repository methods to unlink dependents atomically.
    deleteSql: `DELETE FROM workflow_runs WHERE id IN (
      SELECT r.id FROM workflow_runs r WHERE ${eligible}
      ORDER BY r.finishedAt, r.id LIMIT ?2
    )`,
    params: [cutoff],
  };
}

export function retentionSweepStatements(sweep: RetentionSweep): RetentionSweepStatements {
  if (sweep.policy === "workflowRuns") {
    return workflowRunRetentionStatements(sweep.cutoff, sweep.maxDepth);
  }
  if (sweep.policy === "keepLatest") {
    // ROW_NUMBER over the (partition, rank DESC) index: rank 1 is the newest
    // row of its group. The DELETE removes the deepest history first, so an
    // interrupted sweep leaves each group's surviving versions contiguous.
    const ranked = `SELECT rowid AS rid, ROW_NUMBER() OVER (PARTITION BY ${sweep.partitionBy} ORDER BY ${sweep.rankBy} DESC) AS rn FROM ${sweep.table}`;
    return {
      backlogSql: `SELECT COUNT(*) AS n FROM (${ranked}) WHERE rn > ?`,
      deleteSql: `DELETE FROM ${sweep.table} WHERE rowid IN (
         SELECT rid FROM (${ranked}) WHERE rn > ? ORDER BY rn DESC LIMIT ?
       )`,
      params: [sweep.keep],
    };
  }
  const conditions: string[] = [];
  const params: Array<string | number> = [];
  if (sweep.terminalStatuses !== undefined) {
    conditions.push(
      `${sweep.statusColumn} IN (${sweep.terminalStatuses.map(() => "?").join(", ")})`,
    );
    params.push(...sweep.terminalStatuses);
  }
  conditions.push(`${sweep.timeColumn} < ?`);
  params.push(sweep.cutoff);
  if (sweep.keepWhenSet !== undefined) {
    conditions.push(
      `rowid NOT IN (SELECT rowid FROM ${sweep.table} WHERE ${sweep.keepWhenSet} IS NOT NULL)`,
    );
  }
  const where = conditions.join(" AND ");
  return {
    backlogSql: `SELECT COUNT(*) AS n FROM ${sweep.table} WHERE ${where}`,
    deleteSql: `DELETE FROM ${sweep.table} WHERE rowid IN (
         SELECT rowid FROM ${sweep.table} WHERE ${where} ORDER BY ${sweep.timeColumn} LIMIT ?
       )`,
    params,
  };
}

/** A `?`-placeholder statement as a query, so the executed text is exactly the constant. */
function fromPlaceholders(text: string, values: DbParam[]): SqlQuery {
  const strings = text.split("?");
  if (strings.length !== values.length + 1) throw new Error("placeholder count mismatch");
  return new SqlQuery(strings, values);
}

export class SqliteRetentionRepository extends BaseRetentionRepository {
  // The workflow-run statements bind numbered parameters (?1, ?2) that the
  // `sql` renderer cannot write, so they go to the client as text. Calls made
  // inside a transaction still join it.

  async countBacklog(sweep: RetentionSweep): Promise<number> {
    const statements = retentionSweepStatements(sweep);
    const row = await this.db.client.get<{ n: number }>(statements.backlogSql, statements.params);
    return row?.n ?? 0;
  }

  async deleteBatch(
    sweep: RetentionSweep,
    limit: number,
  ): Promise<{ changes: number; executionMs: number }> {
    if (sweep.policy === "workflowRuns") {
      throw new Error("workflow runs retire through deleteWorkflowRuns, in one transaction");
    }
    const statements = retentionSweepStatements(sweep);
    return await this.db.runTimed(
      fromPlaceholders(statements.deleteSql, [...statements.params, limit]),
    );
  }

  listWorkflowRunCandidates(
    cutoff: string,
    limit: number,
    maxDepth: number,
  ): Promise<WorkflowRunRetentionCandidate[]> {
    return this.db.client.query<WorkflowRunRetentionCandidate>(
      workflowRetentionCandidatesSql(maxDepth),
      [cutoff, limit],
    );
  }

  async deleteWorkflowRuns(runIds: string[]): Promise<string[]> {
    const ids = JSON.stringify(runIds);
    const runIdsSql = "SELECT value FROM json_each(?)";
    const stepIds = `SELECT id FROM workflow_run_steps WHERE runId IN (${runIdsSql})`;
    const taskWhere = `workflowRunId IN (${runIdsSql}) OR workflowRunStepId IN (${stepIds})`;
    const tasks = await this.db.query<{ id: string }>(
      fromPlaceholders(`SELECT id FROM agent_tasks WHERE ${taskWhere}`, [ids, ids]),
    );
    await this.db.run(
      fromPlaceholders(
        `UPDATE agent_tasks SET workflowRunId = NULL, workflowRunStepId = NULL WHERE ${taskWhere}`,
        [ids, ids],
      ),
    );
    // These logical dependents have no ON DELETE action. Remove them before
    // their steps so pollers cannot keep trying to resume deleted history.
    for (const table of ["approval_requests", "wait_states"] as const) {
      await this.db.run(
        fromPlaceholders(
          `DELETE FROM ${table} WHERE workflowRunId IN (${runIdsSql}) OR workflowRunStepId IN (${stepIds})`,
          [ids, ids],
        ),
      );
    }
    await this.db.run(
      fromPlaceholders(`DELETE FROM workflow_run_steps WHERE runId IN (${runIdsSql})`, [ids]),
    );
    await this.db.run(
      fromPlaceholders(`DELETE FROM workflow_runs WHERE id IN (${runIdsSql})`, [ids]),
    );
    return tasks.map((task) => task.id);
  }

  async incrementalVacuum(pages: number): Promise<void> {
    if (!Number.isSafeInteger(pages) || pages < 0) throw new Error(`invalid page count ${pages}`);
    // Harmless when auto_vacuum is not INCREMENTAL; never a blocking VACUUM.
    await this.db.run(new SqlQuery([`PRAGMA incremental_vacuum(${pages})`], []));
  }
}
