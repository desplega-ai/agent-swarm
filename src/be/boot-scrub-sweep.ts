/**
 * Versioned boot retro-sweep: re-scrub stored free-text columns whenever the
 * redaction rules change.
 *
 * Rows written before a scrubber rule existed keep the secret it would now
 * catch. This sweep re-runs `scrubSecrets` over every target column once per
 * `SCRUBBER_RULES_VERSION` and redacts matching rows IN PLACE (irreversible;
 * a redaction, not a deletion). The done marker is
 * `seed_state(kind='maintenance', key='boot-scrub-v<N>')`, so bumping the
 * version re-runs it on the next boot.
 *
 * Restart-safe: each target keeps an id cursor in seed_state
 * (`boot-scrub-v<N>:<table>:cursor`), saved in the same transaction as the
 * batch's writes, so a restart resumes after the last committed batch.
 *
 * Non-blocking: the regexes run OUTSIDE the write lock. Each batch is read,
 * scrubbed in JS, and only the changed rows plus the cursor go into one short
 * transaction. Every UPDATE is compare-and-set on the value that was read, so
 * a row a concurrent writer moved in between is skipped, never clobbered. The
 * loop yields between batches so /health and probes stay responsive.
 *
 * Logs counts only, never content.
 */

import { contentSha256 } from "@/commands/profile-sync";
import { SCRUBBER_RULES_VERSION, scrubSecrets } from "../utils/secret-scrubber";
import { getDbClient } from "./db";
import type { DbExecutor, DbParam } from "./db-client";
import { getMemoryStore } from "./memory";
import type { MemoryScrubFields } from "./memory/types";

const DEFAULT_BATCH_SIZE = 200;

/** Yield to the event loop so probes can respond. */
const yieldTick = () => new Promise<void>((r) => setTimeout(r, 5));

type SweepTarget = {
  table: string;
  columns: string[];
  /** Recompute `hashColumn = sha256(sourceColumn)` when the source changes. */
  hash?: { column: string; of: string };
  /** Route writes through the memory store (FTS sync + embedding reset). */
  memory?: boolean;
};

/** Swept in this order. Every table has a TEXT `id` primary key. */
export const BOOT_SCRUB_TARGETS: readonly SweepTarget[] = [
  { table: "session_logs", columns: ["content"] },
  { table: "agent_tasks", columns: ["task", "output", "failureReason", "progress"] },
  { table: "agent_memory", columns: ["name", "content", "summary"], memory: true },
  {
    table: "agent_memory_version",
    columns: ["content"],
    hash: { column: "contentHash", of: "content" },
  },
  { table: "events", columns: ["data"] },
  { table: "workflow_run_steps", columns: ["input", "output", "error", "diagnostics"] },
];

export type BootScrubTableStats = {
  table: string;
  scanned: number;
  changed: number;
  skippedInvalidJson: number;
};

export type BootScrubSweepOptions = {
  /** Rules version to key on. Defaults to `SCRUBBER_RULES_VERSION` (tests inject). */
  version?: number;
  batchSize?: number;
  /** Scrub function. Defaults to `scrubSecrets` (tests inject to force edge cases). */
  scrub?: (text: string) => string;
  /**
   * Test hook, called after each batch commits with the ids it scanned. A
   * throw aborts the run with the cursor already saved.
   */
  afterBatch?: (info: { table: string; ids: string[] }) => void | Promise<void>;
  /** Re-embed redacted memory rows after the sweep. Default true. */
  reembed?: boolean;
};

export function bootScrubDoneKey(version: number): string {
  return `boot-scrub-v${version}`;
}

export function bootScrubCursorKey(version: number, table: string): string {
  return `boot-scrub-v${version}:${table}:cursor`;
}

/**
 * Run the sweep for the current rules version. Returns per-table stats, or
 * null when this version was already swept.
 */
export async function runBootScrubSweep(
  opts: BootScrubSweepOptions = {},
): Promise<BootScrubTableStats[] | null> {
  const version = opts.version ?? SCRUBBER_RULES_VERSION;
  const doneKey = bootScrubDoneKey(version);
  const done = await getDbClient().get<{ key: string }>(
    "SELECT key FROM seed_state WHERE kind = 'maintenance' AND key = ?",
    [doneKey],
  );
  if (done) return null;

  const tag = `boot-scrub-v${version}`;
  console.log(`[${tag}] starting`);

  const stats: BootScrubTableStats[] = [];
  for (const target of BOOT_SCRUB_TARGETS) {
    const tableStats = await sweepTarget(target, version, opts);
    stats.push(tableStats);
    console.log(
      `${tag}: ${target.table} scanned=${tableStats.scanned} changed=${tableStats.changed} skipped_invalid_json=${tableStats.skippedInvalidJson}`,
    );
  }

  await getDbClient().transaction(async (tx) => {
    await tx.run(
      `INSERT INTO seed_state (kind, key, seededHash, seededAt)
       VALUES ('maintenance', ?, 'done', datetime('now'))
       ON CONFLICT (kind, key) DO UPDATE SET seededHash = 'done', seededAt = datetime('now')`,
      [doneKey],
    );
    await tx.run("DELETE FROM seed_state WHERE kind = 'maintenance' AND key LIKE ? ESCAPE '!'", [
      `${doneKey.replace(/[!%_]/g, "!$&")}:%:cursor`,
    ]);
  });
  console.log(`[${tag}] complete`);

  const memoryChanged = stats.find((s) => s.table === "agent_memory")?.changed ?? 0;
  if (memoryChanged > 0 && opts.reembed !== false) {
    // Redacted memory rows lost their embedding; regenerate from scrubbed text.
    const { runBootReembed } = await import("./memory/boot-reembed");
    await runBootReembed();
  }

  return stats;
}

