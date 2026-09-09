// Unit tests for the OTEL metric/span emission path added to
// src/be/db-retention.ts (recordDbRetentionSweep / recordDbRetentionStatement
// calls, and the db.retention.table span) and its facade in src/otel.ts /
// src/otel-impl.ts.
//
// Coverage goals:
//   1. otel.ts's facade is a no-op when OTEL_EXPORTER_OTLP_ENDPOINT is unset.
//   2. otel-impl's recordDbRetentionSweep emits every metric with the right
//      tags, including the outcome-only-on-two-instruments rule.
//   3. A failed sweep emits exactly one outcome:error point.
//   4. Dry run reports rowsDeleted: 0 and the indexed backlog count.
//   5. recordDbRetentionStatement emits one histogram point per call.
//   6. db-retention.ts's real per-table error path sets an ERROR span status
//      and records the exception, and still calls recordDbRetentionSweep.
//   7. db-retention.ts calls recordDbRetentionStatement once per DELETE
//      actually issued during a real sweep.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { unlink } from "node:fs/promises";
import type { Counter, Gauge, Histogram } from "@opentelemetry/api";
import { closeDb, getDbClient, initDb } from "../be/db";
import {
  _injectCountersForTests,
  _injectRetentionInstrumentsForTests,
  recordDbRetentionStatement as recordDbRetentionStatementImpl,
  recordDbRetentionSweep as recordDbRetentionSweepImpl,
} from "../otel-impl";

function mockInstrument() {
  return mock((..._args: unknown[]) => {});
}

/**
 * ensureInstruments() in otel-impl.ts guards ALL instrument creation
 * (cost/token/drift AND retention) behind a single `if (costCounter) return`
 * check. Every call to recordDbRetentionSweep/recordDbRetentionStatement
 * touches every one of its 7/1 instruments unconditionally, so a test must
 * inject a full set — a partial injection crashes on the untouched fields —
 * and must first satisfy the shared guard (via _injectCountersForTests),
 * or ensureInstruments() overwrites the injected mocks with real (no-op)
 * ones before the assertion ever sees them.
 */
function injectFullRetentionMocks() {
  const dummyCostCounter = { add: mockInstrument() };
  _injectCountersForTests(
    dummyCostCounter as unknown as Counter,
    dummyCostCounter as unknown as Counter,
    dummyCostCounter as unknown as Counter,
  );

  const sweeps = { add: mockInstrument() };
  const rowsDeleted = { add: mockInstrument() };
  const backlog = { record: mockInstrument() };
  const batches = { add: mockInstrument() };
  const tableDuration = { record: mockInstrument() };
  const slowestStatement = { record: mockInstrument() };
  const statementDuration = { record: mockInstrument() };
  const batchSize = { record: mockInstrument() };

  _injectRetentionInstrumentsForTests({
    sweeps: sweeps as unknown as Counter,
    rowsDeleted: rowsDeleted as unknown as Counter,
    backlog: backlog as unknown as Gauge,
    batches: batches as unknown as Counter,
    tableDuration: tableDuration as unknown as Histogram,
    slowestStatement: slowestStatement as unknown as Gauge,
    statementDuration: statementDuration as unknown as Histogram,
    batchSize: batchSize as unknown as Gauge,
  });

  return {
    sweeps,
    rowsDeleted,
    backlog,
    batches,
    tableDuration,
    slowestStatement,
    statementDuration,
    batchSize,
  };
}

describe("otel.ts db-retention facade — no-op when OTEL_EXPORTER_OTLP_ENDPOINT is unset", () => {
  test("recordDbRetentionSweep and recordDbRetentionStatement do not throw and touch no instrument", async () => {
    const { sweeps } = injectFullRetentionMocks();
    const { recordDbRetentionSweep, recordDbRetentionStatement } = await import("../otel");

    expect(() =>
      recordDbRetentionSweep({
        table: "session_logs",
        dryRun: false,
        outcome: "converged",
        rowsDeleted: 1,
        backlogRemaining: 0,
        batches: 1,
        tableDurationMs: 5,
        slowestStatementMs: 5,
        batchSize: 500,
      }),
    ).not.toThrow();
    expect(() => recordDbRetentionStatement("session_logs", false, 5)).not.toThrow();
    expect(sweeps.add).not.toHaveBeenCalled();
  });
});

