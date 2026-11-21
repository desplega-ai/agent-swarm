import {
  BaseMessagingRepository,
  type PendingChatRelayRow,
  type SqlQuery,
  type TaskRow,
} from "@desplega/storage";
import { notOnPostgresYet } from "./not-yet";

export class PostgresMessagingRepository extends BaseMessagingRepository {
  listPendingSlackRelayTasks(): Promise<TaskRow[]> {
    return notOnPostgresYet("PostgresMessagingRepository.listPendingSlackRelayTasks");
  }

  listPendingChatRelayTasks(
    now: string,
    limit: number,
    adapters: readonly string[],
  ): Promise<PendingChatRelayRow[]> {
    return notOnPostgresYet("PostgresMessagingRepository.listPendingChatRelayTasks");
  }

  markChatRelayAttempted(taskId: string, now: string): Promise<number> {
    return notOnPostgresYet("PostgresMessagingRepository.markChatRelayAttempted");
  }

  protected insertionOrder(alias?: string): SqlQuery {
    return notOnPostgresYet("PostgresMessagingRepository.insertionOrder");
  }
}
