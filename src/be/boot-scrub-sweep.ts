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
 * Cheap: `createSweepScrubber` clears a row with a one-pass literal search
 * when no redaction rule can touch it, and runs the full `scrubSecrets` on the
 * rest. A cleared row is one `scrubSecrets` leaves as is, so the sweep redacts
 * exactly what a full sweep would. The rules decide, so a rule change needs no
 * change here; there is no per-rule or per-version delta to keep in step.
 *
 * Non-blocking: the regexes run OUTSIDE the write lock. Each batch is read,
 * scrubbed in JS, and only the changed rows plus the cursor go into one short
 * transaction. Every UPDATE is compare-and-set on the value that was read, so
 * a row a concurrent writer moved in between is skipped, never clobbered.
 *
 * Paced: the work runs in time slices of `SLICE_MS`, so a request waits for at
 * most one slice. After each slice the sweep rests, and the rest tracks load:
 * it measures how late its own rest timer fires (event-loop lag, which is what
 * a busy API adds), backs off while the lag is high and speeds up while the
 * loop is idle. A backfill thus spreads over time, and over restarts through
 * the cursor.
 *
 * Forward-only: with `BOOT_SCRUB_MODE=forward-only` a rules bump applies to new
 * writes only. No historical row is read; the skipped version is recorded in
 * `seed_state` (`boot-scrub-skipped-v<N>`, with a fingerprint of the rule
 * tables), and switching back to `backfill` sweeps it, because the sweep's rule
 * set is always the current one.
 *
 * Replay state: `workflow_run_steps.output` and `workflow_runs.context` are
 * also replayed by resume and recovery. A row written before the sealed
 * `*_replay` columns existed has only the plain value, so before redacting it
 * the sweep seals the original into the empty replay column (same CAS write).
 *
 * Logs counts only, never content.
 */

import { contentSha256 } from "@/commands/profile-sync";
import {
  createSweepScrubber,
  SCRUBBER_RULES_VERSION,
  scrubberRulesFingerprint,
} from "../utils/secret-scrubber";
import { getDbClient } from "./db";
import type { DbExecutor, DbParam } from "./db-client";
import { getMemoryStore } from "./memory";
import type { MemoryScrubFields } from "./memory/types";
import { breaksJsonValidity, foldHexCopies } from "./scrub-json";
import { sealJson } from "./sealed-json";

const DEFAULT_BATCH_SIZE = 100;

/** Longest the sweep holds the event loop before it rests. */
const SLICE_MS = 5;
/** Rest after a slice, as a multiple of the slice's work: fastest when idle, slowest when busy. */
const MIN_REST_RATIO = 0.25;
const MAX_REST_RATIO = 16;
/** Rest-timer lateness (smoothed) above which the API counts as busy, and below which as idle. */
const BUSY_LAG_MS = 8;
const IDLE_LAG_MS = 3;
/** Weight of the latest lag sample in the smoothed lag. */
const LAG_SMOOTHING = 0.3;

/** How the rest ratio follows load: doubles while busy, decays while idle, holds in between. */
export function nextRestRatio(ratio: number, smoothedLagMs: number): number {
  if (smoothedLagMs > BUSY_LAG_MS) return Math.min(MAX_REST_RATIO, ratio * 2);
  if (smoothedLagMs < IDLE_LAG_MS) return Math.max(MIN_REST_RATIO, ratio * 0.7);
  return ratio;
}

/**
 * Time slices for a sweep. `yieldIfDue` rests once the slice has run for
 * `SLICE_MS` and returns true, so the caller can drop state that the rest could
 * have outdated (a secret registered meanwhile). The rest is `ratio` times the
 * slice, and the ratio follows how late the rest timer fires.
 */
function createPacer() {
  let sliceStart = performance.now();
  let ratio = 1;
  let lag = 0;
  return {
    async yieldIfDue(): Promise<boolean> {
      const worked = performance.now() - sliceStart;
      if (worked < SLICE_MS) return false;
      const rest = Math.max(1, worked * ratio);
      const restStart = performance.now();
      await new Promise<void>((r) => setTimeout(r, rest));
      const late = Math.max(0, performance.now() - restStart - rest);
      lag = lag * (1 - LAG_SMOOTHING) + late * LAG_SMOOTHING;
      ratio = nextRestRatio(ratio, lag);
      sliceStart = performance.now();
      return true;
    },
  };
}

