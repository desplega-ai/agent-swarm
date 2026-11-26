import { buildTaskFtsMatch, TASK_FTS_COMPLETE } from "@desplega/storage";
import { getStorage } from "../../storage";

/** `agent_tasks_fts_state.indexedThrough` once every row is indexed (migration 256). */
export { buildTaskFtsMatch, TASK_FTS_COMPLETE };

// Rows per backfill transaction. A task averages about 16 KB of text, so a
// batch holds the write lock and the event loop for a few milliseconds.
const BACKFILL_BATCH_SIZE = 50;

// Pause between batches, so other writers get the lock between them.
const BACKFILL_YIELD_MS = 250;

// WAL guard. Back to back, the batches wrote hundreds of MB of index pages to
// the WAL within a minute. Past ~500 MB, litestream forces a TRUNCATE
// checkpoint that holds the write lock, and every writer in the process got
// "database is locked". So before each batch the backfill waits while the
// `-wal` file is over a cap. The file shrinks only on a truncate, so a size
// left over from earlier traffic is not growth: the cap sits
// BACKFILL_WAL_HEADROOM_BYTES above the size at start, clamped to 150-400 MB.
// A batch waits at most BACKFILL_WAL_MAX_WAIT_MS, so a WAL that never shrinks
// slows the backfill down instead of stalling it.
const BACKFILL_WAL_MIN_CAP_BYTES = 150 * 1024 * 1024;
const BACKFILL_WAL_MAX_CAP_BYTES = 400 * 1024 * 1024;
const BACKFILL_WAL_HEADROOM_BYTES = 64 * 1024 * 1024;
const BACKFILL_WAL_POLL_MS = 5_000;
const BACKFILL_WAL_MAX_WAIT_MS = 60_000;

// Waits before retrying a failed batch, usually SQLITE_BUSY that outlasted the
// db-client's own ~11s retry budget. The last delay repeats. After
// BACKFILL_MAX_RETRIES failures in a row (about 3 minutes) the run gives up,
// and the backfill starts again from the watermark BACKFILL_RESUME_MS later.
const BACKFILL_RETRY_BACKOFF_MS = [1_000, 2_000, 5_000, 10_000, 30_000];
const BACKFILL_MAX_RETRIES = 10;
const BACKFILL_RESUME_MS = 5 * 60_000;

export type TaskSearchBackfillOptions = {
  yieldMs?: number;
  retryBackoffMs?: number[];
  maxRetries?: number;
  /** Size of the `-wal` file in bytes. Defaults to a stat of the main DB's WAL. */
  walBytes?: () => number;
  walPollMs?: number;
  walMaxWaitMs?: number;
};

/*
 * The WHERE term of a task `search` (FTS5 MATCH on text and title, or an id
 * prefix; a substring LIKE until the backfill completes) is built by the tasks
 * repository (`taskSearchCondition` in the SQLite engine). On Postgres the
 * batches write the stored search documents of migration 391, and a row past
 * the mark matches through the expression indexes of 368 until it is complete.
 */

/**
 * Index the rows migration 256 (SQLite) or 391 (Postgres) left out, in rowid
 * batches. Each batch and the
 * `indexedThrough` mark that admits it to the triggers commit together, so a
 * concurrent write is indexed exactly once: by its trigger when its row is
 * already covered, else by a later batch. The last batch sets the mark to
 * TASK_FTS_COMPLETE, which switches search to the index. Each batch reads the
 * mark inside its own BEGIN IMMEDIATE, so a rerun, a resume, or a second
 * process running it at the same time continues from the mark and never
 * indexes a row twice. A failed batch rolls back whole and is retried with
 * backoff; a no-op once complete.
 */
