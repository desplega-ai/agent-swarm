import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { getDb, initDb, resetDbForTests } from "../db/client.ts";
import {
  createRun,
  getAttempt,
  getRun,
  insertAttempt,
  listAttempts,
  resetErrorAttempts,
  setRunStatus,
  updateAttempt,
} from "../db/queries.ts";
import type { AttemptRow, HarnessConfig, Scenario, SwarmTask } from "../types.ts";
import { HarnessCrashError } from "./harness-crash.ts";
import {
  attemptId,
  CANCEL_REASON_DEAD_RUN,
  ensureAttemptRows,
  executeRun,
  forceCancelInactiveRun,
  InfraTaskFailureError,
  JudgeInfraError,
  pool,
  type Registry,
  reconcileOrphanedRuns,
  runAttemptWithRetry,
} from "./index.ts";

/**
 * Phase 3 status hygiene + hard cost cap + per-config concurrency, against a
 * fresh in-memory DB. The single-attempt executor and the sandbox sweeper are
 * injected, so nothing here touches E2B or any network.
 */

const ENV_KEYS = [
  "EVALS_DB_PATH",
  "EVALS_DB_SYNC_URL",
  "EVALS_DB_AUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "EVALS_SWARM_API_URL",
  "EVALS_SWARM_API_KEY",
  "EVALS_SUBSCRIPTION_CONFIG_CONCURRENCY",
  "EVALS_E2B_USD_PER_SANDBOX_HOUR",
] as const;
const saved: Record<string, string | undefined> = {};
for (const key of ENV_KEYS) saved[key] = process.env[key];

beforeEach(async () => {
  resetDbForTests();
  for (const key of ENV_KEYS) delete process.env[key];
  process.env.EVALS_DB_PATH = ":memory:";
  await initDb();
});

