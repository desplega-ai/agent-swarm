import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Client } from "@libsql/client";
import { getDb, initDb, resetDbForTests } from "../db/client.ts";
import {
  createRun,
  getRun,
  insertAttempt,
  listRerunRuns,
  listRuns,
  setRunStatus,
  updateAttempt,
} from "../db/queries.ts";
import { loadRegistry } from "../registry.ts";
import {
  buildRunRegression,
  buildRunSummaryText,
  isScheduledPreset,
  onRunFinished,
  RERUN_MAX_METERED_USD,
  type RunCompletionDeps,
  slackWebhookPoster,
} from "./run-completion.ts";

const OPUS = "claude-opus-5.5";
const LUNA = "codex-6-luna";
const MODEL = "claude-opus-5-5";
const ENV_KEYS = ["EVALS_DB_PATH", "EVALS_DB_SYNC_URL", "EVALS_DB_AUTH_TOKEN"] as const;
const saved: Record<string, string | undefined> = {};
for (const key of ENV_KEYS) saved[key] = process.env[key];

let db: Client;
beforeEach(async () => {
  resetDbForTests();
  for (const key of ENV_KEYS) delete process.env[key];
  process.env.EVALS_DB_PATH = ":memory:";
  await initDb();
  db = getDb();
});
afterEach(() => {
  resetDbForTests();
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

/** "cancelled": closed by the cost cap before it ran, as the runner writes it. */
type Result = "passed" | "failed" | "error" | "cancelled";
interface CellSpec {
  configId: string;
  scenarioId: string;
  results: Result[];
  model?: string;
}

let seq = 0;
/** Seed one run with its attempts. `night` orders runs of the same preset (later = newer). */
async function seedRun(opts: {
  id: string;
  night: number;
  preset?: string;
  rerunOf?: string;
  status?: "done" | "failed" | "cancelled" | "running";
  cells: CellSpec[];
}): Promise<void> {
  await createRun(db, {
    id: opts.id,
    name: opts.id,
    scenarioIds: [...new Set(opts.cells.map((c) => c.scenarioId))],
    configIds: [...new Set(opts.cells.map((c) => c.configId))],
    attemptsPerCell: 3,
    concurrency: 2,
    maxMeteredUsd: 2,
    preset: opts.preset,
    rerunOf: opts.rerunOf,
  });
  await db.execute({
    sql: "UPDATE eval_runs SET created_at = ? WHERE id = ?",
    args: [`2026-10-${String(opts.night).padStart(2, "0")}T03:00:00.000Z`, opts.id],
  });
  for (const cell of opts.cells) {
    for (const [i, result] of cell.results.entries()) {
      const id = `${opts.id}_${cell.scenarioId}_${cell.configId}_${i}_${seq++}`;
      await insertAttempt(db, {
        id,
        runId: opts.id,
        scenarioId: cell.scenarioId,
        configId: cell.configId,
        attemptIndex: i,
        scenarioVersion: 1,
        suiteVersion: "1.0",
      });
      if (result === "cancelled") {
        await updateAttempt(db, id, {
          status: "error",
          exclusion: "cancelled",
          error: "metered cost cap reached",
        });
        continue;
      }
      await updateAttempt(db, id, {
        status: result,
        score: result === "passed" ? 0.9 : result === "failed" ? 0.2 : null,
        passed: result === "passed",
        error: result === "error" ? "sandbox died" : null,
        costUsd: 0.1,
        judgeCostUsd: 0.01,
        durationMs: 60_000,
        resolvedModel: cell.model ?? MODEL,
      });
    }
  }
  await setRunStatus(db, opts.id, opts.status ?? "done");
}

const allPass = (scenarioId: string, configId = OPUS): CellSpec => ({
  configId,
  scenarioId,
  results: ["passed", "passed", "passed"],
});

/** Five clean earlier nights: 15 graded attempts per cell, enough baseline. */
async function seedBaseline(cells: CellSpec[] = [allPass("sql-audit")], nights = 5) {
  for (let n = 1; n <= nights; n++) {
    await seedRun({ id: `night-${n}`, night: n, preset: "nightly-canary", cells });
  }
}

interface Harness {
  deps: RunCompletionDeps;
  posts: string[];
  started: string[];
  logs: string[];
}
function harness(over: Partial<RunCompletionDeps> = {}): Harness {
  const posts: string[] = [];
  const started: string[] = [];
  const logs: string[] = [];
  const deps: RunCompletionDeps = {
    db,
    registry: loadRegistry(),
    startRun: (id) => {
      started.push(id);
      return true;
    },
    postSlack: async (text) => {
      posts.push(text);
    },
    publicUrl: "https://evals.example.test/",
    log: (msg) => logs.push(msg),
    ...over,
  };
  return { deps, posts, started, logs };
}

describe("onRunFinished", () => {
  test("ignores runs that were not started from a scheduled preset", async () => {
    await seedRun({ id: "adhoc", night: 20, cells: [allPass("sql-audit")] });
    await seedRun({
      id: "ui-frontier",
      night: 21,
      preset: "frontier",
      cells: [allPass("sql-audit")],
    });
    const h = harness();
    await onRunFinished(h.deps, "adhoc");
    await onRunFinished(h.deps, "ui-frontier");
    await onRunFinished(h.deps, "no-such-run");
    expect(h.posts).toEqual([]);
    expect(h.started).toEqual([]);
    expect(await listRuns(db)).toHaveLength(2);
  });

  test("a clean run posts one summary and a second completion does not post again", async () => {
    await seedBaseline();
    await seedRun({
      id: "tonight",
      night: 10,
      preset: "nightly-canary",
      cells: [allPass("sql-audit")],
    });
    const h = harness();
    await onRunFinished(h.deps, "tonight");
    await onRunFinished(h.deps, "tonight"); // e.g. a resume finishing later
    expect(h.posts).toHaveLength(1);
    const text = h.posts[0]!;
    expect(text).toContain(":white_check_mark: *Nightly canary: clean*");
    expect(text).toContain("<https://evals.example.test/#/runs/tonight|tonight>");
    expect(text).toContain("sql-audit");
    expect(text).toContain("3/3");
    expect((await getRun(db, "tonight"))?.summaryPostedAt).not.toBeNull();
    expect(h.started).toEqual([]);
  });

  test("a run the cost cap stopped posts one summary with the cancelled count and starts no rerun", async () => {
    await seedBaseline([allPass("sql-audit"), allPass("sql-audit", LUNA)]);
    await seedRun({
      id: "tonight",
      night: 10,
      preset: "nightly-canary",
      cells: [
        { configId: OPUS, scenarioId: "sql-audit", results: ["passed", "passed", "cancelled"] },
        {
          configId: LUNA,
          scenarioId: "sql-audit",
          results: ["cancelled", "cancelled", "cancelled"],
        },
      ],
    });
    const h = harness();
    await onRunFinished(h.deps, "tonight");
    await onRunFinished(h.deps, "tonight");
    expect(h.posts).toHaveLength(1);
    expect(h.posts[0]).toContain("4 attempts were cancelled");
    expect(h.posts[0]).not.toContain("PAGE");
    expect(h.started).toEqual([]);
    expect((await getRun(db, "tonight"))?.summaryPostedAt).not.toBeNull();
  });

  test("3 of 3 failures page at once and start no rerun", async () => {
    await seedBaseline();
    await seedRun({
      id: "tonight",
      night: 10,
      preset: "nightly-canary",
      cells: [{ configId: OPUS, scenarioId: "sql-audit", results: ["failed", "failed", "failed"] }],
    });
    const h = harness();
    await onRunFinished(h.deps, "tonight");
    expect(h.posts).toHaveLength(1);
    expect(h.posts[0]).toContain(":rotating_light: *Nightly canary: PAGE*");
    expect(h.posts[0]).toContain("every attempt failed");
    expect(h.started).toEqual([]);
    expect(await listRerunRuns(db, "tonight")).toEqual([]);
  });

  test("1 of 3 failing is noise: posts a clean summary and starts nothing", async () => {
    await seedBaseline();
    await seedRun({
      id: "tonight",
      night: 10,
      preset: "nightly-canary",
      cells: [{ configId: OPUS, scenarioId: "sql-audit", results: ["passed", "passed", "failed"] }],
    });
    const h = harness();
    await onRunFinished(h.deps, "tonight");
    expect(h.posts).toHaveLength(1);
    expect(h.posts[0]).toContain("clean");
    expect(h.started).toEqual([]);
  });

  test("2 of 3 failing starts one rerun and holds the summary until it finishes", async () => {
    await seedBaseline([allPass("sql-audit"), allPass("sql-audit", LUNA)]);
    await seedRun({
      id: "tonight",
      night: 10,
      preset: "nightly-canary",
      cells: [
        { configId: OPUS, scenarioId: "sql-audit", results: ["passed", "failed", "failed"] },
        allPass("sql-audit", LUNA),
      ],
    });
    const h = harness();
    await onRunFinished(h.deps, "tonight");

    expect(h.posts).toEqual([]); // nothing posted yet
    const reruns = await listRerunRuns(db, "tonight");
    expect(reruns).toHaveLength(1);
    const rerun = reruns[0]!;
    expect(h.started).toEqual([rerun.id]);
    expect(rerun.rerunOf).toBe("tonight");
    expect(rerun.preset).toBeNull(); // a rerun is not a scheduled run itself
    expect(rerun.attemptsPerCell).toBe(6);
    expect(rerun.maxMeteredUsd).toBe(RERUN_MAX_METERED_USD);
    expect(rerun.scenarioIds).toEqual(["sql-audit"]);
    expect(rerun.configIds).toEqual([OPUS]); // only the flagged config

    // The parent completing again while the rerun is in flight must not start a second one.
    await onRunFinished(h.deps, "tonight");
    expect(await listRerunRuns(db, "tonight")).toHaveLength(1);
    expect(h.posts).toEqual([]);

    // The rerun confirms the drop: 6 more failures.
    await seedRerunAttempts(rerun.id, "sql-audit", OPUS, [
      "failed",
      "failed",
      "failed",
      "failed",
      "failed",
      "passed",
    ]);
    await setRunStatus(db, rerun.id, "done");
    await onRunFinished(h.deps, rerun.id);

    expect(h.posts).toHaveLength(1);
    expect(h.posts[0]).toContain("PAGE");
    expect(h.posts[0]).toContain("with the rerun");
    expect((await getRun(db, "tonight"))?.summaryPostedAt).not.toBeNull();
    expect(h.started).toEqual([rerun.id]);
  });

  test("a flag the rerun clears posts a warning summary, not a page", async () => {
    await seedBaseline();
    await seedRun({
      id: "tonight",
      night: 10,
      preset: "nightly-canary",
      cells: [{ configId: OPUS, scenarioId: "sql-audit", results: ["passed", "failed", "failed"] }],
    });
    const h = harness();
    await onRunFinished(h.deps, "tonight");
    const rerun = (await listRerunRuns(db, "tonight"))[0]!;
    await seedRerunAttempts(rerun.id, "sql-audit", OPUS, Array(6).fill("passed"));
    await setRunStatus(db, rerun.id, "done");
    await onRunFinished(h.deps, rerun.id);
    expect(h.posts).toHaveLength(1);
    expect(h.posts[0]).not.toContain("PAGE");
    expect(h.posts[0]).toContain("cleared");
  });

  test("when the rerun cannot start, the flag is posted unconfirmed instead of waiting forever", async () => {
    await seedBaseline();
    await seedRun({
      id: "tonight",
      night: 10,
      preset: "nightly-canary",
      cells: [{ configId: OPUS, scenarioId: "sql-audit", results: ["passed", "failed", "failed"] }],
    });
    const h = harness({
      startRun: () => {
        throw new Error("boom");
      },
    });
    await onRunFinished(h.deps, "tonight");
    expect(h.posts).toHaveLength(1);
    expect((await listRerunRuns(db, "tonight")).map((r) => r.status)).toEqual(["failed"]);
    expect(h.posts[0]).toContain("flags to look at");
    expect(h.posts[0]).toContain("nothing is confirmed");
    expect(h.logs.join("\n")).toContain("could not start the rerun (boom)");
  });

  test("a run that did not finish done posts a short failure summary", async () => {
    await seedRun({
      id: "tonight",
      night: 10,
      preset: "nightly-canary",
      status: "failed",
      cells: [{ configId: OPUS, scenarioId: "sql-audit", results: ["error", "error", "error"] }],
    });
    const h = harness();
    await onRunFinished(h.deps, "tonight");
    expect(h.posts).toHaveLength(1);
    expect(h.posts[0]).toContain(":x: *Nightly canary: run failed*");
    expect(h.posts[0]).toContain("No regression check ran");
  });

  test("model change: the summary says so instead of flagging", async () => {
    await seedRun({
      id: "night-1",
      night: 1,
      preset: "nightly-canary",
      cells: [allPass("sql-audit")],
    });
    for (let n = 2; n <= 5; n++) {
      await seedRun({
        id: `night-${n}`,
        night: n,
        preset: "nightly-canary",
        cells: [allPass("sql-audit")],
      });
    }
    await seedRun({
      id: "tonight",
      night: 10,
      preset: "nightly-canary",
      cells: [
        {
          configId: OPUS,
          scenarioId: "sql-audit",
          results: ["failed", "failed", "failed"],
          model: "claude-opus-5-6",
        },
      ],
    });
    const h = harness();
    await onRunFinished(h.deps, "tonight");
    expect(h.posts).toHaveLength(1);
    expect(h.posts[0]).toContain("*Model changes*");
    expect(h.posts[0]).toContain("claude-opus-5-5 → claude-opus-5-6");
    expect(h.posts[0]).not.toContain("PAGE");
  });

  test("only finished runs of the same preset make up the baseline", async () => {
    await seedBaseline();
    // a weekly run, a cancelled night and a rerun must not count
    await seedRun({
      id: "weekly-1",
      night: 6,
      preset: "weekly-matrix",
      cells: [allPass("sql-audit")],
    });
    await seedRun({
      id: "cancelled-1",
      night: 7,
      preset: "nightly-canary",
      status: "cancelled",
      cells: [allPass("sql-audit")],
    });
    await seedRun({
      id: "newer-night",
      night: 15,
      preset: "nightly-canary",
      cells: [allPass("sql-audit")],
    });
    await seedRun({
      id: "tonight",
      night: 10,
      preset: "nightly-canary",
      cells: [allPass("sql-audit")],
    });
    const run = (await getRun(db, "tonight"))!;
    const { report } = await buildRunRegression({ db, registry: loadRegistry() }, run);
    expect(report.cells[0]?.baseline.graded).toBe(15); // the 5 seeded nights only; not weekly, cancelled or later
  });

  test("without a webhook the summary is logged and left unclaimed for the workflow to post", async () => {
    await seedBaseline();
    await seedRun({
      id: "tonight",
      night: 10,
      preset: "nightly-canary",
      cells: [allPass("sql-audit")],
    });
    const h = harness({ postSlack: null });
    await onRunFinished(h.deps, "tonight");
    expect(h.logs.join("\n")).toContain("EVALS_SLACK_WEBHOOK_URL is unset");
    expect((await getRun(db, "tonight"))?.summaryPostedAt).toBeNull();
  });

  test("a failed Slack post releases the claim so it can be retried", async () => {
    await seedBaseline();
    await seedRun({
      id: "tonight",
      night: 10,
      preset: "nightly-canary",
      cells: [allPass("sql-audit")],
    });
    const h = harness({
      postSlack: async () => {
        throw new Error("Slack webhook answered 500");
      },
    });
    await expect(onRunFinished(h.deps, "tonight")).rejects.toThrow("answered 500");
    expect((await getRun(db, "tonight"))?.summaryPostedAt).toBeNull();
    const retry = harness();
    await onRunFinished(retry.deps, "tonight");
    expect(retry.posts).toHaveLength(1);
  });
});

describe("buildRunSummaryText", () => {
  test("reports the state of a run that is not final yet", async () => {
    await seedBaseline();
    await seedRun({
      id: "tonight",
      night: 10,
      preset: "nightly-canary",
      cells: [{ configId: OPUS, scenarioId: "sql-audit", results: ["passed", "failed", "failed"] }],
    });
    const run = (await getRun(db, "tonight"))!;
    const pending = await buildRunSummaryText(harness().deps, run);
    expect(pending.final).toBe(false);
    expect(pending.report?.pendingReruns).toHaveLength(1);
    const forced = await buildRunSummaryText(harness().deps, run, { forceSettled: true });
    expect(forced.final).toBe(true);
  });
});

describe("helpers", () => {
  test("isScheduledPreset", () => {
    expect(isScheduledPreset("nightly-canary")).toBe(true);
    expect(isScheduledPreset("weekly-matrix")).toBe(true);
    expect(isScheduledPreset("frontier")).toBe(false);
    expect(isScheduledPreset(null)).toBe(false);
    expect(isScheduledPreset(undefined)).toBe(false);
  });

  test("slackWebhookPoster posts {text} as JSON and throws on a non-2xx answer", async () => {
    expect(slackWebhookPoster(undefined)).toBeNull();
    expect(slackWebhookPoster("")).toBeNull();
    const calls: Array<{ url: string; body: string; method: string }> = [];
    const ok = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), body: String(init?.body), method: String(init?.method) });
      return new Response("ok", { status: 200 });
    }) as typeof fetch;
    await slackWebhookPoster("https://hooks.example.test/T/B/X", ok)?.("hello *world*");
    expect(calls).toEqual([
      { url: "https://hooks.example.test/T/B/X", body: '{"text":"hello *world*"}', method: "POST" },
    ]);
    const bad = (async () => new Response("no", { status: 500 })) as unknown as typeof fetch;
    await expect(slackWebhookPoster("https://hooks.example.test/x", bad)?.("x")).rejects.toThrow(
      "Slack webhook answered 500",
    );
  });
});

async function seedRerunAttempts(
  runId: string,
  scenarioId: string,
  configId: string,
  results: Exclude<Result, "cancelled">[],
): Promise<void> {
  for (const [i, result] of results.entries()) {
    const id = `${runId}_${scenarioId}_${configId}_${i}_${seq++}`;
    await insertAttempt(db, {
      id,
      runId,
      scenarioId,
      configId,
      attemptIndex: i,
      scenarioVersion: 1,
      suiteVersion: "1.0",
    });
    await updateAttempt(db, id, {
      status: result,
      score: result === "passed" ? 0.9 : 0.2,
      passed: result === "passed",
      costUsd: 0.1,
      judgeCostUsd: 0.01,
      durationMs: 60_000,
      resolvedModel: MODEL,
    });
  }
}
