import { BaseMcpServersRepository, type McpEventSubscriptionRow } from "@desplega/storage";
import { notOnPostgresYet } from "./not-yet";

export class PostgresMcpServersRepository extends BaseMcpServersRepository {
  listLiveSubscriptions(
    userId: string,
    eventName: string,
    now: string,
  ): Promise<McpEventSubscriptionRow[]> {
    return notOnPostgresYet("PostgresMcpServersRepository.listLiveSubscriptions");
  }
}
