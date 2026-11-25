import type { SqlExecutor } from "../executor";
import { sql } from "../sql";

export type WorkflowStepJob = {
  id: string;
  runId: string;
  stepId: string;
  attempt: number;
  kind: string;
  status: "queued" | "running" | "completed" | "failed" | "cancelled";
  ownerId: string | null;
  leaseExpiresAt: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
  createdBy: string | null;
  updatedBy: string | null;
};

export interface WorkflowStepJobsRepository {
  insert(row: WorkflowStepJob): Promise<void>;
  get(id: string): Promise<WorkflowStepJob | null>;
  claim(ownerId: string, now: string, leaseExpiresAt: string): Promise<WorkflowStepJob | null>;
  renew(id: string, ownerId: string, now: string, leaseExpiresAt: string): Promise<boolean>;
  settle(
    id: string,
    ownerId: string,
    now: string,
    status: "completed" | "failed",
    error: string | null,
  ): Promise<boolean>;
  cancelRun(runId: string, now: string): Promise<WorkflowStepJob[]>;
  listOpen(runId: string): Promise<WorkflowStepJob[]>;
}

const COLUMNS = sql`id, run_id AS "runId", step_id AS "stepId", attempt, kind, status,
  owner_id AS "ownerId", lease_expires_at AS "leaseExpiresAt", error,
  created_at AS "createdAt", updated_at AS "updatedAt", created_by AS "createdBy", updated_by AS "updatedBy"`;

export class BaseWorkflowStepJobsRepository implements WorkflowStepJobsRepository {
  constructor(protected readonly db: SqlExecutor) {}

  async insert(row: WorkflowStepJob): Promise<void> {
    await this.db.run(sql`INSERT INTO workflow_step_jobs
      (id, run_id, step_id, attempt, kind, status, owner_id, lease_expires_at, error,
       created_at, updated_at, created_by, updated_by)
      VALUES (${row.id}, ${row.runId}, ${row.stepId}, ${row.attempt}, ${row.kind}, 'queued',
        NULL, NULL, NULL, ${row.createdAt}, ${row.updatedAt}, ${row.createdBy}, ${row.updatedBy})`);
  }

  get(id: string): Promise<WorkflowStepJob | null> {
    return this.db.get<WorkflowStepJob>(
      sql`SELECT ${COLUMNS} FROM workflow_step_jobs WHERE id = ${id}`,
    );
  }

  protected claimLock() {
    return sql``;
  }

  claim(ownerId: string, now: string, leaseExpiresAt: string): Promise<WorkflowStepJob | null> {
    return this.db.transaction(async () => {
      const row = await this.db.get<WorkflowStepJob>(sql`SELECT ${COLUMNS} FROM workflow_step_jobs j
        WHERE (status = 'queued' OR (status = 'running' AND lease_expires_at <= ${now}))
        AND EXISTS (SELECT 1 FROM workflow_run_steps s WHERE s.id = j.step_id
          AND s.status = 'waiting' AND s."retryCount" = j.attempt)
        AND EXISTS (SELECT 1 FROM workflow_runs r WHERE r.id = j.run_id AND r.status IN ('running','waiting'))
        ORDER BY created_at, id LIMIT 1 ${this.claimLock()}`);
      if (!row) return null;
      await this.db.run(sql`UPDATE workflow_step_jobs SET status = 'running', owner_id = ${ownerId},
        lease_expires_at = ${leaseExpiresAt}, updated_at = ${now}, updated_by = ${ownerId} WHERE id = ${row.id}`);
      return {
        ...row,
        status: "running",
        ownerId,
        leaseExpiresAt,
        updatedAt: now,
        updatedBy: ownerId,
      };
    });
  }

  async renew(id: string, ownerId: string, now: string, leaseExpiresAt: string): Promise<boolean> {
    const result =
      await this.db.run(sql`UPDATE workflow_step_jobs SET lease_expires_at = ${leaseExpiresAt},
      updated_at = ${now}, updated_by = ${ownerId} WHERE id = ${id} AND status = 'running'
      AND owner_id = ${ownerId} AND lease_expires_at > ${now}`);
    return result.changes > 0;
  }

  async settle(
    id: string,
    ownerId: string,
    now: string,
    status: "completed" | "failed",
    error: string | null,
  ): Promise<boolean> {
    const result =
      await this.db.run(sql`UPDATE workflow_step_jobs SET status = ${status}, error = ${error},
      lease_expires_at = NULL, updated_at = ${now}, updated_by = ${ownerId}
      WHERE id = ${id} AND status = 'running' AND owner_id = ${ownerId} AND lease_expires_at > ${now}`);
    return result.changes > 0;
  }

  cancelRun(runId: string, now: string): Promise<WorkflowStepJob[]> {
    return this.db.query<WorkflowStepJob>(sql`UPDATE workflow_step_jobs SET status = 'cancelled',
      lease_expires_at = NULL, updated_at = ${now} WHERE run_id = ${runId} AND status IN ('queued','running')
      RETURNING ${COLUMNS}`);
  }

  listOpen(runId: string): Promise<WorkflowStepJob[]> {
    return this.db.query<WorkflowStepJob>(sql`SELECT ${COLUMNS} FROM workflow_step_jobs
      WHERE run_id = ${runId} AND status IN ('queued','running') ORDER BY created_at, id`);
  }
}
