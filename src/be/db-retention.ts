import { AsyncLocalStorage } from "node:async_hooks";
import type { Attributes, DbRetentionSweepMetric, SpanStatus, SwarmSpan } from "../otel";
import { recordDbRetentionStatement, recordDbRetentionSweep, startSpan, withSpan } from "../otel";
import { isEnvFlagEnabled } from "../utils/env-flag";
import { scrubSecrets } from "../utils/secret-scrubber";
import { getDbClient } from "./db";
import { DB_RETENTION_TUNING_BOUNDS, MAX_DB_RETENTION_DAYS } from "./swarm-config-guard";

const DAY_MS = 24 * 60 * 60 * 1000;
const RETENTION_INTERVAL_MS = 60 * 60 * 1000;
const DEFAULT_TICK_BUDGET_MS = 30_000;
const DEFAULT_CATCHUP_INTERVAL_MS = 60_000;
const DEFAULT_MAX_STATEMENT_MS = 250;
const DEFAULT_BATCH_SIZE = 500;
const MIN_BATCH_SIZE = 50;
const MAX_BATCH_SIZE = 2_000;
const YIELD_MS = 25;

/**
 * This is deliberately a closed list. Neither table nor column names may come
 * from operator configuration: a retention policy must never target a table
 * that code review has not explicitly approved as safe to delete from.
 */
export const DB_RETENTION_TABLES = [
  {
    table: "session_logs",
    timeColumn: "createdAt",
    envKey: "SESSION_LOG_RETENTION_DAYS",
    metricsKey: "sessionLogs",
  },
  {
    table: "agent_log",
    timeColumn: "createdAt",
    envKey: "AGENT_LOG_RETENTION_DAYS",
    metricsKey: "agentLog",
  },
  {
    table: "events",
    timeColumn: "createdAt",
    envKey: "EVENTS_RETENTION_DAYS",
    metricsKey: "events",
  },
] as const satisfies ReadonlyArray<{
  table: string;
  timeColumn: string;
  envKey: string;
  metricsKey: string;
  initialBatchSize?: number;
}>;

type RetentionTable = (typeof DB_RETENTION_TABLES)[number];
type RetentionMetricsKey = RetentionTable["metricsKey"];

export type DbRetentionOutcome = "converged" | "budget_exhausted" | "error";

export type DbRetentionTableStats = {
  at: string;
  /** Deleted rows. Always 0 when dryRun is true — the would-delete count is in backlogRemaining. */
  rowsDeleted: number;
  batches: number;
  durationMs: number;
  dryRun: boolean;
  cumulativeRowsDeleted: number;
  outcome: DbRetentionOutcome;
  drained: boolean;
  backlogRemaining: number;
  batchSize: number;
  slowestStatementMs: number;
  lastError?: string;
  lastErrorAt?: string;
  lastSuccessAt?: string;
};

export type DbRetentionStats = Partial<Record<RetentionMetricsKey, DbRetentionTableStats>>;

/** Test-only controls; production callers always use the env-derived defaults. */
export type DbRetentionTickOptions = {
  now?: Date;
};

type SweepResult = {
  rowsDeleted: number;
  batches: number;
  backlogRemaining: number;
  drained: boolean;
  slowestStatementMs: number;
  batchSize: number;
};

/** What a sweep had already committed when it failed. */
type SweepProgress = {
  rowsDeleted: number;
  batches: number;
  slowestStatementMs: number;
  batchSize: number;
};

/**
 * Carries the batches a failed sweep already committed out with its error.
 *
 * Every batch is its own autocommit DELETE, so a batch that returned has
 * removed its rows for good — a later batch or the closing COUNT(*) failing
 * does not bring them back. Reporting zero for that sweep left
 * `cumulativeRowsDeleted` and the monotonic OTel counters permanently short of
 * the rows retention really deleted.
 *
 * `sweepCause` (not `cause`) keeps the original throw reachable without
 * depending on `Error.cause` being present in the configured TS lib.
 */
class SweepPartialProgressError extends Error {
  constructor(
    readonly sweepCause: unknown,
    readonly progress: SweepProgress,
  ) {
    super("db-retention sweep failed partway through");
    this.name = "SweepPartialProgressError";
  }
}

