import type { SlackMessageRow } from "@desplega/storage";
import type { SlackConclusionKind, SlackMessageKind, SlackMessageRecord } from "../db";
import { getStorage } from "../storage";

export function rowToSlackMessage(row: SlackMessageRow): SlackMessageRecord {
  return {
    id: row.id,
    contextKey: row.context_key,
    channelId: row.channel_id,
    threadTs: row.thread_ts,
    ts: row.ts,
    kind: row.kind as SlackMessageKind,
    taskId: row.task_id ?? undefined,
    permalink: row.permalink ?? undefined,
    finalizedAt: row.finalized_at ?? undefined,
    streamChunksAppended: row.stream_chunks_appended,
    conclusionKind: (row.conclusion_kind as SlackConclusionKind | null) ?? undefined,
    deferralResolvedAt: row.deferral_resolved_at ?? undefined,
    deferralAbandonedAt: row.deferral_abandoned_at ?? undefined,
    deliveryAttempts: row.delivery_attempts,
    deliveryAbandonedAt: row.delivery_abandoned_at ?? undefined,
    deliveryLastError: row.delivery_last_error ?? undefined,
    closedAt: row.closed_at ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** The outcome cards of `taskIds` in one read, keyed by task id. */
export async function getSlackOutcomeMessages(
  taskIds: readonly string[],
): Promise<Map<string, SlackMessageRecord>> {
  const rows = await getStorage().repos.slack.findSlackOutcomesByTaskIds(taskIds);
  return new Map(rows.map((row) => [row.task_id as string, rowToSlackMessage(row)]));
}
