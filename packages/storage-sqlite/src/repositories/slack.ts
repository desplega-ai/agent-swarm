import {
  BaseSlackRepository,
  type SlackInboundReceiptRow,
  type SlackOutcomeHostRow,
  sql,
} from "@desplega/storage";

export class SqliteSlackRepository extends BaseSlackRepository {
  lastInboundFailure(): Promise<{ error_code: string | null; updated_at: string } | null> {
    // Ties: the sort over the table scan returned the first inserted before the move.
    return this.db.get<{ error_code: string | null; updated_at: string }>(sql`
      SELECT error_code, updated_at FROM slack_inbound_receipts
      WHERE error_code IS NOT NULL
      ORDER BY updated_at DESC, rowid ASC LIMIT 1`);
  }

  listUncertainInbound(limit: number): Promise<SlackInboundReceiptRow[]> {
    // Ties: idx_slack_inbound_receipts_state (state, received_at) walked
    // backwards returned the newest insertion first before the move.
    return this.db.query<SlackInboundReceiptRow>(sql`
      SELECT * FROM slack_inbound_receipts WHERE state = 'uncertain'
      ORDER BY received_at DESC, rowid DESC LIMIT ${limit}`);
  }

  findLatestOutcomeHost(channelId: string, threadTs: string): Promise<SlackOutcomeHostRow | null> {
    // Ties: the sort over idx_slack_messages_thread returned the first inserted before the move.
    return this.db.get<SlackOutcomeHostRow>(sql`
      SELECT id, ts, task_id, context_key, permalink, conclusion_kind, finalized_at
      FROM slack_messages
      WHERE channel_id = ${channelId} AND thread_ts = ${threadTs} AND ${this.deliveredHost()}
      ORDER BY finalized_at DESC, created_at DESC, rowid ASC
      LIMIT 1`);
  }
}