let retentionTimer: ReturnType<typeof setInterval> | null = null;
let catchupTimer: ReturnType<typeof setTimeout> | null = null;
let retentionTickPromise: Promise<void> | null = null;
let retentionAbortController: AbortController | null = null;
let retentionStats: DbRetentionStats = {};
let cumulativeRowsDeleted: Partial<Record<RetentionMetricsKey, number>> = {};
let batchSizeByTable: Partial<Record<RetentionMetricsKey, number>> = {};
let tickCount = 0;
let lastSweepOrder: RetentionMetricsKey[] = [];

// Timers must not inherit an open database transaction from their caller.
const scheduleContextFree = AsyncLocalStorage.snapshot();

/**
 * A sweep error reaches three egress points — the `retention` block of
 * GET /api/metrics, the console, and the span status — so it is normalized and
 * scrubbed once, here. A throw is not guaranteed to be an `Error`.
 */
function normalizeError(err: unknown): string {
  const raw =
    err instanceof Error
      ? err.message
      : typeof err === "string"
        ? err
        : (() => {
            try {
              return JSON.stringify(err) ?? String(err);
            } catch {
              return String(err);
            }
          })();
  return scrubSecrets(raw || String(err));
}

/**
 * Telemetry is best-effort: a throwing OTel implementation must never reject a
 * retention tick nor turn a completed DELETE into a failed sweep. Every span
 * and metric call in this module goes through here. Only the first failure of a
 * tick is logged, so a permanently broken exporter cannot flood the log with
 * one line per batch.
 */
let telemetryFailuresThisTick = 0;

function bestEffortTelemetry(what: string, fn: () => void): void {
  try {
    fn();
  } catch (err) {
    telemetryFailuresThisTick += 1;
    if (telemetryFailuresThisTick === 1) {
      console.warn(`[db-retention] telemetry ${what} failed (ignored):`, normalizeError(err));
    }
  }
}

const NOOP_RETENTION_SPAN: SwarmSpan = {
  setAttribute: () => NOOP_RETENTION_SPAN,
  setAttributes: () => NOOP_RETENTION_SPAN,
  addEvent: () => NOOP_RETENTION_SPAN,
  recordException: () => {},
  setStatus: () => NOOP_RETENTION_SPAN,
  end: () => {},
};

/** Wrap a span so no method on it can throw into the drain path. */
function bestEffortSpan(span: SwarmSpan): SwarmSpan {
  const safe: SwarmSpan = {
    setAttribute: (key: string, value: Parameters<SwarmSpan["setAttribute"]>[1]) => {
      bestEffortTelemetry("span.setAttribute", () => span.setAttribute(key, value));
      return safe;
    },
    setAttributes: (attributes: Attributes) => {
      bestEffortTelemetry("span.setAttributes", () => span.setAttributes(attributes));
      return safe;
    },
    addEvent: (name: string, attributes?: Attributes) => {
      bestEffortTelemetry("span.addEvent", () => span.addEvent(name, attributes));
      return safe;
    },
    recordException: (error: unknown) => {
      bestEffortTelemetry("span.recordException", () => span.recordException(error));
    },
    setStatus: (status: SpanStatus) => {
      bestEffortTelemetry("span.setStatus", () => span.setStatus(status));
      return safe;
    },
    end: () => {
      bestEffortTelemetry("span.end", () => span.end());
    },
  };
  return safe;
}

function bestEffortStartSpan(name: string, attributes?: Attributes): SwarmSpan {
  let span: SwarmSpan = NOOP_RETENTION_SPAN;
  bestEffortTelemetry("startSpan", () => {
    span = startSpan(name, attributes);
  });
  return span === NOOP_RETENTION_SPAN ? span : bestEffortSpan(span);
}

function bestEffortRecordSweep(metric: DbRetentionSweepMetric): void {
  bestEffortTelemetry("recordDbRetentionSweep", () => recordDbRetentionSweep(metric));
}

function bestEffortRecordStatement(table: string, dryRun: boolean, durationMs: number): void {
  bestEffortTelemetry("recordDbRetentionStatement", () =>
    recordDbRetentionStatement(table, dryRun, durationMs),
  );
}

function readPositiveIntEnv(key: string, env: NodeJS.ProcessEnv = process.env): number | null {
  const raw = env[key]?.trim();
  if (!raw || !/^\d+$/.test(raw)) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= 1 && value <= MAX_DB_RETENTION_DAYS ? value : null;
}

/** Reject a non-digit string. A parsed-but-out-of-range value falls back rather than breaking the server. */
function readBoundedIntEnv(
  key: string,
  min: number,
  max: number,
  fallback: number,
  env: NodeJS.ProcessEnv = process.env,
): number {
  const raw = env[key]?.trim();
  if (!raw || !/^\d+$/.test(raw)) return fallback;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= min && value <= max ? value : fallback;
}

