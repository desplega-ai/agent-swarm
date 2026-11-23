import { getStorage } from "../storage";

/**
 * Outcome card groups: one Slack message (the host card) that shows the
 * answers of several tasks. Each merged task keeps its own outcome row, with
 * `merged_into_id` set to the host row and the placeholder ts `merged:<id>`.
 * See migration 356.
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
};

async function mergedTaskIds(hostId: string): Promise<string[]> {
  const rows = await getStorage().repos.slack.listMergedOutcomeTasks(hostId);
  return rows.map((row) => row.task_id);
}

async function toHost(row: HostRow): Promise<SlackOutcomeGroupHost> {
  return {
    id: row.id,
    ts: row.ts,
    taskId: row.task_id,
    contextKey: row.context_key,
    permalink: row.permalink,
    conclusionKind: row.conclusion_kind,
    mergedTaskIds: await mergedTaskIds(row.id),
  };
}

/** The newest delivered, unmerged outcome card in the thread, or null. */
export async function getLatestSlackOutcomeGroupHost(
  channelId: string,
  threadTs: string,
): Promise<SlackOutcomeGroupHost | null> {
  const row: HostRow | null = await getStorage().repos.slack.findLatestOutcomeHost(
    channelId,
    threadTs,
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
  const own = await getStorage().repos.slack.findMergedIntoId(messageId);
  if (!own) return null;
  const hostId = own.merged_into_id ?? messageId;
  const row: HostRow | null = await getStorage().repos.slack.findOutcomeHost(hostId);
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
  return getStorage().repos.slack.insertMergedOutcome({
    id,
    contextKey: input.host.contextKey,
    channelId: input.channelId,
    threadTs: input.threadTs,
    ts: `${MERGED_SLACK_MESSAGE_TS_PREFIX}${id}`,
    taskId: input.taskId,
    permalink: input.host.permalink,
    hostId: input.host.id,
    actorId: input.actorId ?? null,
    now,
  });
}