type SweepTarget = {
  table: string;
  columns: string[];
  /** Recompute `hashColumn = sha256(sourceColumn)` when the source changes. */
  hash?: { column: string; of: string };
  /** Route writes through the memory store (FTS sync + embedding reset). */
  memory?: boolean;
  /**
   * `column -> sealed replay column`. When the sweep redacts `column` and the
   * replay column is NULL, it seals the original there first.
   */
  replay?: Record<string, string>;
  /** Unique TEXT row key within `where`. Default `id`. */
  idColumn?: string;
  /** Static SQL filter limiting the sweep to some rows of the table. */
  where?: string;
  /**
   * Undo an encoding the scrubber cannot see through, before scrubbing. The
   * decoded form is written only when the scrub then redacts something.
   */
  decode?: (value: string) => string;
};

/** Swept in this order. Each row has a unique TEXT key (`idColumn`, default `id`). */
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
  {
    table: "workflow_run_steps",
    columns: ["input", "output", "error", "diagnostics"],
    replay: { output: "output_replay" },
  },
  {
    table: "workflow_runs",
    columns: ["triggerData", "context", "error"],
    replay: { context: "context_replay" },
  },
  // Every dreaming-v2 row copies swarm text (memory and profile pre-images, trim and heartbeat
  // state, drafts, results), so the whole namespace follows the source rows' redaction. Legacy rows
  // also kept a hex copy (`contentHex`), which is folded back into its plain field before scrubbing.
  {
    table: "kv_entries",
    columns: ["value"],
    idColumn: "key",
    where: "namespace = 'dreaming-v2'",
    decode: foldHexCopies,
  },
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
  /**
   * Scrub function, called on every text. Defaults to the selective
   * `createSweepScrubber` (tests inject to force edge cases or to run the full
   * `scrubSecrets` for comparison).
   */
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

/** Key of the record a forward-only install leaves for a rules version it did not backfill. */
export function bootScrubSkippedKey(version: number): string {
  return `boot-scrub-skipped-v${version}`;
}

export type BootScrubMode = "backfill" | "forward-only";

/**
 * `BOOT_SCRUB_MODE`: `backfill` (default) sweeps stored rows when the rules
 * version is new; `forward-only` leaves them and applies the rules to new writes only.
 * Read on every call, so the Configuration page's live reload reaches a running sweep.
 */
