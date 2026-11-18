import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { initDb, resetDbForTests } from "../db/client.ts";
import { insertAttempt, listJudgments } from "../db/queries.ts";
import { beginJudging, clearJudging } from "../judge/live-registry.ts";
import { newJudgeTrace } from "../judge/llm.ts";
import { beginAttemptProgress, finishAttemptProgress } from "../live/attempt-progress.ts";
import type {
  AttemptRow,
  CheckResult,
  DeterministicCheck,
  JudgeContext,
  NormalizedDimension,
  PhaseTimings,
  Scenario,
} from "../types.ts";
import { JudgeInfraError, scoreDimension } from "./index.ts";

/**
 * Runner-level coverage for the v8.0 §3.3 dimension scoring + persistence path
 * (`scoreDimension`, exported for this test), against a fresh in-memory DB and
 * a fake JudgeContext:
 *  - graded-check dimension → weighted-mean sub-score, ONE persisted row with
 *    dimension/weight set;
 *  - a graded check that THROWS → value 0 (config's fault, not a judge error);
 *  - a judge dimension whose judge throws for infra (no OPENROUTER_API_KEY) →
 *    JudgeInfraError (maps the attempt to status `error` in runAttemptWithRetry).
 * The pure aggregation math + gate-fail-still-scores + threshold semantics live
 * in src/scoring.test.ts.
 */

const ENV_KEYS = ["EVALS_DB_SYNC_URL", "EVALS_DB_AUTH_TOKEN", "EVALS_DB_PATH"] as const;
const savedEnv: Record<string, string | undefined> = {};
for (const k of ENV_KEYS) savedEnv[k] = process.env[k];

function clearDbEnv(): void {
  for (const k of ENV_KEYS) delete process.env[k];
}
function restoreDbEnv(): void {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
}

const ATTEMPT_ID = "run1_scn_cfg_0";

/** A booted, persistable attempt row + its parent run (FKs require both). */
async function freshDbWithAttempt() {
  const db = await initDb();
  await db.execute(
    "INSERT INTO eval_runs (id, scenario_ids, config_ids) VALUES ('run1', '[]', '[]')",
  );
  await insertAttempt(db, {
    id: ATTEMPT_ID,
    runId: "run1",
    scenarioId: "scn",
    configId: "cfg",
    attemptIndex: 0,
  });
  beginAttemptProgress(ATTEMPT_ID);
  return db;
}

const ATTEMPT: AttemptRow = {
  id: ATTEMPT_ID,
  runId: "run1",
  scenarioId: "scn",
  configId: "cfg",
  attemptIndex: 0,
  status: "judging",
  retries: 0,
  sandboxId: null,
  apiUrl: null,
  taskIds: [],
  score: null,
  passed: null,
  error: null,
  costUsd: null,
  costSource: null,
  judgeCostUsd: null,
  tokens: null,
  sandbox: null,
  workers: null,
  timings: null,
  durationMs: null,
  startedAt: null,
  finishedAt: null,
};

const SCENARIO: Pick<Scenario, "id" | "name" | "tasks" | "outcome"> = {
  id: "scn",
  name: "scn",
  tasks: [],
  outcome: {},
};

/** Fake JudgeContext — checks only touch readFile here; no sandbox needed. */
function fakeCtx(): JudgeContext {
  return {
    tasks: [],
    transcript: "",
    exec: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
    readFile: async () => null,
    apiGet: async () => ({}),
    workers: [],
  };
}

/** A graded check returning a fixed partial-credit score. */
function gradedCheck(name: string, score: number, weight?: number): DeterministicCheck {
  const c: DeterministicCheck = {
    name,
    fn: async (): Promise<CheckResult> => ({ pass: score >= 1, score }),
  };
  if (weight !== undefined) c.weight = weight;
  return c;
}

/** A check that throws — runChecks maps it to {pass:false} → value 0. */
function throwingCheck(name: string): DeterministicCheck {
  return {
    name,
    fn: async (): Promise<CheckResult> => {
      throw new Error("sandbox unreachable");
    },
  };
}

let timings: PhaseTimings;

beforeEach(() => {
  resetDbForTests();
  clearDbEnv();
  process.env.EVALS_DB_PATH = ":memory:";
  timings = {
    bootMs: null,
    seedMs: null,
    tasksMs: null,
    perTask: [],
    logCaptureMs: null,
    costMs: null,
    checksMs: null,
    llmJudgeMs: null,
    agenticJudgeMs: null,
    artifactsMs: null,
  };
});

afterEach(() => {
  clearJudging(ATTEMPT_ID);
  finishAttemptProgress(ATTEMPT_ID);
  resetDbForTests();
  restoreDbEnv();
});

function scoreOpts(db: Awaited<ReturnType<typeof initDb>>, dim: NormalizedDimension) {
  return {
    db,
    attempt: ATTEMPT,
    scenario: SCENARIO as Scenario,
    dim,
    ctx: fakeCtx(),
    judgeLive: beginJudging(ATTEMPT_ID),
    judgeModel: null,
    timings,
    addJudgeCost: () => {},
    log: () => {},
  };
}