describe("otel-impl recordDbRetentionSweep / recordDbRetentionStatement", () => {
  test("a successful sweep emits every metric, outcome tagged only on sweeps and table_duration_ms", () => {
    const mocks = injectFullRetentionMocks();

    recordDbRetentionSweepImpl({
      table: "session_logs",
      dryRun: false,
      outcome: "converged",
      rowsDeleted: 500,
      backlogRemaining: 0,
      batches: 3,
      tableDurationMs: 120,
      slowestStatementMs: 45,
      batchSize: 500,
    });

    const tableAttrs = { table: "session_logs", dry_run: false };
    expect(mocks.sweeps.add).toHaveBeenCalledWith(1, { ...tableAttrs, outcome: "converged" });
    expect(mocks.rowsDeleted.add).toHaveBeenCalledWith(500, tableAttrs);
    expect(mocks.backlog.record).toHaveBeenCalledWith(0, tableAttrs);
    expect(mocks.batches.add).toHaveBeenCalledWith(3, tableAttrs);
    expect(mocks.tableDuration.record).toHaveBeenCalledWith(120, {
      ...tableAttrs,
      outcome: "converged",
    });
    expect(mocks.slowestStatement.record).toHaveBeenCalledWith(45, tableAttrs);
    expect(mocks.batchSize.record).toHaveBeenCalledWith(500, tableAttrs);
  });

  test("a failed sweep emits exactly one outcome:error point on sweeps", () => {
    const mocks = injectFullRetentionMocks();

    recordDbRetentionSweepImpl({
      table: "agent_log",
      dryRun: false,
      outcome: "error",
      rowsDeleted: 0,
      backlogRemaining: 10,
      batches: 0,
      tableDurationMs: 5,
      slowestStatementMs: 0,
      batchSize: 500,
    });

    expect(mocks.sweeps.add).toHaveBeenCalledTimes(1);
    expect(mocks.sweeps.add).toHaveBeenCalledWith(1, {
      table: "agent_log",
      dry_run: false,
      outcome: "error",
    });
  });

  test("dry run emits rows_deleted: 0 and a backlog point equal to the indexed count", () => {
    const mocks = injectFullRetentionMocks();

    recordDbRetentionSweepImpl({
      table: "events",
      dryRun: true,
      outcome: "budget_exhausted",
      rowsDeleted: 0,
      backlogRemaining: 1_148_407,
      batches: 0,
      tableDurationMs: 72,
      slowestStatementMs: 0,
      batchSize: 500,
    });

    expect(mocks.rowsDeleted.add).toHaveBeenCalledWith(0, { table: "events", dry_run: true });
    expect(mocks.backlog.record).toHaveBeenCalledWith(1_148_407, {
      table: "events",
      dry_run: true,
    });
  });

  test("per-statement histogram receives one point per call", () => {
    const mocks = injectFullRetentionMocks();

    recordDbRetentionStatementImpl("events", false, 12);
    recordDbRetentionStatementImpl("events", false, 8);
    recordDbRetentionStatementImpl("events", false, 30);

    expect(mocks.statementDuration.record).toHaveBeenCalledTimes(3);
    expect(mocks.statementDuration.record.mock.calls[0]).toEqual([
      12,
      { table: "events", dry_run: false },
    ]);
  });
});