afterEach(() => {
  resetDbForTests();
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

const noSweep = async () => 0;

function scenario(id: string, version = 1): Scenario {
  return { id, version, name: id, tasks: [{ title: "t", description: "d" }], outcome: {} };
}

const piConfig: HarnessConfig = { id: "cfg-pi", label: "pi", provider: "pi", model: "m" };
const claudeConfig: HarnessConfig = {
  id: "cfg-claude",
  label: "claude",
  provider: "claude",
  model: "m",
};

function registryOf(scenarios: Scenario[], configs: HarnessConfig[]): Registry {
  return {
    scenarios: new Map(scenarios.map((s) => [s.id, s])),
    configs: new Map(configs.map((c) => [c.id, c])),
  };
}

async function makeRun(opts: {
  id: string;
  scenarioIds?: string[];
  configIds?: string[];
  attemptsPerCell?: number;
  concurrency?: number;
  maxMeteredUsd?: number;
  status?: "running" | "failed" | "cancelled" | "done";
}) {
  const db = getDb();
  await createRun(db, {
    id: opts.id,
    scenarioIds: opts.scenarioIds ?? ["scn"],
    configIds: opts.configIds ?? ["cfg-pi"],
    attemptsPerCell: opts.attemptsPerCell ?? 1,
    concurrency: opts.concurrency ?? 1,
    maxMeteredUsd: opts.maxMeteredUsd,
  });
  if (opts.status) await setRunStatus(db, opts.id, opts.status);
  return db;
}

async function seedAttempt(runId: string, index: number, status: AttemptRow["status"]) {
  const db = getDb();
  const id = attemptId(runId, "scn", "cfg-pi", index);
  await insertAttempt(db, {
    id,
    runId,
    scenarioId: "scn",
    configId: "cfg-pi",
    attemptIndex: index,
  });
  await updateAttempt(db, id, { status });
  return id;
}

describe("boot reaper: dead runs leave no attempt in flight", () => {
  test("cancels pending, running and judging attempts of dead runs; leaves scored ones alone", async () => {
    await makeRun({ id: "run-orphan", status: "running" });
    await makeRun({ id: "run-failed", status: "failed" });
    await makeRun({ id: "run-cancelled", status: "cancelled" });
    await makeRun({ id: "run-done", status: "done" });
    const pending = await seedAttempt("run-orphan", 0, "pending");
    const running = await seedAttempt("run-orphan", 1, "running");
    const judging = await seedAttempt("run-failed", 0, "judging");
    const stale = await seedAttempt("run-cancelled", 0, "pending");
    const passed = await seedAttempt("run-done", 0, "passed");
    const failed = await seedAttempt("run-done", 1, "failed");

    const logs: string[] = [];
    const db = getDb();
    const orphaned = await reconcileOrphanedRuns(db, (m) => logs.push(m), noSweep);

    expect(orphaned).toBe(1); // return value stays "runs marked failed"
    for (const id of [pending, running, judging, stale]) {
      const a = await getAttempt(db, id);
      expect({ id, status: a?.status, exclusion: a?.exclusion }).toEqual({
        id,
        status: "error",
        exclusion: "cancelled",
      });
      expect(a?.error).toBe(CANCEL_REASON_DEAD_RUN);
      expect(a?.finishedAt).not.toBeNull();
    }
    expect((await getAttempt(db, passed))?.status).toBe("passed");
    expect((await getAttempt(db, passed))?.exclusion).toBeNull();
    expect((await getAttempt(db, failed))?.status).toBe("failed");
    expect(logs.join("\n")).toContain("reaped 4 unfinished attempt(s)");

    const inFlight = await db.execute(
      "SELECT COUNT(*) AS n FROM attempts WHERE status IN ('pending','running','judging')",
    );
    expect(Number(inFlight.rows[0]?.n)).toBe(0);
  });

  test("is a no-op on a clean database", async () => {
    const logs: string[] = [];
    expect(await reconcileOrphanedRuns(getDb(), (m) => logs.push(m), noSweep)).toBe(0);
    expect(logs).toEqual([]);
  });

  test("resume brings reaped attempts back as real pending attempts", async () => {
    await makeRun({ id: "run-r", status: "running" });
    const id = await seedAttempt("run-r", 0, "running");
    const db = getDb();
    await reconcileOrphanedRuns(db, () => {}, noSweep);
    expect(await resetErrorAttempts(db, "run-r")).toBe(1);
    const a = await getAttempt(db, id);
    expect({ status: a?.status, exclusion: a?.exclusion, error: a?.error }).toEqual({
      status: "pending",
      exclusion: null,
      error: null,
    });
  });

  test("forceCancelInactiveRun closes out that run's attempts only", async () => {
    await makeRun({ id: "run-a", status: "failed" });
    await makeRun({ id: "run-b", status: "failed" });
    const a = await seedAttempt("run-a", 0, "pending");
    const b = await seedAttempt("run-b", 0, "pending");
    const db = getDb();
    await forceCancelInactiveRun(db, "run-a", () => {}, noSweep);
    expect((await getRun(db, "run-a"))?.status).toBe("cancelled");
    expect((await getAttempt(db, a))?.exclusion).toBe("cancelled");
    expect((await getAttempt(db, b))?.status).toBe("pending");
  });
});

describe("attempt versions", () => {
  test("ensureAttemptRows stamps scenario_version and suite_version; off-manifest stays NULL", async () => {
    // sql-audit v1 is in the suite manifest; v2 of it and an unknown id are not.
    await makeRun({
      id: "run-v",
      scenarioIds: ["sql-audit", "off-suite"],
      attemptsPerCell: 2,
    });
    const db = getDb();
    await ensureAttemptRows(
      db,
      "run-v",
      new Map([
        ["sql-audit", scenario("sql-audit", 1)],
        ["off-suite", scenario("off-suite", 3)],
      ]),
    );
    const rows = await listAttempts(db, "run-v");
    const by = (sid: string) => rows.filter((r) => r.scenarioId === sid);
    expect(by("sql-audit")).toHaveLength(2);
    for (const r of by("sql-audit")) {
      expect({ v: r.scenarioVersion, suite: r.suiteVersion }).toEqual({ v: 1, suite: "1.0" });
    }
    for (const r of by("off-suite")) {
      expect({ v: r.scenarioVersion, suite: r.suiteVersion }).toEqual({ v: 3, suite: null });
    }
  });

  test("a scenario at a version other than the manifest's is off-suite", async () => {
    await makeRun({ id: "run-v2", scenarioIds: ["sql-audit"] });
    await ensureAttemptRows(getDb(), "run-v2", new Map([["sql-audit", scenario("sql-audit", 2)]]));
    const [row] = await listAttempts(getDb(), "run-v2");
    expect({ v: row?.scenarioVersion, suite: row?.suiteVersion }).toEqual({ v: 2, suite: null });
  });

  test("rows written without versions read back NULL (pre-versioning rows)", async () => {
    await makeRun({ id: "run-old" });
    const id = await seedAttempt("run-old", 0, "passed");
    const a = await getAttempt(getDb(), id);
    expect({ v: a?.scenarioVersion, suite: a?.suiteVersion, ex: a?.exclusion }).toEqual({
      v: null,
      suite: null,
      ex: null,
    });
  });
});

/** Fake single-attempt executor: marks the attempt scored with the given spend. */
function fakeRunAttempt(spend: {
  costUsd?: number;
  judgeCostUsd?: number;
  durationMs?: number;
  onStart?: (attempt: AttemptRow) => Promise<void> | void;
  onEnd?: (attempt: AttemptRow) => void;
}): (opts: { db: import("@libsql/client").Client; attempt: AttemptRow }) => Promise<void> {
  return async ({ db, attempt }) => {
    await spend.onStart?.(attempt);
    await updateAttempt(db, attempt.id, {
      status: "passed",
      passed: true,
      score: 1,
      costUsd: spend.costUsd ?? 0,
      judgeCostUsd: spend.judgeCostUsd ?? 0,
      durationMs: spend.durationMs ?? 0,
      finishedAt: new Date().toISOString(),
    });
    spend.onEnd?.(attempt);
  };
}

describe("hard metered cost cap", () => {
  test("attempts past the cap become cancelled, and never run", async () => {
    // pi is billed per token: each attempt spends $0.10 agent + $0.05 judge = $0.15.
    await makeRun({ id: "run-cap", attemptsPerCell: 6, maxMeteredUsd: 0.25 });
    const db = getDb();
    const started: string[] = [];
    await executeRun({
      db,
      runId: "run-cap",
      registry: registryOf([scenario("scn")], [piConfig]),
      log: () => {},
      sweep: noSweep,
      runAttempt: fakeRunAttempt({
        costUsd: 0.1,
        judgeCostUsd: 0.05,
        onStart: (a) => void started.push(a.id),
      }) as never,
    });

    const rows = await listAttempts(db, "run-cap");
    const passed = rows.filter((r) => r.status === "passed");
    const cancelled = rows.filter((r) => r.exclusion === "cancelled");
    // $0.15 after one, $0.30 after two (>= cap): the third and later never start.
    expect(passed).toHaveLength(2);
    expect(cancelled).toHaveLength(4);
    expect(started).toHaveLength(2);
    for (const r of cancelled) {
      expect(r.status).toBe("error");
      expect(r.error).toContain("metered cost cap of $0.25");
      expect(r.finishedAt).not.toBeNull();
    }
    expect((await getRun(db, "run-cap"))?.status).toBe("done");
    expect((await getRun(db, "run-cap"))?.maxMeteredUsd).toBe(0.25);
  });

  test("a subscription config's agent cost is not metered; only judge spend counts", async () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "oauth-test-token";
    await makeRun({
      id: "run-sub",
      configIds: ["cfg-claude"],
      attemptsPerCell: 5,
      maxMeteredUsd: 0.25,
    });
    const db = getDb();
    await executeRun({
      db,
      runId: "run-sub",
      registry: registryOf([scenario("scn")], [claudeConfig]),
      log: () => {},
      sweep: noSweep,
      // $5 of notional agent cost per attempt must not trip a $0.25 cap; judge is $0.01.
      runAttempt: fakeRunAttempt({ costUsd: 5, judgeCostUsd: 0.01 }) as never,
    });
    const rows = await listAttempts(db, "run-sub");
    expect(rows.every((r) => r.status === "passed")).toBe(true);
  });

  test("the same claude config is metered when it authenticates with an API key", async () => {
    // No OAuth token: the sandbox would get ANTHROPIC_API_KEY, which bills per token.
    await makeRun({
      id: "run-claude-key",
      configIds: ["cfg-claude"],
      attemptsPerCell: 4,
      maxMeteredUsd: 1,
    });
    const db = getDb();
    await executeRun({
      db,
      runId: "run-claude-key",
      registry: registryOf([scenario("scn")], [claudeConfig]),
      log: () => {},
      sweep: noSweep,
      runAttempt: fakeRunAttempt({ costUsd: 0.6 }) as never,
    });
    const rows = await listAttempts(db, "run-claude-key");
    expect(rows.filter((r) => r.status === "passed")).toHaveLength(2);
    expect(rows.filter((r) => r.exclusion === "cancelled")).toHaveLength(2);
  });

  test("E2B sandbox time counts toward the cap", async () => {
    process.env.EVALS_E2B_USD_PER_SANDBOX_HOUR = "1";
    await makeRun({ id: "run-e2b", attemptsPerCell: 4, maxMeteredUsd: 0.5 });
    const db = getDb();
    const registry = registryOf([scenario("scn")], [piConfig]);
    await executeRun({
      db,
      runId: "run-e2b",
      registry,
      log: () => {},
      sweep: noSweep,
      // 1 hour of wall clock; no worker roster recorded -> API sandbox + 1 worker = 2
      // sandboxes -> $2 at $1/sandbox-hour: the first attempt alone passes the cap.
      runAttempt: fakeRunAttempt({ durationMs: 3_600_000 }) as never,
    });
    const rows = await listAttempts(db, "run-e2b");
    expect(rows.filter((r) => r.status === "passed")).toHaveLength(1);
    expect(rows.filter((r) => r.exclusion === "cancelled")).toHaveLength(3);
  });

  test("a resumed run starts from what it already spent", async () => {
    await makeRun({ id: "run-resume", attemptsPerCell: 3, maxMeteredUsd: 0.2 });
    const db = getDb();
    const registry = registryOf([scenario("scn")], [piConfig]);
    await ensureAttemptRows(db, "run-resume", registry.scenarios);
    // Attempt 0 already finished in a previous execution and spent $0.30.
    await updateAttempt(db, attemptId("run-resume", "scn", "cfg-pi", 0), {
      status: "passed",
      costUsd: 0.3,
    });
    const started: string[] = [];
    await executeRun({
      db,
      runId: "run-resume",
      registry,
      log: () => {},
      sweep: noSweep,
      runAttempt: fakeRunAttempt({ onStart: (a) => void started.push(a.id) }) as never,
    });
    expect(started).toEqual([]);
    const rows = await listAttempts(db, "run-resume");
    expect(rows.filter((r) => r.exclusion === "cancelled")).toHaveLength(2);
  });

  test("no cap means no cancellation", async () => {
    await makeRun({ id: "run-nocap", attemptsPerCell: 3 });
    const db = getDb();
    await executeRun({
      db,
      runId: "run-nocap",
      registry: registryOf([scenario("scn")], [piConfig]),
      log: () => {},
      sweep: noSweep,
      runAttempt: fakeRunAttempt({ costUsd: 100 }) as never,
    });
    expect((await listAttempts(db, "run-nocap")).every((r) => r.status === "passed")).toBe(true);
  });
});

describe("cancelling a run", () => {
  test("attempts left unfinished when the run is cancelled are closed out, not left pending", async () => {
    await makeRun({ id: "run-abort", attemptsPerCell: 4, concurrency: 1 });
    const db = getDb();
    const controller = new AbortController();
    await executeRun({
      db,
      runId: "run-abort",
      registry: registryOf([scenario("scn")], [piConfig]),
      log: () => {},
      sweep: noSweep,
      signal: controller.signal,
      // First attempt is in flight when the cancel arrives: it goes back to pending
      // (as runAttemptWithRetry does), and the rest never start.
      runAttempt: (async ({ db: d, attempt }: { db: typeof db; attempt: AttemptRow }) => {
        controller.abort();
        await updateAttempt(d, attempt.id, { status: "pending" });
      }) as never,
    });
    const rows = await listAttempts(db, "run-abort");
    expect(rows.every((r) => r.status === "error" && r.exclusion === "cancelled")).toBe(true);
    expect((await getRun(db, "run-abort"))?.status).toBe("cancelled");
    // ...and resume can still pick them all up.
    expect(await resetErrorAttempts(db, "run-abort")).toBe(4);
  });
});

describe("per-config concurrency cap", () => {
  async function maxConcurrent(
    configs: HarnessConfig[],
    runId: string,
    attemptsPerCell: number,
    concurrency: number,
  ): Promise<Record<string, number>> {
    await makeRun({
      id: runId,
      configIds: configs.map((c) => c.id),
      attemptsPerCell,
      concurrency,
    });
    const db = getDb();
    const active: Record<string, number> = {};
    const max: Record<string, number> = {};
    await executeRun({
      db,
      runId,
      registry: registryOf([scenario("scn")], configs),
      log: () => {},
      sweep: noSweep,
      runAttempt: (async ({ db: d, attempt }: { db: typeof db; attempt: AttemptRow }) => {
        const key = attempt.configId;
        active[key] = (active[key] ?? 0) + 1;
        max[key] = Math.max(max[key] ?? 0, active[key] ?? 0);
        await Bun.sleep(15);
        active[key] = (active[key] ?? 1) - 1;
        await updateAttempt(d, attempt.id, { status: "passed" });
      }) as never,
    });
    return max;
  }

  test("a subscription config never runs more attempts at once than its cap; a metered one is bounded only by the run", async () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "oauth-test-token";
    process.env.EVALS_SUBSCRIPTION_CONFIG_CONCURRENCY = "2";
    const max = await maxConcurrent([claudeConfig, piConfig], "run-conc", 6, 6);
    expect(max["cfg-claude"]).toBe(2);
    expect(max["cfg-pi"]).toBeGreaterThan(2);
  });

  test("defaults to 3 for subscription configs", async () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "oauth-test-token";
    const max = await maxConcurrent([claudeConfig], "run-conc-default", 8, 8);
    expect(max["cfg-claude"]).toBe(3);
  });

  test("every attempt still runs when the cap is lower than the run's concurrency", async () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "oauth-test-token";
    process.env.EVALS_SUBSCRIPTION_CONFIG_CONCURRENCY = "1";
    await maxConcurrent([claudeConfig], "run-conc-one", 5, 4);
    const rows = await listAttempts(getDb(), "run-conc-one");
    expect(rows).toHaveLength(5);
    expect(rows.every((r) => r.status === "passed")).toBe(true);
  });
});

