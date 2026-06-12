/**
 * One-time boot-scrub: retroactively sanitize session_logs rows that contain
 * sensitive patterns (structural regex matches) which pre-date the defense-in-
 * depth scrub added to createSessionLogs / task persistence paths.
 *
 * Idempotent: already-scrubbed rows are no-ops (scrubSecrets is idempotent).
 * Uses seed_state to avoid re-scanning on subsequent boots.
 */

import { scrubSecrets } from "../utils/secret-scrubber";
import { getDb } from "./db";

const SCRUB_KEY = "boot-scrub-logs-v2";
const BATCH_SIZE = 500;

export async function runBootScrubLogs(): Promise<void> {
  const db = getDb();

  const done = db
    .prepare<{ key: string }, [string, string]>(
      "SELECT key FROM seed_state WHERE kind = ? AND key = ?",
    )
    .get("maintenance", SCRUB_KEY);

  if (done) return;

  // ESCAPE '!' makes ! the escape character so !_ matches a literal underscore
  // instead of the LIKE single-char wildcard. Without this, '%npm_%' matches
  // any row containing "npm" + any char (e.g. "npm install"), drowning real
  // token rows when a LIMIT is applied.
  const rows = db
    .prepare<{ id: string; content: string }, []>(
      `SELECT id, content FROM session_logs
       WHERE content LIKE '%lin!_oauth!_%' ESCAPE '!'
          OR content LIKE '%lin!_api!_%' ESCAPE '!'
          OR content LIKE '%npm!_%' ESCAPE '!'
          OR content LIKE '%ATATT%'`,
    )
    .all();

  if (rows.length === 0) {
    markDone(db);
    return;
  }

  console.log(`[boot-scrub-logs] starting: ${rows.length} candidate rows`);

  const update = db.prepare("UPDATE session_logs SET content = ? WHERE id = ?");
  let scrubbed = 0;

  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);
    const tx = db.transaction(() => {
      for (const row of batch) {
        const cleaned = scrubSecrets(row.content);
        if (cleaned !== row.content) {
          update.run(cleaned, row.id);
          scrubbed++;
        }
      }
    });
    tx();
  }

  markDone(db);
  console.log(`[boot-scrub-logs] complete: scanned=${rows.length} scrubbed=${scrubbed}`);
}

function markDone(db: ReturnType<typeof getDb>) {
  db.run(
    `INSERT INTO seed_state (kind, key, seededHash, seededAt)
     VALUES ('maintenance', ?, 'done', datetime('now'))
     ON CONFLICT (kind, key) DO UPDATE SET seededHash = 'done', seededAt = datetime('now')`,
    [SCRUB_KEY],
  );
}
