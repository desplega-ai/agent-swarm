import { getDbClient } from "../runtime";

/** `agent_tasks_fts_state.indexedThrough` once every row is indexed (migration 256). */
export const TASK_FTS_COMPLETE = Number.MAX_SAFE_INTEGER;

// At or below this many candidate rows, a page reads them by rowid and sorts
// them. Above it, the page walks the lastUpdatedAt index and tests each row
// against the index instead: sorting thousands of hits means reading each
// row's record, and a long task body spills over many overflow pages.
const ROWID_SET_MAX = 500;

// Rows per backfill transaction. A task averages about 16 KB of text, so a
// batch holds the write lock and the event loop for tens of milliseconds.
const BACKFILL_BATCH_SIZE = 100;

/**
 * The agent_tasks_fts MATCH expression for free text: the whole input as one
 * FTS5 phrase, so user text cannot inject operators (NEAR, AND, -, ^, column
 * filters), with a prefix match on its last token. Returns null when the input
 * has no indexable token (the phrase would match nothing).
 */
export function buildTaskFtsMatch(search: string): string | null {
  if (!/[\p{L}\p{N}]/u.test(search)) return null;
  return `"${search.replaceAll('"', '""')}"*`;
}

/**
 * The WHERE term for a task `search`: a token and phrase match on the task
 * text and title through agent_tasks_fts, or a prefix of the task id. Until
 * the post-boot backfill has indexed every row it is the old substring LIKE,
 * so results never miss rows the index has not reached yet.
 *
 * `purpose` picks the plan. A page with few candidates reads them by rowid; a
 * page with many walks its ORDER BY index and tests membership (`+rowid`
 * keeps the planner off the rowid set), stopping at the page size. A count
 * has no LIMIT to stop at, so it always drives from the candidate set.
 */
export async function taskSearchCondition(
  search: string,
  purpose: "page" | "count",
): Promise<{ sql: string; params: string[] }> {
  const client = getDbClient();
  const state = await client.get<{ indexedThrough: number }>(
    "SELECT indexedThrough FROM agent_tasks_fts_state WHERE id = 1",
  );
  if (!state || state.indexedThrough < TASK_FTS_COMPLETE) {
    const pattern = `%${search}%`;
    return {
      sql: "(task LIKE ? OR title LIKE ? OR id LIKE ?)",
      params: [pattern, pattern, pattern],
    };
  }

  const match = buildTaskFtsMatch(search);
  // Task ids are lowercase UUIDs; a prefix is a range on the primary key.
  const idLow = search.trim().toLowerCase();
  const idRange = idLow ? [idLow, `${idLow}\uffff`] : null;
  if (!match && !idRange) return { sql: "0", params: [] };

  const arms: string[] = [];
  const armParams: string[] = [];
  if (match) {
    arms.push("SELECT rowid AS rid FROM agent_tasks_fts WHERE agent_tasks_fts MATCH ?");
    armParams.push(match);
  }
  if (idRange) {
    arms.push("SELECT rowid AS rid FROM agent_tasks WHERE id >= ? AND id < ?");
    armParams.push(...idRange);
  }
  const candidates = await client.query<{ rid: number }>(
    `${arms.join(" UNION ")} LIMIT ${ROWID_SET_MAX + 1}`,
    armParams,
  );
  if (candidates.length === 0) return { sql: "0", params: [] };
  if (candidates.length <= ROWID_SET_MAX) {
    return {
      sql: `agent_tasks.rowid IN (${candidates.map((row) => row.rid).join(", ")})`,
      params: [],
    };
  }

  const rowid = purpose === "page" ? "+agent_tasks.rowid" : "agent_tasks.rowid";
  const terms: string[] = [];
  const params: string[] = [];
  if (match) {
    terms.push(`${rowid} IN (SELECT rowid FROM agent_tasks_fts WHERE agent_tasks_fts MATCH ?)`);
    params.push(match);
  }
  if (idRange) {
    terms.push("(agent_tasks.id >= ? AND agent_tasks.id < ?)");
    params.push(...idRange);
  }
  return { sql: `(${terms.join(" OR ")})`, params };
}

/**
 * Index the rows migration 256 left out, in rowid batches. Each batch and the
 * `indexedThrough` mark that admits it to the triggers commit together, so a
 * concurrent write is indexed exactly once: by its trigger when its row is
 * already covered, else by a later batch. The last batch sets the mark to
 * TASK_FTS_COMPLETE, which switches search to the index. Resumable after a
 * restart; a no-op once complete.
 */
export async function backfillTaskSearchIndex(
  batchSize = BACKFILL_BATCH_SIZE,
): Promise<{ indexed: number; ms: number }> {
  const client = getDbClient();
  const startedAt = performance.now();
  let indexed = 0;
  while (!stopRequested) {
    const done = await client.transaction(async (tx) => {
      const state = await tx.get<{ indexedThrough: number }>(
        "SELECT indexedThrough FROM agent_tasks_fts_state WHERE id = 1",
      );
      if (!state || state.indexedThrough >= TASK_FTS_COMPLETE) return true;
      const last = await tx.get<{ rid: number }>(
        "SELECT rowid AS rid FROM agent_tasks WHERE rowid > ? ORDER BY rowid LIMIT 1 OFFSET ?",
        [state.indexedThrough, batchSize - 1],
      );
      const through = last?.rid ?? TASK_FTS_COMPLETE;
      const result = await tx.run(
        `INSERT INTO agent_tasks_fts(rowid, task, title)
         SELECT rowid, task, title FROM agent_tasks WHERE rowid > ? AND rowid <= ?`,
        [state.indexedThrough, through],
      );
      indexed += result.changes;
      await tx.run("UPDATE agent_tasks_fts_state SET indexedThrough = ? WHERE id = 1", [through]);
      return through >= TASK_FTS_COMPLETE;
    });
    if (done) break;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  return { indexed, ms: Math.round(performance.now() - startedAt) };
}

let backfill: Promise<void> | null = null;
let stopRequested = false;

/** Start the backfill once per process, off the boot path. */
export function startTaskSearchBackfill(): Promise<void> {
  stopRequested = false;
  backfill ??= backfillTaskSearchIndex()
    .then(({ indexed, ms }) => {
      if (indexed > 0) console.log(`[task-fts] backfill indexed=${indexed} ms=${ms}`);
    })
    .catch((err) => {
      console.error("[task-fts] backfill failed:", (err as Error).message);
    })
    .finally(() => {
      backfill = null;
    });
  return backfill;
}

/** Stop after the current batch, before SQLite closes. The next start resumes. */
export async function stopTaskSearchBackfill(): Promise<void> {
  stopRequested = true;
  await backfill;
}
