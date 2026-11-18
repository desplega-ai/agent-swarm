import { getDbClient } from "../db";

/**
 * Outcome card groups: one Slack message (the host card) that shows the
 * answers of several tasks. Each merged task keeps its own outcome row, with
 * `merged_into_id` set to the host row and the placeholder ts `merged:<id>`.
 * See migration 353.
 */

const MERGED_SLACK_MESSAGE_TS_PREFIX = "merged:";

/** True for the placeholder ts of a merged row: it names no Slack message. */
export function isMergedSlackMessageTs(ts: string): boolean {
  return ts.startsWith(MERGED_SLACK_MESSAGE_TS_PREFIX);
}

/** The newest delivered outcome card of a thread that other cards can merge into. */
export type SlackOutcomeGroupHost = {
  id: string;
  ts: string;
  taskId: string;
  contextKey: string;
  permalink: string | null;
  conclusionKind: string | null;
  /** When the card last changed: its delivery, or the newest merge into it. */
  lastSectionAt: string;
  /** Task ids merged into the card, oldest first. */
  mergedTaskIds: string[];
};

type HostRow = {
  id: string;
  ts: string;
  task_id: string;
  context_key: string;
  permalink: string | null;
  conclusion_kind: string | null;
  finalized_at: string;
};

async function mergedTaskIds(hostId: string): Promise<{ taskId: string; createdAt: string }[]> {
  const rows = await getDbClient().query<{ task_id: string; created_at: string }>(
    `SELECT task_id, created_at FROM slack_messages
       WHERE merged_into_id = ? AND kind = 'outcome' AND task_id IS NOT NULL
       ORDER BY created_at ASC, id ASC`,
    [hostId],
  );
  return rows.map((row) => ({ taskId: row.task_id, createdAt: row.created_at }));
}

async function toHost(row: HostRow): Promise<SlackOutcomeGroupHost> {
  const merged = await mergedTaskIds(row.id);
  const newestMerge = merged.at(-1)?.createdAt;
  return {
    id: row.id,
    ts: row.ts,
    taskId: row.task_id,
    contextKey: row.context_key,
    permalink: row.permalink,
    conclusionKind: row.conclusion_kind,
    lastSectionAt: newestMerge && newestMerge > row.finalized_at ? newestMerge : row.finalized_at,
    mergedTaskIds: merged.map((entry) => entry.taskId),
  };
}

const HOST_COLUMNS = `id, ts, task_id, context_key, permalink, conclusion_kind, finalized_at`;
const DELIVERED_HOST_SQL = `kind = 'outcome' AND task_id IS NOT NULL AND merged_into_id IS NULL
  AND finalized_at IS NOT NULL AND delivery_abandoned_at IS NULL
  AND ts NOT LIKE 'pending:%' AND ts NOT LIKE '${MERGED_SLACK_MESSAGE_TS_PREFIX}%'`;

/** The newest delivered, unmerged outcome card in the thread, or null. */
export async function getLatestSlackOutcomeGroupHost(
  channelId: string,
  threadTs: string,
): Promise<SlackOutcomeGroupHost | null> {
  const row = await getDbClient().get<HostRow>(
    `SELECT ${HOST_COLUMNS} FROM slack_messages
       WHERE channel_id = ? AND thread_ts = ? AND ${DELIVERED_HOST_SQL}
       ORDER BY finalized_at DESC, created_at DESC
       LIMIT 1`,
    [channelId, threadTs],
  );
  return row ? await toHost(row) : null;
}

/**
 * The group that outcome row `messageId` belongs to: its host when the row
 * was merged, else the row itself. Null when the row is in no group (a
 * delivered card with nothing merged into it, or an unknown row).
 */
export async function getSlackOutcomeGroupOf(
  messageId: string,
): Promise<SlackOutcomeGroupHost | null> {
  const own = await getDbClient().get<{ merged_into_id: string | null }>(
    `SELECT merged_into_id FROM slack_messages WHERE id = ?`,
    [messageId],
  );
  if (!own) return null;
  const hostId = own.merged_into_id ?? messageId;
  const row = await getDbClient().get<HostRow>(
    `SELECT ${HOST_COLUMNS} FROM slack_messages WHERE id = ? AND ${DELIVERED_HOST_SQL}`,
    [hostId],
  );
  if (!row) return null;
  const host = await toHost(row);
  return host.mergedTaskIds.length > 0 ? host : null;
}

/**
 * Records that task `taskId`'s answer now shows in the host card. The row is
 * finalized at once and carries the host's permalink. Returns false when the
 * task already has an outcome row.
 */
export async function recordMergedSlackOutcome(input: {
  host: SlackOutcomeGroupHost;
  channelId: string;
  threadTs: string;
  taskId: string;
  actorId?: string;
}): Promise<boolean> {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const row = await getDbClient().get<{ id: string }>(
    `INSERT INTO slack_messages (
         id, context_key, channel_id, thread_ts, ts, kind, task_id, permalink,
         finalized_at, merged_into_id, created_at, updated_at, created_by, updated_by
       ) VALUES (?, ?, ?, ?, ?, 'outcome', ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT DO NOTHING
       RETURNING id`,
    [
      id,
      input.host.contextKey,
      input.channelId,
      input.threadTs,
      `${MERGED_SLACK_MESSAGE_TS_PREFIX}${id}`,
      input.taskId,
      input.host.permalink,
      now,
      input.host.id,
      now,
      now,
      input.actorId ?? null,
      input.actorId ?? null,
    ],
  );
  return !!row;
}
