import { deleteKv, listKv, sweepExpiredKv, upsertKv } from "../be/db";
import type { SlackFile } from "./files";

/**
 * Durable copy of the Slack thread buffer. The buffer lives in memory until
 * its debounce flush; a restart inside that window would lose a message Slack
 * already considers delivered. Each buffered message is a kv row until its
 * flush returns, so the next boot can replay it.
 */
export const SLACK_THREAD_BUFFER_KV_NAMESPACE = "slack-thread-buffer";

/** A replay older than this is stale: the thread has moved on. */
const TTL_MS = 24 * 60 * 60 * 1000;
const PAGE = 500;

export interface BufferedMessage {
  text: string;
  userId: string;
  ts: string;
  channelId: string;
  threadTs: string;
  files?: SlackFile[];
  botUserId?: string;
  userTeam?: string;
}

function rowKey(item: BufferedMessage): string {
  return `${item.channelId}:${item.threadTs}:${item.ts}`;
}

export async function persist(item: BufferedMessage): Promise<void> {
  await upsertKv({
    namespace: SLACK_THREAD_BUFFER_KV_NAMESPACE,
    key: rowKey(item),
    value: item,
    valueType: "json",
    expiresAt: Date.now() + TTL_MS,
  });
}

export async function clear(items: BufferedMessage[]): Promise<void> {
  for (const item of items) await deleteKv(SLACK_THREAD_BUFFER_KV_NAMESPACE, rowKey(item));
}

/** Every unexpired buffered message, oldest Slack ts first. Expired rows are deleted. */
export async function loadAll(): Promise<BufferedMessage[]> {
  await sweepExpiredKv(SLACK_THREAD_BUFFER_KV_NAMESPACE);
  const items: BufferedMessage[] = [];
  for (let offset = 0; ; offset += PAGE) {
    const rows = await listKv(SLACK_THREAD_BUFFER_KV_NAMESPACE, { limit: PAGE, offset });
    for (const row of rows) {
      // A corrupt row decodes as a string; it cannot be replayed.
      if (row.value && typeof row.value === "object") items.push(row.value as BufferedMessage);
    }
    if (rows.length < PAGE) break;
  }
  return items.sort((a, b) => Number(a.ts) - Number(b.ts));
}