// ── Integration: db-retention.ts's actual call sites ────────────────────────
// mock.module is process-global and never auto-restored, so this section runs
// last in the file and spreads the real "../otel" module, overriding only
// startSpan / recordDbRetentionSweep / recordDbRetentionStatement — withSpan
// (a NOOP here, since OTEL_EXPORTER_OTLP_ENDPOINT is unset) stays real.
const fakeTableSpan = {
  setAttribute: mock(function (this: unknown) {
    return this;
  }),
  setAttributes: mock(function (this: unknown) {
    return this;
  }),
  addEvent: mock(function (this: unknown) {
    return this;
  }),
  recordException: mock((_err: unknown) => {}),
  setStatus: mock(function (this: unknown) {
    return this;
  }),
  end: mock(() => {}),
};
const startSpanSpy = mock((_name: string, _attrs?: unknown) => fakeTableSpan);
const recordDbRetentionSweepSpy = mock((_m: unknown) => {});
const recordDbRetentionStatementSpy = mock(
  (_table: string, _dryRun: boolean, _durationMs: number) => {},
);

const actualOtel = await import("../otel");
// Snapshot the real withSpan BEFORE mock.module runs: mock.module mutates the
// live namespace object, so a later `actualOtel.withSpan` read returns the spy
// and the spy would call itself forever.
const realWithSpan = actualOtel.withSpan;
// Delegates to the real (NOOP) withSpan unless a test overrides it, so the
// throw-injection tests can fail `withSpan` itself and not just its body.
const withSpanSpy = mock(realWithSpan);
mock.module("../otel", () => ({
  ...actualOtel,
  withSpan: withSpanSpy,
  startSpan: startSpanSpy,
  recordDbRetentionSweep: recordDbRetentionSweepSpy,
  recordDbRetentionStatement: recordDbRetentionStatementSpy,
}));

const {
  DB_RETENTION_TABLES,
  getDbRetentionStats,
  resetDbRetentionForTests,
  runDbRetentionTick,
  stopDbRetention,
} = await import("../be/db-retention");

const TEST_DB_PATH = "./test-db-retention-telemetry.sqlite";
const NOW = new Date("2026-08-23T12:00:00.000Z");

async function removeDbFiles(): Promise<void> {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      await unlink(TEST_DB_PATH + suffix);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
  }
}

async function insertRow(id: string, createdAt: string): Promise<void> {
  await getDbClient().run(
    "INSERT INTO session_logs (id, sessionId, iteration, cli, content, lineNumber, createdAt) VALUES (?, ?, 0, 'bun', 'log', 1, ?)",
    [id, `session-${id}`, createdAt],
  );
}

/** Bulk-insert via a recursive CTE — far cheaper than one INSERT per row. */
async function bulkInsertRows(idPrefix: string, count: number, createdAt: string): Promise<void> {
  await getDbClient().run(
    `WITH RECURSIVE candidates(value) AS (
       SELECT 1
       UNION ALL
       SELECT value + 1 FROM candidates WHERE value < ${count}
     )
     INSERT INTO session_logs (id, sessionId, iteration, cli, content, lineNumber, createdAt)
     SELECT '${idPrefix}-' || value, '${idPrefix}-session', 0, 'bun', 'log', value, ?
     FROM candidates`,
    [createdAt],
  );
}

async function countSessionLogs(): Promise<number> {
  const row = await getDbClient().get<{ n: number }>("SELECT COUNT(*) AS n FROM session_logs");
  return row?.n ?? 0;
}

