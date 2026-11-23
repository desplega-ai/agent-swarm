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
import {
  AssetKeyMovesBlockedError,
  assertAssetKeyMovesAllowed,
  moveTaskChainKeyInTx,
} from "./db/session-moves";
import { getStorage } from "./storage";

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
  const storage = getStorage();
  const done = await storage.repos.config.getSeedState("maintenance", DONE_KEY);
  if (done) return null;

  try {
    await assertAssetKeyMovesAllowed();
  } catch (error) {
    if (!(error instanceof AssetKeyMovesBlockedError)) throw error;
    console.warn(`${TAG} asset key audit blocked moves. Retry on next boot.`);
    return null;
  }

  let cursor = (await storage.repos.maintenance.getState(CURSOR_KEY)) ?? "";
  const stats: BackfillStats = { scanned: 0, moved: 0, skipped: 0, failed: 0 };

  for (;;) {
    const roots: BackfillRoot[] = await storage.repos.sessions.listSourceBackfillRoots(
      cursor,
      batchSize,
    );
    if (roots.length === 0) break;

    for (const root of roots) {
      const key = sessionSourceKey(root);
      if (!key) {
        stats.skipped++;
        continue;
      }
      try {
        const result = await storage.transaction(async () => {
          // BEGIN takes the write lock, so these reads see user moves and new children since the batch read.
          const current = await storage.repos.sessions.findTaskKeyAndParent(root.id);
          if (
            !current ||
            current.parentTaskId !== null ||
            (current.key !== "shared/" &&
              current.key !== normalizeAssetKey(defaultAssetKey("task", root.id)))
          ) {
            return "skipped";
          }
          const chain = await storage.repos.sessions.listChainTaskIds(root.id);
          // Boot maintenance has no actor, so audit columns keep their last editor.
          const moved = await moveTaskChainKeyInTx(root.id, chain, key);
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
    if (stats.failed === 0) await storage.repos.maintenance.setState(CURSOR_KEY, batchLastId);
    stats.scanned += roots.length;
    cursor = batchLastId;
    await afterBatch?.({ ids: roots.map((root) => root.id) });
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }

  await storage.transaction(async () => {
    if (stats.failed === 0) await storage.repos.maintenance.setState(DONE_KEY, "done");
    await storage.repos.config.deleteSeedState("maintenance", CURSOR_KEY);
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
