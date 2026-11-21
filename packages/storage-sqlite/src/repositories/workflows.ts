import {
  BaseWorkflowsRepository,
  sql,
  sqlList,
  WORKFLOW_RUN_STEP_SLIM_COLUMNS,
  type WorkflowFanoutCandidateRow,
  type WorkflowRow,
  type WorkflowRunStepRow,
} from "@desplega/storage";

// The rowid tie-breaks below spell out the order the SQLite plans returned
// before the move (index order, then insertion order).
export class SqliteWorkflowsRepository extends BaseWorkflowsRepository {
  listEnabledByEventName(eventName: string): Promise<WorkflowRow[]> {
    return this.db.query<WorkflowRow>(sql`
      SELECT w.* FROM workflows w
       WHERE w.enabled = 1
         AND EXISTS (
           SELECT 1 FROM json_each(w.triggers) AS t
           WHERE t.type = 'object'
             AND json_extract(t.value, '$.type') = 'event'
             AND json_extract(t.value, '$.eventName') = ${eventName}
         )
       ORDER BY w."lastUpdatedAt" DESC, w.rowid ASC`);
  }

  async listChildRunIds(parentRunIds: readonly string[]): Promise<string[]> {
    const rows = await this.db.query<{ id: string }>(sql`
      SELECT c.id
        FROM workflow_run_steps s
        JOIN workflow_runs c ON c."parentStepId" = s.id
       WHERE s."runId" IN (${sqlList(parentRunIds)})
       ORDER BY s."runId", s.status, s.rowid, c."parentStepAttempt"`);
    return rows.map((row) => row.id);
  }

  listRunningSubWorkflowSteps(): Promise<{ stepId: string; runId: string; nodeId: string }[]> {
    return this.db.query<{ stepId: string; runId: string; nodeId: string }>(sql`
      SELECT s.id AS "stepId", s."runId" AS "runId", s."nodeId" AS "nodeId"
        FROM workflow_run_steps s
        JOIN workflow_runs r ON r.id = s."runId"
       WHERE s.status = 'running' AND s."nodeType" = 'sub-workflow'
         AND r.status IN ('running', 'waiting')
         AND s.rowid = (
           SELECT MAX(rowid) FROM workflow_run_steps
            WHERE "runId" = s."runId" AND "nodeId" = s."nodeId"
         )
       ORDER BY s.rowid`);
  }

  async listSettledChildRunParentStepIds(): Promise<string[]> {
    const rows = await this.db.query<{ id: string }>(sql`
      SELECT s.id
        FROM workflow_run_steps s
        LEFT JOIN workflow_runs c
          ON c."parentStepId" = s.id AND c."parentStepAttempt" = s."retryCount"
       WHERE s.status = 'waiting' AND s."nodeType" = 'sub-workflow'
         AND (c.id IS NULL OR c.status IN ('completed', 'failed', 'cancelled', 'skipped'))
       ORDER BY s.rowid`);
    return rows.map((row) => row.id);
  }

  listChildRunsOfWorkflow(workflowId: string): Promise<{ id: string; parentStepId: string }[]> {
    return this.db.query<{ id: string; parentStepId: string }>(sql`
      SELECT id, "parentStepId" FROM workflow_runs
       WHERE "workflowId" = ${workflowId} AND "parentStepId" IS NOT NULL
       ORDER BY rowid`);
  }

  async listRunIdsByStatus(status: string): Promise<string[]> {
    const rows = await this.db.query<{ id: string }>(
      sql`SELECT id FROM workflow_runs WHERE status = ${status} ORDER BY rowid`,
    );
    return rows.map((row) => row.id);
  }

  listStepsSlim(runId: string): Promise<WorkflowRunStepRow[]> {
    return this.db.query<WorkflowRunStepRow>(sql`
      SELECT ${WORKFLOW_RUN_STEP_SLIM_COLUMNS} FROM workflow_run_steps
       WHERE "runId" = ${runId} ORDER BY "startedAt" ASC, rowid ASC`);
  }

  listForeachFanoutCandidates(): Promise<WorkflowFanoutCandidateRow[]> {
    return this.db.query<WorkflowFanoutCandidateRow>(sql`
      SELECT s."runId" AS "runId", r."workflowId" AS "workflowId", s.id AS "stepId",
             s."nodeId" AS "nodeId", s.status AS status
        FROM workflow_run_steps s
        JOIN workflow_runs r ON r.id = s."runId"
       WHERE r.status IN ('running', 'waiting')
         AND s.status IN ('pending', 'running')
         AND instr(s."nodeId", '#') > 1
       ORDER BY s.status, s.rowid`);
  }
}
