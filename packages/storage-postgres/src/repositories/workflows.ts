import {
  type ApprovalListFilter,
  type ApprovalRequestSummaryRow,
  type AutomationPreflightRowText,
  BaseWorkflowsRepository,
  type SqlQuery,
  type StuckWorkflowRunRow,
  sql,
  sqlList,
  WORKFLOW_RUN_STEP_SLIM_COLUMNS,
  type WorkflowFanoutCandidateRow,
  type WorkflowRow,
  type WorkflowRunStepRow,
} from "@desplega/storage";

/**
 * `"_rowid"` is the SQLite rowid (insertion order). SQLite's json_each walks
 * an array's elements and an object's members; a stored trigger list is an
 * array, and anything else matches nothing here as it matches no trigger
 * shape on SQLite.
 */
const TRIGGERS = sql`(CASE WHEN jsonb_typeof(w.triggers) = 'array' THEN w.triggers ELSE '[]'::jsonb END)`;

export class PostgresWorkflowsRepository extends BaseWorkflowsRepository {
  listEnabledByEventName(eventName: string): Promise<WorkflowRow[]> {
    return this.db.query<WorkflowRow>(sql`
      SELECT w.* FROM workflows w
       WHERE w.enabled = ${true}
         AND EXISTS (
           SELECT 1 FROM jsonb_array_elements(${TRIGGERS}) AS t(value)
           WHERE jsonb_typeof(t.value) = 'object'
             AND t.value->>'type' = 'event'
             AND t.value->>'eventName' = ${eventName}
         )
       ORDER BY w."lastUpdatedAt" DESC, w."_rowid" ASC`);
  }

  async listChildRunIds(parentRunIds: readonly string[]): Promise<string[]> {
    const rows = await this.db.query<{ id: string }>(sql`
      SELECT c.id
        FROM workflow_run_steps s
        JOIN workflow_runs c ON c."parentStepId" = s.id
       WHERE s."runId" IN (${sqlList(parentRunIds)})
       ORDER BY s."runId", s.status, s."_rowid", c."parentStepAttempt"`);
    return rows.map((row) => row.id);
  }

  listRunningSubWorkflowSteps(): Promise<{ stepId: string; runId: string; nodeId: string }[]> {
    return this.db.query<{ stepId: string; runId: string; nodeId: string }>(sql`
      SELECT s.id AS "stepId", s."runId" AS "runId", s."nodeId" AS "nodeId"
        FROM workflow_run_steps s
        JOIN workflow_runs r ON r.id = s."runId"
       WHERE s.status = 'running' AND s."nodeType" = 'sub-workflow'
         AND r.status IN ('running', 'waiting')
         AND s."_rowid" = (
           SELECT MAX("_rowid") FROM workflow_run_steps
            WHERE "runId" = s."runId" AND "nodeId" = s."nodeId"
         )
       ORDER BY s."_rowid"`);
  }

  async listSettledChildRunParentStepIds(): Promise<string[]> {
    const rows = await this.db.query<{ id: string }>(sql`
      SELECT s.id
        FROM workflow_run_steps s
        LEFT JOIN workflow_runs c
          ON c."parentStepId" = s.id AND c."parentStepAttempt" = s."retryCount"
       WHERE s.status = 'waiting' AND s."nodeType" = 'sub-workflow'
         AND (c.id IS NULL OR c.status IN ('completed', 'failed', 'cancelled', 'skipped'))
       ORDER BY s."_rowid"`);
    return rows.map((row) => row.id);
  }

  listChildRunsOfWorkflow(workflowId: string): Promise<{ id: string; parentStepId: string }[]> {
    return this.db.query<{ id: string; parentStepId: string }>(sql`
      SELECT id, "parentStepId" FROM workflow_runs
       WHERE "workflowId" = ${workflowId} AND "parentStepId" IS NOT NULL
       ORDER BY "_rowid"`);
  }

  async listRunIdsByStatus(status: string): Promise<string[]> {
    const rows = await this.db.query<{ id: string }>(
      sql`SELECT id FROM workflow_runs WHERE status = ${status} ORDER BY "_rowid"`,
    );
    return rows.map((row) => row.id);
  }