async function sweepTarget(
  target: SweepTarget,
  version: number,
  opts: BootScrubSweepOptions,
): Promise<BootScrubTableStats> {
  const client = getDbClient();
  const scrub = opts.scrub ?? scrubSecrets;
  const batchSize = opts.batchSize ?? DEFAULT_BATCH_SIZE;
  const cursorKey = bootScrubCursorKey(version, target.table);
  const stats: BootScrubTableStats = {
    table: target.table,
    scanned: 0,
    changed: 0,
    skippedInvalidJson: 0,
  };

  let cursor =
    (
      await client.get<{ seededHash: string }>(
        "SELECT seededHash FROM seed_state WHERE kind = 'maintenance' AND key = ?",
        [cursorKey],
      )
    )?.seededHash ?? "";

  const selectCols = [
    "id",
    ...target.columns,
    ...(target.hash && !target.columns.includes(target.hash.column) ? [target.hash.column] : []),
  ];

  for (;;) {
    const rows = await client.query<Record<string, string | null>>(
      `SELECT ${selectCols.join(", ")} FROM ${target.table}
       WHERE id > ? ORDER BY id ASC LIMIT ?`,
      [cursor, batchSize],
    );
    if (rows.length === 0) break;

    // Scrub outside the transaction: regexes never run under the write lock.
    const pending: {
      id: string;
      before: Record<string, string | null>;
      after: Record<string, string | null>;
    }[] = [];
    for (const row of rows) {
      const after: Record<string, string | null> = {};
      let differs = false;
      let breaksJson = false;
      for (const col of target.columns) {
        const value = row[col];
        if (typeof value !== "string" || value.length === 0) {
          after[col] = value ?? null;
          continue;
        }
        const cleaned = scrub(value);
        after[col] = cleaned;
        if (cleaned !== value) {
          differs = true;
          if (breaksJsonValidity(value, cleaned)) breaksJson = true;
        }
      }
      if (!differs) continue;
      if (breaksJson) {
        stats.skippedInvalidJson++;
        continue;
      }
      pending.push({ id: row.id as string, before: row, after });
    }

    const batchLastId = rows[rows.length - 1]!.id as string;
    await client.transaction(async (tx) => {
      for (const { id, before, after } of pending) {
        const wrote = target.memory
          ? await rewriteMemoryRow(id, before, after)
          : await rewriteRow(tx, target, id, before, after);
        if (wrote) stats.changed++;
      }
      await tx.run(
        `INSERT INTO seed_state (kind, key, seededHash, seededAt)
         VALUES ('maintenance', ?, ?, datetime('now'))
         ON CONFLICT (kind, key) DO UPDATE SET seededHash = excluded.seededHash, seededAt = datetime('now')`,
        [cursorKey, batchLastId],
      );
    });

    stats.scanned += rows.length;
    cursor = batchLastId;
    await opts.afterBatch?.({ table: target.table, ids: rows.map((r) => r.id as string) });
    await yieldTick();
  }

  return stats;
}

/** True when `before` parsed as JSON and `after` no longer does. */
function breaksJsonValidity(before: string, after: string): boolean {
  try {
    JSON.parse(before);
  } catch {
    return false;
  }
  try {
    JSON.parse(after);
    return false;
  } catch {
    return true;
  }
}

async function rewriteRow(
  tx: DbExecutor,
  target: SweepTarget,
  id: string,
  before: Record<string, string | null>,
  after: Record<string, string | null>,
): Promise<boolean> {
  const changedCols = target.columns.filter((c) => after[c] !== before[c]);
  const sets = changedCols.map((c) => `${c} = ?`);
  const params: DbParam[] = changedCols.map((c) => after[c] ?? null);
  if (target.hash && changedCols.includes(target.hash.of)) {
    sets.push(`${target.hash.column} = ?`);
    params.push(contentSha256(after[target.hash.of] ?? ""));
  }
  // Compare-and-set on every changed column.
  const guards = changedCols.map((c) => `${c} IS ?`);
  params.push(id, ...changedCols.map((c) => before[c] ?? null));
  const result = await tx.run(
    `UPDATE ${target.table} SET ${sets.join(", ")} WHERE id = ? AND ${guards.join(" AND ")}`,
    params,
  );
  return result.changes > 0;
}

async function rewriteMemoryRow(
  id: string,
  before: Record<string, string | null>,
  after: Record<string, string | null>,
): Promise<boolean> {
  const pick = (r: Record<string, string | null>): MemoryScrubFields => ({
    name: r.name ?? "",
    content: r.content ?? "",
    summary: r.summary ?? null,
  });
  return getMemoryStore().rewriteForScrub(id, pick(before), pick(after));
}
