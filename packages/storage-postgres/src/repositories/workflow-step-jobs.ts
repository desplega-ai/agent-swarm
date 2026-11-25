import { BaseWorkflowStepJobsRepository, sql } from "@desplega/storage";

export class PostgresWorkflowStepJobsRepository extends BaseWorkflowStepJobsRepository {
  protected override claimLock() {
    return sql`FOR UPDATE SKIP LOCKED`;
  }
}
