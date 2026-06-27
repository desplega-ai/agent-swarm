import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { initDb, resetDbForTests } from "../db/client.ts";
import { getAttempt, insertAttempt, listJudgments, updateAttempt } from "../db/queries.ts";
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

describe("runAttemptWithRetry — JudgeInfraError maps to status 'error' (NOT 'failed')", () => {
  // The block above asserts scoreDimension THROWS a JudgeInfraError on a judge
  // infra flake. This block closes the loop on what runAttemptWithRetry's catch
  // does with that throw (runner/index.ts ~1688/1720): a JudgeInfraError keeps
  // its CLEAN typed message (NOT a raw stack) and the attempt is persisted in
  // terminal status `error` — never `failed`.
  //
  // PARTIAL-BY-DESIGN: runAttemptWithRetry / runAttemptOnce are module-private
  // and runAttemptOnce unconditionally boots an E2B stack before any judge runs,
  // so driving the real catch end-to-end means mock.module-ing ../swarm/sandbox.ts
  // (bootStack). bun's mock.module mutates the GLOBAL module registry + live
  // bindings and does NOT isolate per-file without `--isolate` (which this suite
  // doesn't use), so that mock leaks into src/runner/progress.test.ts (which
  // imports bootStack directly) and breaks its abort test. Rather than ship a
  // flaky cross-file mock, we assert the two decisions the catch actually makes,
  // against the REAL types + REAL DB persistence path (getAttempt/updateAttempt):
  //   1) the error the catch special-cases IS a JudgeInfraError carrying a clean
  //      message (no stack) + its dimension — this is the exact discriminant the
  //      `err instanceof JudgeInfraError ? err.message : err.stack` branch keys on;
  //   2) persisting that terminal verdict writes status `error` (the mapping
  //      target), round-tripping out of the DB as `error`, never `failed`.

  const JUDGE_INFRA_MSG = "openrouter judge returned 503 (model overloaded)";

  test("a JudgeInfraError carries the CLEAN message the catch persists (not a stack)", () => {
    const err = new JudgeInfraError("communication", JUDGE_INFRA_MSG);
    // runAttemptWithRetry's catch: `err instanceof JudgeInfraError ? err.message
    // : (err.stack ?? err.message)`. So the discriminant must be true and the
    // message must be the clean one — a stack would START with the class name and
    // contain "\n    at " frames, which must NOT leak into the persisted error.
    expect(err).toBeInstanceOf(JudgeInfraError);
    expect(err.message).toBe(JUDGE_INFRA_MSG);
    expect(err.dimension).toBe("communication");
    const persisted = (err instanceof JudgeInfraError ? err.message : (err as Error).stack) ?? "";
    expect(persisted).toBe(JUDGE_INFRA_MSG);
    expect(persisted).not.toContain("\n    at ");
  });

  test("the terminal mapping persists status 'error' (NOT 'failed') and round-trips from the DB", async () => {
    const db = await freshDbWithAttempt();
    const err = new JudgeInfraError("communication", JUDGE_INFRA_MSG);

    // Exactly what runAttemptWithRetry's terminal branch does for a thrown
    // JudgeInfraError (runner/index.ts ~1719): status 'error' + the clean,
    // 4000-char-capped message. We exercise the REAL updateAttempt so the status
    // CHECK constraint + column round-trip are part of the assertion.
    const message = err instanceof JudgeInfraError ? err.message : ((err as Error).stack ?? "");
    await updateAttempt(db, ATTEMPT_ID, {
      status: "error",
      retries: 0,
      error: message.slice(0, 4000),
      finishedAt: new Date().toISOString(),
    });

    const attempt = await getAttempt(db, ATTEMPT_ID);
    expect(attempt).not.toBeNull();
    expect(attempt?.status).toBe("error"); // the mapping target
    expect(attempt?.status).not.toBe("failed"); // the bug would be 'failed'
    expect(attempt?.error).toBe(JUDGE_INFRA_MSG); // clean message, no stack
    expect(attempt?.passed).toBeNull(); // an errored attempt has no verdict
    expect(attempt?.score).toBeNull();
  });
});
