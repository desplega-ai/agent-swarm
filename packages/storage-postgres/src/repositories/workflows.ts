import {
  type ApprovalListFilter,
  type ApprovalRequestSummaryRow,
  type AutomationPreflightRowText,
  BaseWorkflowsRepository,
  type SqlQuery,
  type StuckWorkflowRunRow,
  type WorkflowFanoutCandidateRow,
  type WorkflowRow,
  type WorkflowRunStepRow,
} from "@desplega/storage";
import { notOnPostgresYet } from "./not-yet";

export class PostgresWorkflowsRepository extends BaseWorkflowsRepository {
  listEnabledByEventName(eventName: string): Promise<WorkflowRow[]> {
    return notOnPostgresYet("PostgresWorkflowsRepository.listEnabledByEventName");
  }

  listChildRunIds(parentRunIds: readonly string[]): Promise<string[]> {
    return notOnPostgresYet("PostgresWorkflowsRepository.listChildRunIds");
  }

  listRunningSubWorkflowSteps(): Promise<{ stepId: string; runId: string; nodeId: string }[]> {
    return notOnPostgresYet("PostgresWorkflowsRepository.listRunningSubWorkflowSteps");
  }

  listSettledChildRunParentStepIds(): Promise<string[]> {
    return notOnPostgresYet("PostgresWorkflowsRepository.listSettledChildRunParentStepIds");
  }

  listChildRunsOfWorkflow(workflowId: string): Promise<{ id: string; parentStepId: string }[]> {
    return notOnPostgresYet("PostgresWorkflowsRepository.listChildRunsOfWorkflow");
  }

  listRunIdsByStatus(status: string): Promise<string[]> {
    return notOnPostgresYet("PostgresWorkflowsRepository.listRunIdsByStatus");
  }

  listStepsSlim(runId: string): Promise<WorkflowRunStepRow[]> {
    return notOnPostgresYet("PostgresWorkflowsRepository.listStepsSlim");
  }

  listForeachFanoutCandidates(): Promise<WorkflowFanoutCandidateRow[]> {
    return notOnPostgresYet("PostgresWorkflowsRepository.listForeachFanoutCandidates");
  }

  protected insertionOrder(alias?: SqlQuery): SqlQuery {
    return notOnPostgresYet("PostgresWorkflowsRepository.insertionOrder");
  }

  protected offsetWithoutLimit(offset: number): SqlQuery {
    return notOnPostgresYet("PostgresWorkflowsRepository.offsetWithoutLimit");
  }

  listEnabledByScheduleId(scheduleId: string): Promise<WorkflowRow[]> {
    return notOnPostgresYet("PostgresWorkflowsRepository.listEnabledByScheduleId");
  }

  listStuckRuns(): Promise<StuckWorkflowRunRow[]> {
    return notOnPostgresYet("PostgresWorkflowsRepository.listStuckRuns");
  }

  hasCompletedStepInsertedAfter(
    runId: string,
    nodeIds: readonly string[],
    afterStepId: string,
  ): Promise<boolean> {
    return notOnPostgresYet("PostgresWorkflowsRepository.hasCompletedStepInsertedAfter");
  }

  listApprovalSummaries(filter: ApprovalListFilter): Promise<ApprovalRequestSummaryRow[]> {
    return notOnPostgresYet("PostgresWorkflowsRepository.listApprovalSummaries");
  }

  listEnabledPreflightRows(): Promise<AutomationPreflightRowText[]> {
    return notOnPostgresYet("PostgresWorkflowsRepository.listEnabledPreflightRows");
  }
}