describe("scoreDimension — graded checks", () => {
  test("weighted-mean sub-score + ONE persisted row carrying dimension/weight", async () => {
    const db = await freshDbWithAttempt();
    const dim: NormalizedDimension = {
      name: "correctness",
      weight: 3,
      checks: [gradedCheck("a", 1, 3), gradedCheck("b", 0, 1)], // (3·1 + 1·0)/4 = 0.75
    };
    const sub = await scoreDimension(scoreOpts(db, dim));
    expect(sub).toBeCloseTo(0.75, 10);

    const rows = await listJudgments(db, ATTEMPT_ID);
    expect(rows.length).toBe(1);
    const row = rows[0];
    expect(row?.name).toBe("correctness");
    expect(row?.dimension).toBe("correctness");
    expect(row?.weight).toBe(3);
    expect(row?.kind).toBe("deterministic");
    expect(row?.score).toBeCloseTo(0.75, 10);
    expect(row?.pass).toBe(false); // pass only when sub-score >= 1
  });

  test("a graded check that THROWS contributes value 0 (not a JudgeInfraError)", async () => {
    const db = await freshDbWithAttempt();
    const dim: NormalizedDimension = {
      name: "correctness",
      weight: 1,
      checks: [gradedCheck("ok", 1), throwingCheck("boom")], // (1 + 0)/2 = 0.5
    };
    const sub = await scoreDimension(scoreOpts(db, dim));
    expect(sub).toBeCloseTo(0.5, 10);
    const rows = await listJudgments(db, ATTEMPT_ID);
    expect(rows.length).toBe(1);
    expect(rows[0]?.score).toBeCloseTo(0.5, 10);
  });

  test("a perfect dimension passes (sub-score >= 1)", async () => {
    const db = await freshDbWithAttempt();
    const dim: NormalizedDimension = {
      name: "completeness",
      weight: 2,
      checks: [gradedCheck("a", 1), gradedCheck("b", 1)],
    };
    const sub = await scoreDimension(scoreOpts(db, dim));
    expect(sub).toBe(1);
    const rows = await listJudgments(db, ATTEMPT_ID);
    expect(rows[0]?.pass).toBe(true);
  });
});

describe("scoreDimension — judge infra failure", () => {
  let savedKey: string | undefined;
  beforeEach(() => {
    savedKey = process.env.OPENROUTER_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
  });
  afterEach(() => {
    if (savedKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = savedKey;
  });

  test("an llm-judge dimension whose judge throws for infra → JudgeInfraError", async () => {
    const db = await freshDbWithAttempt();
    const dim: NormalizedDimension = {
      name: "communication",
      weight: 1,
      judge: { rubric: "is it clear", agentic: false },
    };
    // No OPENROUTER_API_KEY → judgeWithLlm throws → wrapped as JudgeInfraError.
    let caught: unknown;
    try {
      await scoreDimension(scoreOpts(db, dim));
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(JudgeInfraError);
    expect((caught as JudgeInfraError).dimension).toBe("communication");
    // No judgment row is persisted for a dimension that errored out.
    const rows = await listJudgments(db, ATTEMPT_ID);
    expect(rows.length).toBe(0);
  });
});

describe("scoreDimension — judge-only dimension invokes the judge (round 11 XOR)", () => {
  // A judge-only dimension (the checks-XOR-judge contract) must reach the judge
  // branch and score FROM the verdict — the dead-judge bug was that a dimension
  // with checks short-circuited and never ran its judge. Here there are no checks,
  // so the (mocked) llm judge runs and its score is the dimension sub-score.
  let restore: (() => void) | undefined;
  afterEach(() => {
    restore?.();
    restore = undefined;
  });

  test("a judge-only dimension runs the llm judge and persists its score", async () => {
    const judgeCalls: { rubric: string }[] = [];
    // Override the live module binding so scoreDimension's judgeWithLlm call site
    // resolves to this fake — no OPENROUTER_API_KEY / network needed.
    await mock.module("../judge/llm.ts", () => ({
      newJudgeTrace,
      judgeWithLlm: async (input: { rubric: string }) => {
        judgeCalls.push({ rubric: input.rubric });
        const trace = newJudgeTrace("llm", "fake-model");
        trace.finishedAt = new Date().toISOString();
        trace.durationMs = 5;
        return {
          score: 0.6,
          pass: false,
          reasoning: "review is specific and grounded",
          raw: "{}",
          trace,
        };
      },
    }));
    restore = () => mock.module("../judge/llm.ts", () => ({ newJudgeTrace }));

    const db = await freshDbWithAttempt();
    let captured: number | null = null;
    const dim: NormalizedDimension = {
      name: "communication",
      weight: 2,
      judge: { rubric: "grade the review's specificity", agentic: false },
    };
    const sub = await scoreDimension({
      ...scoreOpts(db, dim),
      addJudgeCost: (c) => {
        captured = c;
      },
    });

    // The dimension scored FROM the judge verdict (not a check).
    expect(sub).toBeCloseTo(0.6, 10);
    // The judge actually ran (the dead-judge bug would skip it).
    expect(judgeCalls.length).toBe(1);
    expect(judgeCalls[0]?.rubric).toBe("grade the review's specificity");
    void captured;

    // Exactly one persisted row, kind 'llm', carrying the dimension/weight + score.
    const rows = await listJudgments(db, ATTEMPT_ID);
    expect(rows.length).toBe(1);
    const row = rows[0];
    expect(row?.kind).toBe("llm");
    expect(row?.dimension).toBe("communication");
    expect(row?.weight).toBe(2);
    expect(row?.score).toBeCloseTo(0.6, 10);
    expect(row?.pass).toBe(false); // pass only when sub-score >= 1
  });
});