export function bootScrubMode(): BootScrubMode {
  return process.env.BOOT_SCRUB_MODE?.trim().toLowerCase() === "forward-only"
    ? "forward-only"
    : "backfill";
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
  if (bootScrubMode() === "forward-only") {
    await recordSkippedVersion(version);
    console.log(`[${tag}] forward-only: no historical rows swept`);
    return null;
  }
  console.log(`[${tag}] starting`);

  const stats: BootScrubTableStats[] = [];
  let halted = false;
  for (const target of BOOT_SCRUB_TARGETS) {
    const swept = await sweepTarget(target, version, opts);
    stats.push(swept.stats);
    console.log(
      `${tag}: ${target.table} scanned=${swept.stats.scanned} changed=${swept.stats.changed} skipped_invalid_json=${swept.stats.skippedInvalidJson}`,
    );
    if (swept.halted) {
      halted = true;
      break;
    }
  }

  if (halted) {
    // Switched to forward-only mid-sweep: the cursors stay, so `backfill` resumes here.
    await recordSkippedVersion(version);
    console.log(`[${tag}] halted: forward-only`);
    return stats;
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
    // This sweep ran every current rule over every row, so it covers each version a
    // forward-only install skipped up to here.
    await tx.run(
      "DELETE FROM seed_state WHERE kind = 'maintenance' AND key GLOB 'boot-scrub-skipped-v*' AND CAST(substr(key, 21) AS INTEGER) <= ?",
      [version],
    );
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

/** Remember a rules version the sweep did not run for, with the rule set it skipped. */
async function recordSkippedVersion(version: number): Promise<void> {
  await getDbClient().run(
    `INSERT INTO seed_state (kind, key, seededHash, seededAt)
     VALUES ('maintenance', ?, ?, datetime('now'))
     ON CONFLICT (kind, key) DO UPDATE SET seededHash = excluded.seededHash, seededAt = datetime('now')`,
    [bootScrubSkippedKey(version), scrubberRulesFingerprint()],
  );
}

async function sweepTarget(
  target: SweepTarget,
  version: number,
  opts: BootScrubSweepOptions,
): Promise<{ stats: BootScrubTableStats; halted: boolean }> {
  const client = getDbClient();
  const pacer = createPacer();
  // A scrubber is valid until the event loop turns: a secret registered meanwhile needs a new one.
  const freshScrub = () => opts.scrub ?? createSweepScrubber();
  let scrub = freshScrub();
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

  const idCol = target.idColumn ?? "id";
  const filter = target.where ? `${target.where} AND ` : "";
  const selectCols = [
    idCol === "id" ? "id" : `${idCol} AS id`,
    ...target.columns,
    ...(target.hash && !target.columns.includes(target.hash.column) ? [target.hash.column] : []),
    ...Object.values(target.replay ?? {}),
  ];

  let halted = false;
  for (;;) {
    if (bootScrubMode() === "forward-only") {
      halted = true;
      break;
    }
    const rows = await client.query<Record<string, string | null>>(
      `SELECT ${selectCols.join(", ")} FROM ${target.table}
       WHERE ${filter}${idCol} > ? ORDER BY ${idCol} ASC LIMIT ?`,
      [cursor, batchSize],
    );
    if (rows.length === 0) break;
    await pacer.yieldIfDue();
    scrub = freshScrub();

    // Scrub outside the transaction: regexes never run under the write lock.
    const pending: {
      id: string;
      before: Record<string, string | null>;
      after: Record<string, string | null>;
    }[] = [];
    for (const row of rows) {
      if (await pacer.yieldIfDue()) scrub = freshScrub();
      const after: Record<string, string | null> = {};
      let differs = false;
      let breaksJson = false;
      for (const col of target.columns) {
        const value = row[col];
        if (typeof value !== "string" || value.length === 0) {
          after[col] = value ?? null;
          continue;
        }
        const decoded = target.decode ? target.decode(value) : value;
        const cleaned = scrub(decoded);
        after[col] = cleaned === decoded ? value : cleaned;
        if (cleaned !== decoded) {
          differs = true;
          if (breaksJsonValidity(decoded, cleaned)) breaksJson = true;
        }
      }
      if (!differs) continue;
      if (breaksJson) {
        stats.skippedInvalidJson++;
        continue;
      }
      for (const [col, replayCol] of Object.entries(target.replay ?? {})) {
        const value = row[col];
        if (after[col] === value || typeof value !== "string" || row[replayCol] != null) continue;
        try {
          after[replayCol] = sealJson(JSON.parse(value));
        } catch {
          // Not JSON, so nothing replays it.
        }
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
    await pacer.yieldIfDue();
  }

  return { stats, halted };
}

async function rewriteRow(
  tx: DbExecutor,
  target: SweepTarget,
  id: string,
  before: Record<string, string | null>,
  after: Record<string, string | null>,
): Promise<boolean> {
  const changedCols = target.columns.filter((c) => after[c] !== before[c]);
  // Replay columns the sweep fills: only while still NULL (guarded below).
  const sealedCols = Object.values(target.replay ?? {}).filter((c) => after[c] !== undefined);
  const sets = [...changedCols, ...sealedCols].map((c) => `${c} = ?`);
  const params: DbParam[] = [...changedCols, ...sealedCols].map((c) => after[c] ?? null);
  if (target.hash && changedCols.includes(target.hash.of)) {
    sets.push(`${target.hash.column} = ?`);
    params.push(contentSha256(after[target.hash.of] ?? ""));
  }
  // Compare-and-set on every changed column.
  const guards = [...changedCols.map((c) => `${c} IS ?`), ...sealedCols.map((c) => `${c} IS NULL`)];
  params.push(id, ...changedCols.map((c) => before[c] ?? null));
  const filter = target.where ? `${target.where} AND ` : "";
  const result = await tx.run(
    `UPDATE ${target.table} SET ${sets.join(", ")} WHERE ${filter}${target.idColumn ?? "id"} = ? AND ${guards.join(" AND ")}`,
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