/**
 * Read a tuning knob against the shared bounds the config API validates
 * against, so neither side can drift into accepting what the other ignores.
 */
function readTuningEnv(key: keyof typeof DB_RETENTION_TUNING_BOUNDS, fallback: number): number {
  const { min, max } = DB_RETENTION_TUNING_BOUNDS[key];
  return readBoundedIntEnv(key, min, max, fallback);
}

function yieldTick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, YIELD_MS));
}

function retentionDays(table: RetentionTable): number | null {
  return readPositiveIntEnv(table.envKey);
}

function dryRunEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.DB_RETENTION_DRY_RUN;
  if (raw === undefined || raw.trim() === "") return false;
  return isEnvFlagEnabled("DB_RETENTION_DRY_RUN", true, env);
}

async function indexedBacklogCount(table: RetentionTable, cutoff: string): Promise<number> {
  const row = await getDbClient().get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM ${table.table} WHERE ${table.timeColumn} < ?`,
    [cutoff],
  );
  return row?.n ?? 0;
}

async function sweepTable(
  table: RetentionTable,
  cutoff: string,
  dryRun: boolean,
  deadline: number,
  signal: AbortSignal,
  maxStatementMs: number,
): Promise<SweepResult> {
  const client = getDbClient();

  if (dryRun) {
    const backlogRemaining = await indexedBacklogCount(table, cutoff);
    return {
      rowsDeleted: 0,
      batches: 0,
      backlogRemaining,
      drained: backlogRemaining === 0,
      slowestStatementMs: 0,
      batchSize: batchSizeByTable[table.metricsKey] ?? DEFAULT_BATCH_SIZE,
    };
  }

  let rowsDeleted = 0;
  let batches = 0;
  let slowestStatementMs = 0;
  let size = batchSizeByTable[table.metricsKey] ?? DEFAULT_BATCH_SIZE;

  try {
    while (!signal.aborted && Date.now() < deadline) {
      const limitUsed = size;
      // Never wrap multiple batches in a transaction: one autocommit DELETE per
      // batch, so the write lock and any event-loop stall end with each statement.
      const result = await client.runTimed(
        `DELETE FROM ${table.table} WHERE rowid IN (
         SELECT rowid FROM ${table.table} WHERE ${table.timeColumn} < ? ORDER BY ${table.timeColumn} LIMIT ?
       )`,
        [cutoff, limitUsed],
      );
      // Execution time only. Wall time around the call also covers waiting for
      // the client's FIFO lock and its BUSY backoff sleeps, neither of which
      // this statement spent in the driver: charging those to the stall metric
      // reported a responsive process as stalled and halved the batch size for
      // queueing rather than for work. See DbClient.runTimed.
      const elapsed = result.executionMs;
      bestEffortRecordStatement(table.table, dryRun, elapsed);
      slowestStatementMs = Math.max(slowestStatementMs, elapsed);
      rowsDeleted += result.changes;
      batches += 1;

      if (elapsed > maxStatementMs) {
        size = Math.max(MIN_BATCH_SIZE, Math.floor(size / 2));
      } else if (elapsed < maxStatementMs / 5) {
        size = Math.min(MAX_BATCH_SIZE, size * 2);
      }

      // A DELETE that changed fewer rows than the LIMIT it used means the
      // subquery ran out of matches, so there is nothing left to delete in this
      // pass. It does NOT prove the table is drained: each DELETE autocommits,
      // so another process can commit an already-expired row before the count
      // below runs. Loop control only — `drained` comes from that count.
      if (result.changes < limitUsed) break;
      if (signal.aborted || Date.now() >= deadline) break;
      await yieldTick();
    }

    // `drained` is derived from this count, never from the last DELETE's row
    // count. The two can disagree: a short final DELETE says "no matches left",
    // but the statement autocommitted, so a concurrent writer can land another
    // expired row before the COUNT(*) runs. Reporting drained: true alongside
    // backlogRemaining > 0 drops the table from `undrained`, leaves catch-up
    // unarmed, and publishes that contradiction on /api/metrics until the next
    // hourly tick.
    const backlogRemaining = await indexedBacklogCount(table, cutoff);
    return {
      rowsDeleted,
      batches,
      backlogRemaining,
      drained: backlogRemaining === 0,
      slowestStatementMs,
      batchSize: size,
    };
  } catch (err) {
    // A failing DELETE or a failing closing COUNT(*) must not erase the
    // batches that already committed above.
    throw new SweepPartialProgressError(err, {
      rowsDeleted,
      batches,
      slowestStatementMs,
      batchSize: size,
    });
  } finally {
    // The adaptive size is learned per batch, so it survives a mid-sweep
    // failure the same way the deleted rows do.
    batchSizeByTable[table.metricsKey] = size;
  }
}

/** Run one bounded sweep over every enabled table. Failures are isolated per table. */
export function runDbRetentionTick(options: DbRetentionTickOptions = {}): Promise<void> {
  if (retentionTickPromise) return retentionTickPromise;

  const abortController = new AbortController();
  retentionAbortController = abortController;
  const promise = Promise.resolve().then(async () => {
    try {
      // Clear any pending catch-up timer at the start of a new tick so timers
      // cannot accumulate.
      if (catchupTimer) {
        clearTimeout(catchupTimer);
        catchupTimer = null;
      }

      tickCount += 1;
      telemetryFailuresThisTick = 0;
      const tickStartedAt = Date.now();
      const cutoffBase = options.now ?? new Date(tickStartedAt);
      const dryRun = dryRunEnabled();
      const budget = readTuningEnv("DB_RETENTION_TICK_BUDGET_MS", DEFAULT_TICK_BUDGET_MS);
      const catchupIntervalMs = readTuningEnv(
        "DB_RETENTION_CATCHUP_INTERVAL_MS",
        DEFAULT_CATCHUP_INTERVAL_MS,
      );
      const maxStatementMs = readTuningEnv(
        "DB_RETENTION_MAX_STATEMENT_MS",
        DEFAULT_MAX_STATEMENT_MS,
      );

      const sweepAllTables = async (rawTickSpan: SwarmSpan): Promise<void> => {
        const tickSpan = bestEffortSpan(rawTickSpan);
        const tickDeadline = tickStartedAt + budget;
        const enabled = DB_RETENTION_TABLES.filter((table) => retentionDays(table) !== null);
        if (enabled.length === 0) {
          lastSweepOrder = [];
          tickSpan.setAttributes({
            "agentswarm.retention.tables_enabled": 0,
            "agentswarm.retention.catchup": false,
            "agentswarm.retention.duration_ms": Date.now() - tickStartedAt,
            "agentswarm.retention.outcome": "converged",
          });
          return; // emit nothing; retention: {} stays honest
        }

        const slice = Math.floor(budget / enabled.length);
        const startIndex = tickCount % enabled.length;
        const order = [...enabled.slice(startIndex), ...enabled.slice(0, startIndex)];
        lastSweepOrder = order.map((table) => table.metricsKey);

        let deletedAny = false;
        let anyError = false;
        const undrained = new Set<RetentionMetricsKey>();

        const sweepOne = async (table: RetentionTable, tableDeadline: number): Promise<void> => {
          const days = retentionDays(table);
          if (days === null) return;
          const startedAt = Date.now();
          const previous = retentionStats[table.metricsKey];
          const tableSpan = bestEffortStartSpan("db.retention.table", {
            "agentswarm.retention.table": table.table,
          });
          try {
            const cutoff = new Date(cutoffBase.getTime() - days * DAY_MS).toISOString();
            const result = await sweepTable(
              table,
              cutoff,
              dryRun,
              tableDeadline,
              abortController.signal,
              maxStatementMs,
            );
            deletedAny ||= !dryRun && result.rowsDeleted > 0;
            const cumulative =
              (cumulativeRowsDeleted[table.metricsKey] ?? 0) + (dryRun ? 0 : result.rowsDeleted);
            cumulativeRowsDeleted[table.metricsKey] = cumulative;
            const outcome: DbRetentionOutcome = result.drained ? "converged" : "budget_exhausted";
            if (result.drained) undrained.delete(table.metricsKey);
            else undrained.add(table.metricsKey);

            const durationMs = Date.now() - startedAt;
            const nowIso = new Date().toISOString();
            retentionStats[table.metricsKey] = {
              at: nowIso,
              rowsDeleted: result.rowsDeleted,
              batches: result.batches,
              durationMs,
              dryRun,
              cumulativeRowsDeleted: cumulative,
              outcome,
              drained: result.drained,
              backlogRemaining: result.backlogRemaining,
              batchSize: result.batchSize,
              slowestStatementMs: result.slowestStatementMs,
              lastError: previous?.lastError,
              lastErrorAt: previous?.lastErrorAt,
              lastSuccessAt: nowIso,
            };
            tableSpan.setAttributes({
              "agentswarm.retention.rows_deleted": result.rowsDeleted,
              "agentswarm.retention.backlog_remaining": result.backlogRemaining,
              "agentswarm.retention.batches": result.batches,
              "agentswarm.retention.duration_ms": durationMs,
              "agentswarm.retention.slowest_statement_ms": result.slowestStatementMs,
              "agentswarm.retention.batch_size": result.batchSize,
              "agentswarm.retention.outcome": outcome,
            });
            bestEffortRecordSweep({
              table: table.table,
              dryRun,
              outcome,
              rowsDeleted: result.rowsDeleted,
              backlogRemaining: result.backlogRemaining,
              batches: result.batches,
              tableDurationMs: durationMs,
              slowestStatementMs: result.slowestStatementMs,
              batchSize: result.batchSize,
            });
            if (result.rowsDeleted > 0) {
              console.log(
                `[db-retention] ${table.table}: ${dryRun ? "would delete" : "deleted"} ${result.rowsDeleted} row(s) in ${result.batches} batch(es) after ${durationMs}ms`,
              );
            }
          } catch (err) {
            anyError = true;
            undrained.add(table.metricsKey);
            // sweepTable wraps a mid-sweep failure so the batches it already
            // committed survive the throw; anything else failed before the
            // first batch and carries no progress.
            const partial = err instanceof SweepPartialProgressError ? err : null;
            const cause = partial ? partial.sweepCause : err;
            const message = normalizeError(cause);
            const durationMs = Date.now() - startedAt;
            const nowIso = new Date().toISOString();
            // rowsDeleted/batches feed monotonic Counters (recordDbRetentionSweep in
            // src/otel-impl.ts), so this emission must be THIS attempt's real delta:
            //  - never a previous sweep's value, or the catch-up retry loop inflates the
            //    counters every DB_RETENTION_CATCHUP_INTERVAL_MS with no matching deletion,
            //  - never a double count: a failed sweep returns no SweepResult, so no
            //    success-path emission reports these batches as well,
            //  - never zero when batches did commit. Each batch autocommits, so those rows
            //    are gone from the table; dropping them left the counters and
            //    cumulativeRowsDeleted permanently short of real deletions.
            // backlogRemaining stays at the previous value (it is a gauge, not a counter):
            // zeroing it would read as "drained" and blind the backlog-not-draining monitor.
            const rowsDeleted = dryRun ? 0 : (partial?.progress.rowsDeleted ?? 0);
            const backlogRemaining = previous?.backlogRemaining ?? 0;
            const batches = partial?.progress.batches ?? 0;
            const slowestStatementMs = partial?.progress.slowestStatementMs ?? 0;
            const batchSize =
              partial?.progress.batchSize ??
              previous?.batchSize ??
              batchSizeByTable[table.metricsKey] ??
              DEFAULT_BATCH_SIZE;
            // Committed rows advance the running total and justify the vacuum,
            // exactly as they would have on the success path.
            const cumulative = (cumulativeRowsDeleted[table.metricsKey] ?? 0) + rowsDeleted;
            cumulativeRowsDeleted[table.metricsKey] = cumulative;
            deletedAny ||= rowsDeleted > 0;
            retentionStats[table.metricsKey] = {
              at: nowIso,
              rowsDeleted,
              batches,
              durationMs,
              dryRun,
              cumulativeRowsDeleted: cumulative,
              outcome: "error",
              drained: false,
              backlogRemaining,
              batchSize,
              slowestStatementMs,
              lastError: message,
              lastErrorAt: nowIso,
              lastSuccessAt: previous?.lastSuccessAt,
            };
            tableSpan.recordException(cause);
            tableSpan.setStatus({ code: 2, message });
            bestEffortRecordSweep({
              table: table.table,
              dryRun,
              outcome: "error",
              rowsDeleted,
              backlogRemaining,
              batches,
              tableDurationMs: durationMs,
              slowestStatementMs,
              batchSize,
            });
            console.error(`[db-retention] ${table.table} sweep failed:`, message);
          } finally {
            tableSpan.end();
          }
        };

        // Pass 1: every enabled table gets an even slice of the tick budget.
        for (const [index, table] of order.entries()) {
          if (abortController.signal.aborted || Date.now() >= tickDeadline) {
            // A table the pass never reached is undrained too. Without this,
            // one slow leading table hides every table behind it from the
            // catch-up check below, and they wait for the hourly timer.
            for (const skipped of order.slice(index)) undrained.add(skipped.metricsKey);
            break;
          }
          const tableDeadline = Math.min(Date.now() + slice, tickDeadline);
          await sweepOne(table, tableDeadline);
        }
        // Pass 2: catch-up within the same tick for tables pass 1 left
        // undrained. A dry run deletes nothing, so a second attempt can only
        // repeat the same COUNT(*) — skip it.
        if (!dryRun) {
          for (const table of order) {
            if (abortController.signal.aborted || Date.now() >= tickDeadline) break;
            if (!undrained.has(table.metricsKey)) continue;
            await sweepOne(table, tickDeadline);
          }
        }

        if (deletedAny && !abortController.signal.aborted) {
          try {
            // Harmless when auto_vacuum is not INCREMENTAL; never run a blocking VACUUM here.
            await getDbClient().run("PRAGMA incremental_vacuum(2000)");
          } catch (err) {
            console.error("[db-retention] incremental vacuum failed:", normalizeError(err));
          }
        }

        // A dry run never deletes, so its backlog never shrinks: arming
        // catch-up on it would re-count every catchupIntervalMs forever.
        const catchupArmed = !dryRun && undrained.size > 0 && !abortController.signal.aborted;
        if (catchupArmed) {
          catchupTimer = scheduleContextFree(() =>
            setTimeout(() => void runDbRetentionTick(), catchupIntervalMs),
          );
          if (typeof catchupTimer.unref === "function") catchupTimer.unref();
        }

        tickSpan.setAttributes({
          "agentswarm.retention.tables_enabled": enabled.length,
          "agentswarm.retention.catchup": catchupArmed,
          "agentswarm.retention.duration_ms": Date.now() - tickStartedAt,
          "agentswarm.retention.outcome": anyError
            ? "error"
            : undrained.size > 0
              ? "budget_exhausted"
              : "converged",
        });
      };

      // `withSpan` is telemetry too. If the OTel implementation throws before it
      // ever calls the body, the sweep still has to run — just without a span.
      // A body failure is captured separately so it is never mistaken for one.
      let sweepStarted = false;
      let sweepError: unknown;
      try {
        await withSpan(
          "db.retention.tick",
          async (rawTickSpan) => {
            sweepStarted = true;
            try {
              await sweepAllTables(rawTickSpan);
            } catch (err) {
              sweepError = err;
            }
          },
          { "agentswarm.retention.dry_run": dryRun },
        );
      } catch (err) {
        telemetryFailuresThisTick += 1;
        console.warn("[db-retention] telemetry tick span failed (ignored):", normalizeError(err));
      }
      if (!sweepStarted) await sweepAllTables(NOOP_RETENTION_SPAN);
      if (sweepError !== undefined) throw sweepError;
    } finally {
      if (retentionAbortController === abortController) retentionAbortController = null;
      retentionTickPromise = null;
    }
  });
  retentionTickPromise = promise;
  return promise;
}

export function getDbRetentionStats(): DbRetentionStats {
  return { ...retentionStats };
}

/** Test-only: the sweep order (by metricsKey) used on the most recent tick. */
export function _getLastSweepOrderForTests(): RetentionMetricsKey[] {
  return [...lastSweepOrder];
}

/** Start the hourly sweep. The first tick runs immediately. */
export async function startDbRetention(intervalMs = RETENTION_INTERVAL_MS): Promise<void> {
  if (retentionTimer) return;
  const configured = DB_RETENTION_TABLES.map(
    (table) => `${table.table}=${retentionDays(table) ?? "disabled"}`,
  ).join(", ");
  console.log(`[db-retention] starting (${configured}, dryRun=${dryRunEnabled()})`);
  retentionTimer = scheduleContextFree(() =>
    setInterval(() => void runDbRetentionTick(), intervalMs),
  );
  if (typeof retentionTimer.unref === "function") retentionTimer.unref();
  await runDbRetentionTick();
}

export async function stopDbRetention(): Promise<void> {
  if (retentionTimer) {
    clearInterval(retentionTimer);
    retentionTimer = null;
  }
  if (catchupTimer) {
    clearTimeout(catchupTimer);
    catchupTimer = null;
  }
  retentionAbortController?.abort();
  await retentionTickPromise;
}

/** Test hook to prevent module state leaking between Bun test files. */
export async function resetDbRetentionForTests(): Promise<void> {
  await stopDbRetention();
  retentionStats = {};
  cumulativeRowsDeleted = {};
  batchSizeByTable = {};
  tickCount = 0;
  lastSweepOrder = [];
}
