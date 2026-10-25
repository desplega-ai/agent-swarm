/**
 * Move old Slack and supported chat sessions to their source keys once per
 * `seed_state(kind='maintenance', key='session-source-keys-v1')` marker.
 *
 * An id cursor resumes interrupted boots after the last committed batch.
 * Each root uses compare-and-set inside a write transaction to preserve user moves.
 * Failed roots do not block other roots. Failures clear the cursor and prevent
 * the done marker, so the next boot retries from the start.
 *
 * Never changes `lastUpdatedAt` or read state.
 */
import { defaultAssetKey, normalizeAssetKey } from "../assets/key";
import { sessionSourceKey } from "../assets/source-key";
import { scrubSecrets } from "../utils/secret-scrubber";
import { getDbClient } from "./db";
import {
  AssetKeyMovesBlockedError,
  assertAssetKeyMovesAllowed,
  moveTaskChainKeyInTx,
} from "./db/session-moves";

const DONE_KEY = "session-source-keys-v1";
const CURSOR_KEY = `${DONE_KEY}:cursor`;
const TAG = "[session-source-backfill]";

type BackfillRoot = {
  id: string;
  slackChannelId: string | null;
  slackThreadTs: string | null;
  contextKey: string | null;
};

type BackfillStats = { scanned: number; moved: number; skipped: number; failed: number };

export type SessionSourceBackfillOptions = {
  batchSize?: number;
  /** Test hook. A throw aborts the run after the batch commits and its cursor is saved. */
  afterBatch?: (info: { ids: string[] }) => void | Promise<void>;
};

/** Re-key untouched source sessions once, with a cursor for interrupted boots. */
export async function runSessionSourceBackfill({
  batchSize = 200,
  afterBatch,
}: SessionSourceBackfillOptions = {}): Promise<BackfillStats | null> {
  const client = getDbClient();
  const done = await client.get<{ key: string }>(
    "SELECT key FROM seed_state WHERE kind = 'maintenance' AND key = ?",
    [DONE_KEY],
  );
  if (done) return null;

  try {
    await assertAssetKeyMovesAllowed();
  } catch (error) {
    if (!(error instanceof AssetKeyMovesBlockedError)) throw error;
    console.warn(`${TAG} asset key audit blocked moves. Retry on next boot.`);
    return null;
  }

  let cursor =
    (
      await client.get<{ seededHash: string }>(
        "SELECT seededHash FROM seed_state WHERE kind = 'maintenance' AND key = ?",
        [CURSOR_KEY],
      )
    )?.seededHash ?? "";
  const stats: BackfillStats = { scanned: 0, moved: 0, skipped: 0, failed: 0 };

  for (;;) {
    const roots = await client.query<BackfillRoot>(
      `SELECT id, slackChannelId, slackThreadTs, contextKey FROM agent_tasks
       WHERE parentTaskId IS NULL AND id > ?
         AND ("key" = 'shared/' OR "key" = 'shared/task:' || lower(id) || '/')
         AND ((slackChannelId IS NOT NULL AND slackThreadTs IS NOT NULL)
           OR contextKey GLOB 'task:chat-sdk:*')
       ORDER BY id LIMIT ?`,
      [cursor, batchSize],
    );
    if (roots.length === 0) break;

    for (const root of roots) {
      const key = sessionSourceKey(root);
      if (!key) {
        stats.skipped++;
        continue;
      }
      try {
        const result = await client.transaction(async () => {
          // BEGIN takes the write lock, so these reads see user moves and new children since the batch read.
          const current = await client.get<{ key: string; parentTaskId: string | null }>(
            'SELECT "key", parentTaskId FROM agent_tasks WHERE id = ?',
            [root.id],
          );
          if (
            !current ||
            current.parentTaskId !== null ||
            (current.key !== "shared/" &&
              current.key !== normalizeAssetKey(defaultAssetKey("task", root.id)))
          ) {
            return "skipped";
          }
          const chain = await client.query<{ id: string }>(
            `WITH RECURSIVE chain(id) AS (
               SELECT id FROM agent_tasks WHERE id = ?
               UNION
               SELECT t.id FROM agent_tasks t JOIN chain c ON t.parentTaskId = c.id
             ) SELECT id FROM chain`,
            [root.id],
          );
          // Boot maintenance has no actor, so audit columns keep their last editor.
          const moved = await moveTaskChainKeyInTx(
            root.id,
            chain.map((task) => task.id),
            key,
          );
          return moved && moved.length > 0 ? "moved" : "skipped";
        });
        stats[result]++;
      } catch (error) {
        stats.failed++;
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`${TAG} root=${root.id} failed: ${scrubSecrets(message)}`);
      }
    }

    const batchLastId = roots[roots.length - 1]!.id;
    // After a failure the cursor stays behind the failed root, so a boot that
    // stops later still re-reads it, and no done marker can skip it.
    if (stats.failed === 0)
      await client.run(
        `INSERT INTO seed_state (kind, key, seededHash, seededAt)
       VALUES ('maintenance', ?, ?, datetime('now'))
       ON CONFLICT (kind, key) DO UPDATE SET seededHash = excluded.seededHash, seededAt = datetime('now')`,
        [CURSOR_KEY, batchLastId],
      );
    stats.scanned += roots.length;
    cursor = batchLastId;
    await afterBatch?.({ ids: roots.map((root) => root.id) });
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }

  await client.transaction(async (tx) => {
    if (stats.failed === 0) {
      await tx.run(
        `INSERT INTO seed_state (kind, key, seededHash, seededAt)
       VALUES ('maintenance', ?, 'done', datetime('now'))
       ON CONFLICT (kind, key) DO UPDATE SET seededHash = 'done', seededAt = datetime('now')`,
        [DONE_KEY],
      );
    }
    await tx.run("DELETE FROM seed_state WHERE kind = 'maintenance' AND key = ?", [CURSOR_KEY]);
  });
  if (stats.failed > 0) {
    console.warn(
      `${TAG} retry on next boot scanned=${stats.scanned} moved=${stats.moved} skipped=${stats.skipped} failed=${stats.failed}`,
    );
  }
  console.log(
    `${TAG} complete scanned=${stats.scanned} moved=${stats.moved} skipped=${stats.skipped} failed=${stats.failed}`,
  );
  return stats;
}
