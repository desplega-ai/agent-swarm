import {
  BaseRetentionRepository,
  type RetentionSweep,
  type WorkflowRunRetentionCandidate,
} from "@desplega/storage";
import { notOnPostgresYet } from "./not-yet";

export class PostgresRetentionRepository extends BaseRetentionRepository {
  countBacklog(sweep: RetentionSweep): Promise<number> {
    return notOnPostgresYet("PostgresRetentionRepository.countBacklog");
  }

  deleteBatch(
    sweep: RetentionSweep,
    limit: number,
  ): Promise<{ changes: number; executionMs: number }> {
    return notOnPostgresYet("PostgresRetentionRepository.deleteBatch");
  }

  listWorkflowRunCandidates(
    cutoff: string,
    limit: number,
    maxDepth: number,
  ): Promise<WorkflowRunRetentionCandidate[]> {
    return notOnPostgresYet("PostgresRetentionRepository.listWorkflowRunCandidates");
  }

  deleteWorkflowRuns(runIds: string[]): Promise<string[]> {
    return notOnPostgresYet("PostgresRetentionRepository.deleteWorkflowRuns");
  }

  incrementalVacuum(pages: number): Promise<void> {
    return notOnPostgresYet("PostgresRetentionRepository.incrementalVacuum");
  }
}