describe("pool", () => {
  test("without a keyed limit it behaves as before: all items, at most `concurrency` at once", async () => {
    let active = 0;
    let max = 0;
    const seen: number[] = [];
    await pool([1, 2, 3, 4, 5, 6], 3, async (n) => {
      active++;
      max = Math.max(max, active);
      await Bun.sleep(5);
      seen.push(n);
      active--;
    });
    expect(seen.sort()).toEqual([1, 2, 3, 4, 5, 6]);
    expect(max).toBe(3);
  });

  test("shouldStop halts scheduling", async () => {
    const ran: number[] = [];
    let stop = false;
    await pool(
      [1, 2, 3, 4],
      1,
      async (n) => {
        ran.push(n);
        stop = true;
      },
      () => stop,
    );
    expect(ran).toEqual([1]);
  });

  test("a blocked key does not starve other keys, and waiting workers wake up", async () => {
    const order: string[] = [];
    await pool(
      ["a1", "a2", "a3", "b1"],
      3,
      async (item) => {
        order.push(`start:${item}`);
        await Bun.sleep(item.startsWith("a") ? 20 : 1);
        order.push(`end:${item}`);
      },
      undefined,
      { keyOf: (item) => item[0] as string, limitOf: (key) => (key === "a" ? 1 : 10) },
    );
    // a-items run one at a time, but b1 is not stuck behind a2/a3.
    expect(order.indexOf("start:b1")).toBeLessThan(order.indexOf("start:a3"));
    expect(order.filter((o) => o.startsWith("end:"))).toHaveLength(4);
    const aRuns = order.filter((o) => /:(a\d)/.test(o));
    for (let i = 0; i < aRuns.length; i += 2) {
      expect(aRuns[i]?.startsWith("start:")).toBe(true);
      expect(aRuns[i + 1]?.startsWith("end:")).toBe(true);
    }
  });
});

