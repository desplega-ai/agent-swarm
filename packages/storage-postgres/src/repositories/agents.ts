import {
  type AgentHistoryRow,
  type AgentLogRow,
  type AgentRow,
  BaseAgentsRepository,
  type ContextVersionRow,
  type ServiceRow,
} from "@desplega/storage";
import { notOnPostgresYet } from "./not-yet";

export class PostgresAgentsRepository extends BaseAgentsRepository {
  listAgents(opts: { includeExtensions: boolean }): Promise<AgentRow[]> {
    return notOnPostgresYet("PostgresAgentsRepository.listAgents");
  }

  listAgentsByHarnessProvider(provider: string): Promise<AgentRow[]> {
    return notOnPostgresYet("PostgresAgentsRepository.listAgentsByHarnessProvider");
  }

  dailyTaskCounts(agentId: string, sinceDay: string): Promise<{ date: string; count: number }[]> {
    return notOnPostgresYet("PostgresAgentsRepository.dailyTaskCounts");
  }

  listAgentColumns(): Promise<string[]> {
    return notOnPostgresYet("PostgresAgentsRepository.listAgentColumns");
  }

  latestHistory(agentId: string): Promise<AgentHistoryRow | null> {
    return notOnPostgresYet("PostgresAgentsRepository.latestHistory");
  }

  listHistory(agentId: string | undefined, limit: number): Promise<AgentHistoryRow[]> {
    return notOnPostgresYet("PostgresAgentsRepository.listHistory");
  }

  listLogsByTask(taskId: string, limit: number): Promise<AgentLogRow[]> {
    return notOnPostgresYet("PostgresAgentsRepository.listLogsByTask");
  }

  listLogsByTaskChronological(taskId: string, eventType?: string): Promise<AgentLogRow[]> {
    return notOnPostgresYet("PostgresAgentsRepository.listLogsByTaskChronological");
  }

  listLogsByEventType(eventType: string): Promise<AgentLogRow[]> {
    return notOnPostgresYet("PostgresAgentsRepository.listLogsByEventType");
  }

  listServices(filters: {
    agentId?: string;
    nameLike?: string;
    status?: string;
  }): Promise<ServiceRow[]> {
    return notOnPostgresYet("PostgresAgentsRepository.listServices");
  }

  latestContextVersion(agentId: string, field: string): Promise<ContextVersionRow | null> {
    return notOnPostgresYet("PostgresAgentsRepository.latestContextVersion");
  }

  listContextVersions(
    agentId: string,
    field: string | undefined,
    limit: number,
  ): Promise<ContextVersionRow[]> {
    return notOnPostgresYet("PostgresAgentsRepository.listContextVersions");
  }

  listAgentNames(): Promise<(string | null)[]> {
    return notOnPostgresYet("PostgresAgentsRepository.listAgentNames");
  }
}
