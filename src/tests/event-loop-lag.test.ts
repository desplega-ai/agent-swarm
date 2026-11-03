import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { createBunSqliteClient } from "../be/db-client";
import {
  currentLoopPath,
  formatStallLine,
  recordStatement,
  startEventLoopLagProbe,
  stopEventLoopLagProbe,
  withLoopPath,
} from "../be/event-loop-lag";

const PROBE_MS = 20;

function busyWait(ms: number): void {
  const until = performance.now() + ms;
  while (performance.now() < until) {
    // Synchronous block: the event loop cannot run a timer.
  }
}

/** Wait two probe periods, so the first tick after a block has run. */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, PROBE_MS * 3));
}

const stallLines = (spy: ReturnType<typeof spyOn>): string[] =>
  spy.mock.calls.map((args) => String(args[0])).filter((l) => l.startsWith("[event-loop] stall"));

describe("event-loop lag probe", () => {
  let warn: ReturnType<typeof spyOn>;
  const savedThreshold = process.env.EVENT_LOOP_STALL_WARN_MS;

  beforeEach(async () => {
    delete process.env.EVENT_LOOP_STALL_WARN_MS;
    warn = spyOn(console, "warn").mockImplementation(() => {});
    startEventLoopLagProbe(PROBE_MS);
    await settle();
    warn.mockClear();
  });

  afterEach(() => {
    stopEventLoopLagProbe();
    warn.mockRestore();
    if (savedThreshold === undefined) delete process.env.EVENT_LOOP_STALL_WARN_MS;
    else process.env.EVENT_LOOP_STALL_WARN_MS = savedThreshold;
  });

  test("a synthetic >1 s block logs one stall line that names the code path", async () => {
    await withLoopPath("test.path", async () => {
      expect(currentLoopPath()).toBe("test.path");
      // A microtask hop keeps the path, as an awaited DB call does.
      await Promise.resolve();
      recordStatement("SELECT 1 /* first */", 400);
      recordStatement("SELECT 2   /* second */", 700);
      busyWait(1100);
    });
    await settle();

    const lines = stallLines(warn);
    expect(lines).toHaveLength(1);
    const line = lines[0]!;
    expect(line).toMatch(/^\[event-loop\] stall \d+ms path=test\.path statements=2 db_ms=1100 /);
    const stallMs = Number(line.match(/stall (\d+)ms/)?.[1]);
    expect(stallMs).toBeGreaterThanOrEqual(1000);
    expect(line).toContain("top=700ms:SELECT 2 /* second */|400ms:SELECT 1 /* first */");
    expect(line).toContain("paths=test.path:2");
  });

  test("a block under the threshold logs nothing", async () => {
    withLoopPath("test.short", () => busyWait(300));
    await settle();
    expect(stallLines(warn)).toHaveLength(0);
  });

  test("the threshold is read from EVENT_LOOP_STALL_WARN_MS", async () => {
    process.env.EVENT_LOOP_STALL_WARN_MS = "200";
    withLoopPath("test.env", () => {
      recordStatement("SELECT 3", 50);
      busyWait(300);
    });
    await settle();
    const lines = stallLines(warn);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("path=test.env");
  });

  test("a chain of awaited DB statements is one stall attributed to its entry point", async () => {
    const raw = new Database(":memory:");
    const client = createBunSqliteClient(() => raw);
    try {
      // Pure CPU in one driver call. Params are never logged.
      const sql =
        "WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < ?) SELECT count(*) AS n FROM c WHERE ? IS NOT NULL";
      // Calibrate: one statement of about 350 ms on this machine. Two passes,
      // because the first (cold) pass overestimates the per-row cost.
      let rows = 200_000;
      for (let pass = 0; pass < 2; pass++) {
        const t0 = performance.now();
        await client.get(sql, [rows, "calibrate"]);
        rows = Math.max(10_000, Math.round((350 * rows) / (performance.now() - t0)));
      }
      await settle();
      warn.mockClear();

      const startedAt = performance.now();
      await withLoopPath("test.db-chain", async () => {
        for (let i = 0; i < 5; i++) await client.get(sql, [rows, "param-secret"]);
      });
      const elapsedMs = performance.now() - startedAt;
      await settle();

      // Guard the premise: the chain must have run past the 1 s threshold.
      expect(elapsedMs).toBeGreaterThan(1000);
      const lines = stallLines(warn);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatch(/path=test\.db-chain statements=5 /);
      expect(lines[0]).toContain("paths=test.db-chain:5");
      expect(lines[0]).not.toContain("param-secret");
      // The per-statement slow line carries the same path key.
      const slow = warn.mock.calls
        .map((args) => String(args[0]))
        .filter((l) => l.includes("[db-client] slow sync statement"));
      expect(slow.length).toBe(5);
      for (const l of slow) expect(l).toContain("path=test.db-chain:");
    } finally {
      raw.close();
    }
  });
});

describe("formatStallLine", () => {
  test("reports unknown with no statements recorded (non-SQLite block)", () => {
    expect(formatStallLine(1234.4, [])).toBe(
      "[event-loop] stall 1234ms path=unknown statements=0 db_ms=0",
    );
  });

  test("names the path of the largest statement and counts every path", () => {
    const line = formatStallLine(5213, [
      { path: "slack.watcher.tick", sql: "SELECT a", ms: 100 },
      { path: "mcp.tool memory-search", sql: "SELECT b", ms: 900 },
      { path: "slack.watcher.tick", sql: "SELECT c", ms: 200 },
      { path: "slack.watcher.tick", sql: "SELECT d", ms: 50 },
    ]);
    expect(line).toBe(
      "[event-loop] stall 5213ms path=mcp.tool memory-search statements=4 db_ms=1250 top=900ms:SELECT b|200ms:SELECT c|100ms:SELECT a paths=slack.watcher.tick:3,mcp.tool memory-search:1",
    );
  });

  test("truncates and collapses SQL in the label", () => {
    const sql = `SELECT\n\n   ${"x, ".repeat(40)} FROM t`;
    const line = formatStallLine(1000, [{ path: "p", sql, ms: 20 }]);
    const label = line.match(/top=20ms:(.*) paths=/)?.[1] ?? "";
    expect(label.length).toBe(60);
    expect(label).not.toContain("\n");
    expect(label.startsWith("SELECT x, x,")).toBe(true);
  });
});