describe("harness crashes end as error, excluded from scores", () => {
  const scn = scenario("scn");
  const registry = registryOf([scn], [piConfig]);

  async function runWith(throwing: () => Error, maxRetries = 1) {
    await makeRun({ id: "run-crash" });
    const db = getDb();
    await ensureAttemptRows(db, "run-crash", registry.scenarios);
    const attempt = (await listAttempts(db, "run-crash"))[0] as AttemptRow;
    let tries = 0;
    await runAttemptWithRetry({
      db,
      attempt,
      registry,
      maxRetries,
      judgeModel: null,
      log: () => {},
      runOnce: async () => {
        tries++;
        throw throwing();
      },
    });
    return { row: (await getAttempt(db, attempt.id)) as AttemptRow, tries };
  }

  const crash = (kind: "context-overflow" | "provider-error", retryable: boolean) =>
    new HarnessCrashError({ kind, retryable, detail: "boom" }, "task-1");

  test("a context overflow ends as error + harness-error on the first try (no pointless retry)", async () => {
    const { row, tries } = await runWith(() => crash("context-overflow", false));
    expect(tries).toBe(1);
    expect(row.status).toBe("error");
    expect(row.exclusion).toBe("harness-error");
    expect(row.error).toContain("harness crash (context-overflow)");
    expect(row.error).toContain("Excluded from scores");
    expect(row.score).toBeNull();
  });

  test("a provider error is retried on a fresh sandbox, then ends as harness-error", async () => {
    const { row, tries } = await runWith(() => crash("provider-error", true));
    expect(tries).toBe(2);
    expect(row.status).toBe("error");
    expect(row.exclusion).toBe("harness-error");
    expect(row.retries).toBe(1);
  });

  test("the existing infra net counts as a harness fault too", async () => {
    const { row } = await runWith(
      () => new InfraTaskFailureError("opencode-spawn-timeout", "task-1", "infra failure (x)"),
    );
    expect(row.status).toBe("error");
    expect(row.exclusion).toBe("harness-error");
  });

  test("a judge flake or a plain runner error is an error but not a harness-error", async () => {
    const judge = await runWith(() => new JudgeInfraError("correctness", "judge died"), 0);
    expect(judge.row.status).toBe("error");
    expect(judge.row.exclusion).toBeNull();
  });

  test("an excluded attempt does not count in a run summary's pass rate", async () => {
    const { summarizeRun } = await import("../results.ts");
    await makeRun({ id: "run-summary", attemptsPerCell: 4 });
    const db = getDb();
    await ensureAttemptRows(db, "run-summary", registry.scenarios);
    const ids = [0, 1, 2, 3].map((i) => attemptId("run-summary", "scn", "cfg-pi", i));
    await updateAttempt(db, ids[0] as string, { status: "passed", score: 1 });
    await updateAttempt(db, ids[1] as string, { status: "failed", score: 0 });
    await updateAttempt(db, ids[2] as string, { status: "error", exclusion: "harness-error" });
    await updateAttempt(db, ids[3] as string, { status: "error", exclusion: "cancelled" });
    const run = (await getRun(db, "run-summary")) as NonNullable<
      Awaited<ReturnType<typeof getRun>>
    >;
    const summary = summarizeRun(run, await listAttempts(db, "run-summary"));
    const cell = summary.cells[0];
    // 1 passed of 2 scored: the crash and the cancellation are not in the denominator.
    expect(cell?.finished).toBe(2);
    expect(cell?.passRate).toBe(0.5);
    // The harness error stays visible; the cancellation is not an error.
    expect(cell?.errors).toBe(1);
    expect(summary.totals.errorAttempts).toBe(1);
  });
});

describe("task-level harness crash detection", () => {
  const task = (over: Partial<SwarmTask>): SwarmTask => ({
    id: "t1",
    title: "t",
    description: "d",
    status: "failed",
    ...over,
  });

  test("processTerminalTask throws HarnessCrashError for a context overflow", async () => {
    const { processTerminalTask } = await import("./index.ts");
    expect(() =>
      processTerminalTask(
        task({
          failureReason:
            '400: {"message":"This endpoint\'s maximum context length is 131072 tokens. However, you requested about 140000 tokens"}',
        }),
      ),
    ).toThrow(HarnessCrashError);
  });

  test("a model-caused failure is still a plain failed task", async () => {
    const { processTerminalTask } = await import("./index.ts");
    const loop = task({
      failureReason:
        'tool-loop: Detected ping-pong loop: alternating between "get-task-details" and "bash" for 8 calls.',
    });
    expect(processTerminalTask(loop)).toEqual(loop);
  });
});