export async function backfillTaskSearchIndex(
  batchSize = BACKFILL_BATCH_SIZE,
  {
    yieldMs = BACKFILL_YIELD_MS,
    retryBackoffMs = BACKFILL_RETRY_BACKOFF_MS,
    maxRetries = BACKFILL_MAX_RETRIES,
    walBytes,
    walPollMs = BACKFILL_WAL_POLL_MS,
    walMaxWaitMs = BACKFILL_WAL_MAX_WAIT_MS,
  }: TaskSearchBackfillOptions = {},
): Promise<{ indexed: number; ms: number }> {
  const storage = getStorage();
  const startedAt = performance.now();
  const readWalBytes = walBytes ?? (await mainWalBytesReader());
  const walCap = Math.min(
    BACKFILL_WAL_MAX_CAP_BYTES,
    Math.max(BACKFILL_WAL_MIN_CAP_BYTES, readWalBytes() + BACKFILL_WAL_HEADROOM_BYTES),
  );
  let indexed = 0;
  let retries = 0;
  while (!stopRequested) {
    for (let waited = 0; waited < walMaxWaitMs && readWalBytes() > walCap; waited += walPollMs) {
      await pause(walPollMs);
      if (stopRequested) break;
    }
    if (stopRequested) break;
    let batch: { changes: number; done: boolean };
    try {
      batch = await storage.transaction(() => storage.repos.tasks.indexTaskFtsBatch(batchSize));
    } catch (err) {
      if (retries >= maxRetries) throw err;
      const delayMs = retryBackoffMs[Math.min(retries, retryBackoffMs.length - 1)] ?? 0;
      retries += 1;
      console.warn(
        `[task-fts] backfill batch failed (${(err as Error).message}), retry ${retries} in ${delayMs}ms`,
      );
      await pause(delayMs);
      continue;
    }
    retries = 0;
    indexed += batch.changes;
    if (batch.done) break;
    await pause(yieldMs);
  }
  return { indexed, ms: Math.round(performance.now() - startedAt) };
}

/** Reads the main database's `-wal` size; always 0 for an in-memory DB. */
async function mainWalBytesReader(): Promise<() => number> {
  const file = await getStorage().repos.tasks.mainDatabaseFile();
  if (!file) return () => 0;
  const wal = `${file}-wal`;
  return () => Bun.file(wal).size;
}

let backfill: Promise<void> | null = null;
let stopRequested = false;
let wakeBackfill: (() => void) | null = null;
let resumeTimer: ReturnType<typeof setTimeout> | null = null;

/** A sleep that stopTaskSearchBackfill cuts short. */
function pause(ms: number): Promise<void> {
  if (stopRequested) return Promise.resolve();
  return new Promise((resolve) => {
    const wake = () => {
      clearTimeout(timer);
      if (wakeBackfill === wake) wakeBackfill = null;
      resolve();
    };
    const timer = setTimeout(wake, ms);
    wakeBackfill = wake;
  });
}

/**
 * Start the backfill once per process, off the boot path. A run that gives up
 * starts again `resumeMs` later from the watermark, so the index converges
 * without a restart; search keeps the LIKE fallback until then.
 */
export function startTaskSearchBackfill(
  opts: TaskSearchBackfillOptions & { batchSize?: number; resumeMs?: number } = {},
): Promise<void> {
  const { batchSize = BACKFILL_BATCH_SIZE, resumeMs = BACKFILL_RESUME_MS, ...backfillOpts } = opts;
  stopRequested = false;
  if (resumeTimer) {
    clearTimeout(resumeTimer);
    resumeTimer = null;
  }
  backfill ??= backfillTaskSearchIndex(batchSize, backfillOpts)
    .then(({ indexed, ms }) => {
      if (indexed > 0) console.log(`[task-fts] backfill indexed=${indexed} ms=${ms}`);
    })
    .catch((err) => {
      if (stopRequested) {
        console.error("[task-fts] backfill failed:", (err as Error).message);
        return;
      }
      console.error(
        `[task-fts] backfill failed, resuming in ${resumeMs}ms:`,
        (err as Error).message,
      );
      resumeTimer = setTimeout(() => {
        resumeTimer = null;
        if (!stopRequested) void startTaskSearchBackfill(opts);
      }, resumeMs);
      resumeTimer.unref?.();
    })
    .finally(() => {
      backfill = null;
    });
  return backfill;
}

/**
 * Stop after the current batch, before SQLite closes, cutting any pause,
 * retry wait or pending resume short. The next start resumes.
 */
export async function stopTaskSearchBackfill(): Promise<void> {
  stopRequested = true;
  if (resumeTimer) {
    clearTimeout(resumeTimer);
    resumeTimer = null;
  }
  wakeBackfill?.();
  await backfill;
}