describe("db-retention.ts telemetry wiring (integration)", () => {
  beforeAll(async () => {
    await removeDbFiles();
    initDb(TEST_DB_PATH);
  });

  afterAll(async () => {
    await resetDbRetentionForTests();
    closeDb();
    await removeDbFiles();
  });

  beforeEach(async () => {
    await resetDbRetentionForTests();
    for (const table of DB_RETENTION_TABLES) await getDbClient().run(`DELETE FROM ${table.table}`);
    for (const key of [
      "SESSION_LOG_RETENTION_DAYS",
      "AGENT_LOG_RETENTION_DAYS",
      "EVENTS_RETENTION_DAYS",
      "DB_RETENTION_DRY_RUN",
    ]) {
      delete process.env[key];
    }
    // Restore, not just clear: the throw-injection tests below replace these
    // implementations, and a leaked throw would fail an unrelated test.
    withSpanSpy.mockImplementation(realWithSpan);
    startSpanSpy.mockImplementation(() => fakeTableSpan);
    fakeTableSpan.setAttributes.mockImplementation(function (this: unknown) {
      return this;
    });
    recordDbRetentionSweepSpy.mockImplementation(() => {});
    recordDbRetentionStatementSpy.mockImplementation(() => {});
    withSpanSpy.mockClear();
    startSpanSpy.mockClear();
    fakeTableSpan.recordException.mockClear();
    fakeTableSpan.setStatus.mockClear();
    recordDbRetentionSweepSpy.mockClear();
    recordDbRetentionStatementSpy.mockClear();
  });

  afterEach(async () => {
    await stopDbRetention();
  });

  test("a successful sweep calls recordDbRetentionSweep with outcome: converged", async () => {
    await insertRow("old", "2026-08-01T00:00:00.000Z");
    process.env.SESSION_LOG_RETENTION_DAYS = "1";

    await runDbRetentionTick({ now: NOW });

    expect(recordDbRetentionSweepSpy).toHaveBeenCalledTimes(1);
    expect(recordDbRetentionSweepSpy.mock.calls[0]![0]).toMatchObject({
      table: "session_logs",
      dryRun: false,
      outcome: "converged",
      rowsDeleted: 1,
    });
  });

  test("a failed sweep sets an ERROR span status, records the exception, and still emits the metric", async () => {
    process.env.SESSION_LOG_RETENTION_DAYS = "1";
    const client = getDbClient();
    await client.run("ALTER TABLE session_logs RENAME TO session_logs_test_hidden");
    try {
      await runDbRetentionTick({ now: NOW });
    } finally {
      await client.run("ALTER TABLE session_logs_test_hidden RENAME TO session_logs");
    }

    // An errored table is still "undrained", so pass 2 retries it once more
    // within the same tick (ample budget remains after a near-instant
    // failure) — every attempt gets its own span and metric point.
    expect(fakeTableSpan.recordException).toHaveBeenCalledTimes(2);
    expect(fakeTableSpan.setStatus).toHaveBeenCalledTimes(2);
    for (const call of fakeTableSpan.setStatus.mock.calls) {
      expect((call[0] as { code: number }).code).toBe(2);
    }
    expect(recordDbRetentionSweepSpy).toHaveBeenCalledTimes(2);
    for (const call of recordDbRetentionSweepSpy.mock.calls) {
      expect(call[0]).toMatchObject({ outcome: "error" });
    }
  });

  test("a failed tick after a successful one emits rowsDeleted: 0, not the previous tick's counter value", async () => {
    await insertRow("old", "2026-08-01T00:00:00.000Z");
    process.env.SESSION_LOG_RETENTION_DAYS = "1";

    await runDbRetentionTick({ now: NOW });
    expect(recordDbRetentionSweepSpy).toHaveBeenCalledTimes(1);
    expect(recordDbRetentionSweepSpy.mock.calls[0]![0]).toMatchObject({
      outcome: "converged",
      rowsDeleted: 1,
      batches: 1,
    });
    recordDbRetentionSweepSpy.mockClear();

    // Force the next tick to fail on the same table, the way the sibling
    // "a failed sweep" test above does.
    const client = getDbClient();
    await client.run("ALTER TABLE session_logs RENAME TO session_logs_test_hidden");
    try {
      await runDbRetentionTick({ now: NOW });
    } finally {
      await client.run("ALTER TABLE session_logs_test_hidden RENAME TO session_logs");
    }

    // rowsDeleted/batches feed monotonic Counters: an error emission must
    // never replay the prior tick's 1 row / 1 batch, or the counters inflate
    // on every catch-up retry without a matching real deletion. Zero here is
    // the delta THIS attempt committed — the table is gone, so its very first
    // DELETE threw and no batch completed. It is not the error path forcing a
    // zero: a failure after a committed batch reports that batch (see the
    // sibling test below).
    expect(recordDbRetentionSweepSpy).toHaveBeenCalled();
    for (const call of recordDbRetentionSweepSpy.mock.calls) {
      expect(call[0]).toMatchObject({
        outcome: "error",
        rowsDeleted: 0,
        batches: 0,
        slowestStatementMs: 0,
      });
    }
    const stats = getDbRetentionStats().sessionLogs;
    expect(stats?.rowsDeleted).toBe(0);
    expect(stats?.batches).toBe(0);
    expect(stats?.slowestStatementMs).toBe(0);
    // The running total keeps the 1 row the successful tick really deleted,
    // and the failure adds nothing to it.
    expect(stats?.cumulativeRowsDeleted).toBe(1);
  });

  test("a failure after a committed batch reports that batch's rows, exactly once", async () => {
    // Regression: sweepTable accumulated each autocommitted DELETE, but a
    // later DELETE or the closing COUNT(*) failing skipped the return and the
    // catch emitted rowsDeleted: 0 / batches: 0. Those rows are gone from the
    // table, so the monotonic counters and cumulativeRowsDeleted stayed
    // permanently short of the rows retention really deleted.
    process.env.SESSION_LOG_RETENTION_DAYS = "1";
    const client = getDbClient();
    // Exactly one initial batch (500) of older rows, then 100 newer ones. The
    // first DELETE changes as many rows as it requested, so the loop does NOT
    // treat it as the last batch and goes round again — into the trigger.
    await bulkInsertRows("ok", 500, "2026-08-01T00:00:00.000Z");
    await bulkInsertRows("boom", 100, "2026-08-02T00:00:00.000Z");
    await client.run(
      `CREATE TRIGGER session_logs_second_batch_fails BEFORE DELETE ON session_logs
       WHEN OLD.id LIKE 'boom-%'
       BEGIN SELECT RAISE(ABORT, 'injected second-batch failure'); END`,
    );
    try {
      await runDbRetentionTick({ now: NOW });
    } finally {
      await client.run("DROP TRIGGER session_logs_second_batch_fails");
    }

    // Batch 1 autocommitted: its 500 rows are gone for good, and the aborted
    // batch left its own 100 rows in place.
    expect(await countSessionLogs()).toBe(100);

    const emissions = recordDbRetentionSweepSpy.mock.calls.map(
      (call) => call[0] as { outcome: string; rowsDeleted: number; batches: number },
    );
    expect(emissions.length).toBeGreaterThan(0);
    for (const emission of emissions) expect(emission.outcome).toBe("error");
    // The failing attempt carries the batch it committed instead of zero.
    expect(emissions[0]).toMatchObject({ rowsDeleted: 500, batches: 1 });
    // Summed over every emission this tick, the counters advance by exactly
    // the rows that left the table: no under-report, and no double count when
    // pass 2 retries the still-undrained table and commits nothing.
    expect(emissions.reduce((sum, emission) => sum + emission.rowsDeleted, 0)).toBe(500);
    expect(emissions.reduce((sum, emission) => sum + emission.batches, 0)).toBe(1);
    expect(getDbRetentionStats().sessionLogs?.cumulativeRowsDeleted).toBe(500);
  });

  test("a dry run emits rows_deleted: 0 and the indexed backlog count", async () => {
    for (let i = 0; i < 5; i++) await insertRow(`dry-${i}`, "2026-08-01T00:00:00.000Z");
    process.env.SESSION_LOG_RETENTION_DAYS = "1";
    process.env.DB_RETENTION_DRY_RUN = "true";

    await runDbRetentionTick({ now: NOW });

    // A dry run never deletes, so a nonzero backlog can never become
    // "drained". Pass 2 would only repeat the same indexed count, so the tick
    // skips it: exactly one sweep point per table per dry-run tick.
    expect(recordDbRetentionSweepSpy).toHaveBeenCalledTimes(1);
    expect(recordDbRetentionSweepSpy.mock.calls[0]![0]).toMatchObject({
      rowsDeleted: 0,
      backlogRemaining: 5,
      dryRun: true,
    });
  });

  // ── Throw injection: telemetry must never break the drain ────────────────

  test("a throwing startSpan, span method and sweep metric still delete every row", async () => {
    for (let i = 0; i < 5; i++) await insertRow(`throw-${i}`, "2026-08-01T00:00:00.000Z");
    process.env.SESSION_LOG_RETENTION_DAYS = "1";

    // Every retention telemetry call throws, for the whole tick.
    startSpanSpy.mockImplementation(() => {
      throw new Error("otel startSpan exploded");
    });
    fakeTableSpan.setAttributes.mockImplementation(() => {
      throw new Error("otel setAttributes exploded");
    });
    recordDbRetentionSweepSpy.mockImplementation(() => {
      throw new Error("otel sweep metric exploded");
    });
    // A non-Error throw exercises the normalizer's non-Error branch.
    recordDbRetentionStatementSpy.mockImplementation(() => {
      throw "otel statement metric exploded";
    });

    // The tick must resolve, not reject.
    await runDbRetentionTick({ now: NOW });

    const remaining = await getDbClient().get<{ n: number }>(
      "SELECT COUNT(*) AS n FROM session_logs",
    );
    expect(remaining?.n).toBe(0);
    // A completed DELETE stays a success: telemetry failure is not sweep failure.
    const stats = getDbRetentionStats().sessionLogs;
    expect(stats?.outcome).toBe("converged");
    expect(stats?.rowsDeleted).toBe(5);
    expect(stats?.lastError).toBeUndefined();
  });

  test("a throwing withSpan still runs the sweep, without a tick span", async () => {
    for (let i = 0; i < 3; i++) await insertRow(`nospan-${i}`, "2026-08-01T00:00:00.000Z");
    process.env.SESSION_LOG_RETENTION_DAYS = "1";

    withSpanSpy.mockImplementation(() => {
      throw new Error("otel withSpan exploded before it called the body");
    });

    await runDbRetentionTick({ now: NOW });

    const remaining = await getDbClient().get<{ n: number }>(
      "SELECT COUNT(*) AS n FROM session_logs",
    );
    expect(remaining?.n).toBe(0);
    expect(getDbRetentionStats().sessionLogs?.outcome).toBe("converged");
  });

  test("a sweep error is scrubbed before it reaches retention stats", async () => {
    process.env.SESSION_LOG_RETENTION_DAYS = "1";
    await insertRow("secret-boom", "2026-08-01T00:00:00.000Z");
    const client = getDbClient();
    // A BEFORE DELETE trigger is the one way to control a real SQLite error
    // message from the production DELETE path, with no module mocking.
    const token = `sk-ant-${"a1B2c3D4e5".repeat(3)}`;
    await client.run(
      `CREATE TRIGGER session_logs_scrub_probe BEFORE DELETE ON session_logs
       BEGIN SELECT RAISE(ABORT, 'connect failed with ${token}'); END`,
    );
    try {
      await runDbRetentionTick({ now: NOW });
    } finally {
      await client.run("DROP TRIGGER session_logs_scrub_probe");
    }

    const stats = getDbRetentionStats().sessionLogs;
    expect(stats?.outcome).toBe("error");
    expect(stats?.lastError).toContain("[REDACTED:anthropic_key]");
    expect(stats?.lastError).not.toContain(token);
    // The same scrubbed text, not the raw throw, goes onto the span status.
    const statuses = fakeTableSpan.setStatus.mock.calls.map(
      (call) => (call[0] as { message?: string }).message ?? "",
    );
    expect(statuses.length).toBeGreaterThan(0);
    for (const message of statuses) expect(message).not.toContain(token);
  });

  test("recordDbRetentionStatement is called once per DELETE issued in the sweep", async () => {
    for (let i = 0; i < 5; i++) await insertRow(`stmt-${i}`, "2026-08-01T00:00:00.000Z");
    process.env.SESSION_LOG_RETENTION_DAYS = "1";

    await runDbRetentionTick({ now: NOW });

    const stats = getDbRetentionStats().sessionLogs;
    expect(stats?.batches).toBeGreaterThan(0);
    expect(recordDbRetentionStatementSpy).toHaveBeenCalledTimes(stats!.batches);
  });
});
