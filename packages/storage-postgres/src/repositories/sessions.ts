import {
  BaseSessionsRepository,
  type BudgetRefusalNotificationRow,
  type KeyCostSummaryRow,
  type NewBudgetRefusalNotification,
  type RequestCompositionRow,
  type SessionCostAgentSummaryRow,
  type SessionCostCredentialSummaryRow,
  type SessionCostDailySummaryRow,
  type SessionCostFilter,
  type SessionCostRow,
  type SessionCostSummaryFilter,
  type SessionCostTotalsRow,
  type SessionCostUserSummaryRow,
  type SessionLogRow,
  type SessionShareRow,
  type SessionSummaryDriftRow,
  type TaskAncestorRow,
} from "@desplega/storage";
import { notOnPostgresYet } from "./not-yet";

export class PostgresSessionsRepository extends BaseSessionsRepository {
  lastLogLineNumber(sessionId: string, iteration: number): Promise<number | null> {
    return notOnPostgresYet("PostgresSessionsRepository.lastLogLineNumber");
  }

  listClaudeReasoningLines(
    sessionId: string,
    since: string,
  ): Promise<{ id: string; lineNumber: number; messageId: string | null }[]> {
    return notOnPostgresYet("PostgresSessionsRepository.listClaudeReasoningLines");
  }

  listChainWithCosts(
    rootTaskId: string,
  ): Promise<(Record<string, unknown> & { totalCostUsd: number | null })[]> {
    return notOnPostgresYet("PostgresSessionsRepository.listChainWithCosts");
  }

  listLogsByTask(taskId: string, limit?: number): Promise<SessionLogRow[]> {
    return notOnPostgresYet("PostgresSessionsRepository.listLogsByTask");
  }

  listLogsBySession(sessionId: string, iteration: number): Promise<SessionLogRow[]> {
    return notOnPostgresYet("PostgresSessionsRepository.listLogsBySession");
  }

  listSessionCostsByTask(taskId: string, limit: number): Promise<SessionCostRow[]> {
    return notOnPostgresYet("PostgresSessionsRepository.listSessionCostsByTask");
  }

  listSessionCostsByAgent(agentId: string, limit: number): Promise<SessionCostRow[]> {
    return notOnPostgresYet("PostgresSessionsRepository.listSessionCostsByAgent");
  }

  listSessionCosts(filter: SessionCostFilter): Promise<SessionCostRow[]> {
    return notOnPostgresYet("PostgresSessionsRepository.listSessionCosts");
  }

  costSummaryTotals(filter: SessionCostSummaryFilter): Promise<SessionCostTotalsRow | null> {
    return notOnPostgresYet("PostgresSessionsRepository.costSummaryTotals");
  }

  costSummaryDaily(filter: SessionCostSummaryFilter): Promise<SessionCostDailySummaryRow[]> {
    return notOnPostgresYet("PostgresSessionsRepository.costSummaryDaily");
  }

  costSummaryByAgent(filter: SessionCostSummaryFilter): Promise<SessionCostAgentSummaryRow[]> {
    return notOnPostgresYet("PostgresSessionsRepository.costSummaryByAgent");
  }

  costSummaryByUser(filter: SessionCostSummaryFilter): Promise<SessionCostUserSummaryRow[]> {
    return notOnPostgresYet("PostgresSessionsRepository.costSummaryByUser");
  }

  costSummaryByCredential(
    filter: SessionCostSummaryFilter,
  ): Promise<SessionCostCredentialSummaryRow[]> {
    return notOnPostgresYet("PostgresSessionsRepository.costSummaryByCredential");
  }

  keyCostSummary(keyType?: string): Promise<KeyCostSummaryRow[]> {
    return notOnPostgresYet("PostgresSessionsRepository.keyCostSummary");
  }

  dailySpendForAgent(agentId: string, dateUtc: string): Promise<number> {
    return notOnPostgresYet("PostgresSessionsRepository.dailySpendForAgent");
  }

  dailySpendGlobal(dateUtc: string): Promise<number> {
    return notOnPostgresYet("PostgresSessionsRepository.dailySpendGlobal");
  }

  dailySpendForUser(userId: string, dateUtc: string): Promise<number> {
    return notOnPostgresYet("PostgresSessionsRepository.dailySpendForUser");
  }

  listRequestCompositionsByTask(taskId: string, limit: number): Promise<RequestCompositionRow[]> {
    return notOnPostgresYet("PostgresSessionsRepository.listRequestCompositionsByTask");
  }

  findSessionSummaryDrift(
    since: string | null,
    terminalStatuses: readonly string[],
  ): Promise<SessionSummaryDriftRow[]> {
    return notOnPostgresYet("PostgresSessionsRepository.findSessionSummaryDrift");
  }

  listTaskAncestors(taskIds: readonly string[]): Promise<TaskAncestorRow[]> {
    return notOnPostgresYet("PostgresSessionsRepository.listTaskAncestors");
  }

  listActiveShares(rootTaskId: string): Promise<SessionShareRow[]> {
    return notOnPostgresYet("PostgresSessionsRepository.listActiveShares");
  }

  listShareHistory(rootTaskId: string): Promise<SessionShareRow[]> {
    return notOnPostgresYet("PostgresSessionsRepository.listShareHistory");
  }

  insertBudgetRefusalNotification(row: NewBudgetRefusalNotification): Promise<number> {
    return notOnPostgresYet("PostgresSessionsRepository.insertBudgetRefusalNotification");
  }

  listRecentBudgetRefusalNotifications(limit: number): Promise<BudgetRefusalNotificationRow[]> {
    return notOnPostgresYet("PostgresSessionsRepository.listRecentBudgetRefusalNotifications");
  }
}