  listStepsSlim(runId: string): Promise<WorkflowRunStepRow[]> {
    return this.db.query<WorkflowRunStepRow>(sql`
      SELECT ${WORKFLOW_RUN_STEP_SLIM_COLUMNS} FROM workflow_run_steps
       WHERE "runId" = ${runId} ORDER BY "startedAt" ASC, "_rowid" ASC`);
  }

  listForeachFanoutCandidates(): Promise<WorkflowFanoutCandidateRow[]> {
    return this.db.query<WorkflowFanoutCandidateRow>(sql`
      SELECT s."runId" AS "runId", r."workflowId" AS "workflowId", s.id AS "stepId",
             s."nodeId" AS "nodeId", s.status AS status
        FROM workflow_run_steps s
        JOIN workflow_runs r ON r.id = s."runId"
       WHERE r.status IN ('running', 'waiting')
         AND s.status IN ('pending', 'running')
         AND strpos(s."nodeId", '#') > 1
       ORDER BY s.status, s."_rowid"`);
  }

  protected insertionOrder(alias?: SqlQuery): SqlQuery {
    return alias ? sql`${alias}."_rowid"` : sql`"_rowid"`;
  }

  protected offsetWithoutLimit(offset: number): SqlQuery {
    return sql`OFFSET ${offset}`;
  }

  listEnabledByScheduleId(scheduleId: string): Promise<WorkflowRow[]> {
    return this.db.query<WorkflowRow>(sql`
      SELECT w.* FROM workflows w
       CROSS JOIN LATERAL jsonb_array_elements(${TRIGGERS}) WITH ORDINALITY AS t(value, ord)
       WHERE w.enabled = ${true}
         AND t.value->>'type' = 'schedule'
         AND t.value->>'scheduleId' = ${scheduleId}
       ORDER BY w."_rowid", t.ord`);
  }

  listStuckRuns(): Promise<StuckWorkflowRunRow[]> {
    return this.db.query<StuckWorkflowRunRow>(sql`
      SELECT
          wr.id as "runId",
          wrs.id as "stepId",
          wrs."nodeId",
          at.id as "taskId",
          at.status as "taskStatus",
          at.output as "taskOutput",
          wr."workflowId"
        FROM workflow_run_steps wrs
        JOIN workflow_runs wr ON wr.id = wrs."runId"
        JOIN agent_tasks at ON at."workflowRunStepId" = wrs.id
        WHERE wrs.status = 'waiting'
          AND wr.status = 'waiting'
          AND at.status IN ('completed', 'failed', 'cancelled', 'skipped')
        ORDER BY at."createdAt" ASC, at."_rowid" ASC`);
  }

  async hasCompletedStepInsertedAfter(
    runId: string,
    nodeIds: readonly string[],
    afterStepId: string,
  ): Promise<boolean> {
    const row = await this.db.get(sql`
      SELECT 1 AS found FROM workflow_run_steps
       WHERE "runId" = ${runId} AND status = 'completed'
         AND "nodeId" IN (${sqlList(nodeIds)})
         AND "_rowid" > (SELECT "_rowid" FROM workflow_run_steps WHERE id = ${afterStepId})
       LIMIT 1`);
    return row != null;
  }

  listApprovalSummaries(f: ApprovalListFilter): Promise<ApprovalRequestSummaryRow[]> {
    // json_array_length is 0 for a JSON value that is not an array.
    return this.db.query<ApprovalRequestSummaryRow>(sql`
      SELECT id, title, "workflowRunId", "workflowRunStepId", "sourceTaskId", status, "resolvedBy",
             "resolvedAt", "timeoutSeconds", "expiresAt", created_by, "createdAt", "updatedAt",
             (CASE WHEN jsonb_typeof(questions) = 'array' THEN jsonb_array_length(questions) ELSE 0 END)
               AS "questionCount"
        FROM approval_requests${this.approvalListTail(f)}`);
  }

  listEnabledPreflightRows(): Promise<AutomationPreflightRowText[]> {
    return this.db.query<AutomationPreflightRowText>(sql`
      SELECT id, name, 'workflow' AS kind, params, "requiredParams", requires
        FROM workflows WHERE enabled = ${true} ORDER BY "_rowid"`);
  }
}
