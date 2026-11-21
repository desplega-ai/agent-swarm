import {
  BaseSlackRepository,
  type SlackInboundReceiptRow,
  type SlackMessageRow,
  type SlackOutcomeHostRow,
  type SlackOutcomeWindowParams,
  type SlackReconcileCandidate,
  type SlackReconcileSource,
  type SlackThreadRef,
} from "@desplega/storage";
import { notOnPostgresYet } from "./not-yet";

export class PostgresSlackRepository extends BaseSlackRepository {
  lastInboundFailure(): Promise<{ error_code: string | null; updated_at: string } | null> {
    return notOnPostgresYet("PostgresSlackRepository.lastInboundFailure");
  }

  listUncertainInbound(limit: number): Promise<SlackInboundReceiptRow[]> {
    return notOnPostgresYet("PostgresSlackRepository.listUncertainInbound");
  }

  listTreesNeedingRender(thread?: SlackThreadRef): Promise<SlackMessageRow[]> {
    return notOnPostgresYet("PostgresSlackRepository.listTreesNeedingRender");
  }

  closeTreeIfSettled(id: string, now: string): Promise<boolean> {
    return notOnPostgresYet("PostgresSlackRepository.closeTreeIfSettled");
  }

  threadHasOutcomeWork(thread: SlackThreadRef, window: SlackOutcomeWindowParams): Promise<boolean> {
    return notOnPostgresYet("PostgresSlackRepository.threadHasOutcomeWork");
  }

  pageReconcileCandidates(
    source: SlackReconcileSource,
    cursor: string,
    pageSize: number,
    delegationEnabled: boolean,
    window: SlackOutcomeWindowParams,
  ): Promise<SlackReconcileCandidate[]> {
    return notOnPostgresYet("PostgresSlackRepository.pageReconcileCandidates");
  }

  findLatestOutcomeHost(channelId: string, threadTs: string): Promise<SlackOutcomeHostRow | null> {
    return notOnPostgresYet("PostgresSlackRepository.findLatestOutcomeHost");
  }
}
