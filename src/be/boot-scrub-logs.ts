/**
 * One-time boot-scrub: retroactively sanitize session_logs rows that contain
 * sensitive patterns (structural regex matches) which pre-date the defense-in-
 * depth scrub added to createSessionLogs / task persistence paths.
 *
 * Idempotent: already-scrubbed rows are no-ops (scrubSecrets is idempotent).
 * Uses seed_state to avoid re-scanning on subsequent boots.
 *
 * Restart-safe: progress is persisted as a cursor in seed_state after each
 * batch, so a restart (e.g. K8s probe SIGKILL) resumes from the last
 * committed batch instead of re-scanning from zero.
 *
 * Non-blocking: yields to the event loop between batches so /health and
 * startup/liveness probes stay responsive.
 */

import { scrubSecrets } from "../utils/secret-scrubber";
import { getDbClient } from "./db";

const SCRUB_KEY = "boot-scrub-logs-v2";
const CURSOR_KEY = "boot-scrub-logs-v2-cursor";
const BATCH_SIZE = 200;

/** Yield to the event loop so probes can respond. */
const yieldTick = () => new Promise<void>((r) => setTimeout(r, 5));

export async function runBootScrubLogs(): Promise<void> {
  const done = await getDbClient().get<{ key: string }>(
    "SELECT key FROM seed_state WHERE kind = ? AND key = ?",
    ["maintenance", SCRUB_KEY],
  );

  if (done) return;

  // Resume from last cursor if a previous run was interrupted
  const savedCursor =
    (
      await getDbClient().get<{ seededHash: string }>(
        "SELECT seededHash FROM seed_state WHERE kind = ? AND key = ?",
        ["maintenance", CURSOR_KEY],
      )
    )?.seededHash ?? "";

  const lastProcessedId = savedCursor || "";

  // Count total work remaining (for logging only)
  const totalRemaining =
    (
      await getDbClient().get<{ count: number }>(
        `SELECT COUNT(*) as count FROM session_logs
         WHERE id > ?
           AND (content LIKE '%lin!_oauth!_%' ESCAPE '!'
             OR content LIKE '%lin!_api!_%' ESCAPE '!'
             OR content LIKE '%npm!_%' ESCAPE '!'
             OR content LIKE '%ATATT%')`,
        [lastProcessedId],
      )
    )?.count ?? 0;

  if (totalRemaining === 0) {
    await markDone();
    return;
  }

  console.log(
    `[boot-scrub-logs] starting: ${totalRemaining} candidate rows remaining` +
      (lastProcessedId ? ` (resuming from cursor ${lastProcessedId.slice(0, 8)}…)` : ""),
  );

  const saveCursorSql = `INSERT INTO seed_state (kind, key, seededHash, seededAt)
     VALUES ('maintenance', '${CURSOR_KEY}', ?, datetime('now'))
     ON CONFLICT (kind, key) DO UPDATE SET seededHash = ?, seededAt = datetime('now')`;

  let scrubbed = 0;
  let scanned = 0;
  let cursor = lastProcessedId;

  // Paginated cursor loop — each iteration fetches the next BATCH_SIZE rows
  // ordered by id, processes them in a transaction, saves the cursor, and
  // yields to the event loop.
  for (;;) {
    const rows = await getDbClient().query<{ id: string; content: string }>(
      `SELECT id, content FROM session_logs
       WHERE id > ?
         AND (content LIKE '%lin!_oauth!_%' ESCAPE '!'
           OR content LIKE '%lin!_api!_%' ESCAPE '!'
           OR content LIKE '%npm!_%' ESCAPE '!'
           OR content LIKE '%ATATT%')
       ORDER BY id ASC
       LIMIT ${BATCH_SIZE}`,
      [cursor],
    );
    if (rows.length === 0) break;

    const batchLastId = rows[rows.length - 1]!.id;

    await getDbClient().transaction(async (tx) => {
      for (const row of rows) {
        const cleaned = scrubSecrets(row.content);
        if (cleaned !== row.content) {
          await tx.run("UPDATE session_logs SET content = ? WHERE id = ?", [cleaned, row.id]);
          scrubbed++;
        }
      }
      // Persist cursor inside the same transaction so it's atomic with the scrub
      await tx.run(saveCursorSql, [batchLastId, batchLastId]);
    });

    scanned += rows.length;
    cursor = batchLastId;

    // Yield to the event loop between batches
    await yieldTick();
  }

  await markDone();
  // Clean up the cursor key now that we're fully done
  await getDbClient().run("DELETE FROM seed_state WHERE kind = 'maintenance' AND key = ?", [
    CURSOR_KEY,
  ]);

  console.log(`[boot-scrub-logs] complete: scanned=${scanned} scrubbed=${scrubbed}`);
}

async function markDone(): Promise<void> {
  await getDbClient().run(
    `INSERT INTO seed_state (kind, key, seededHash, seededAt)
     VALUES ('maintenance', ?, 'done', datetime('now'))
     ON CONFLICT (kind, key) DO UPDATE SET seededHash = 'done', seededAt = datetime('now')`,
    [SCRUB_KEY],
  );
}
