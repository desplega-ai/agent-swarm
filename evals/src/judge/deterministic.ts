import type { CheckResult, DeterministicCheck, JudgeContext } from "../types.ts";
import type { JudgeLiveHandle } from "./live-registry.ts";
import { finishJudgeTrace, newJudgeTrace } from "./llm.ts";

export interface CheckRunResult extends CheckResult {
  name: string;
  /** Per-check elapsed wall clock. */
  durationMs: number;
}

/**
 * Run all deterministic checks; a thrown check counts as a failure, not a
 * crash. Each check is timed and pushed into the live trace as it completes.
 */
export async function runChecks(
  checks: DeterministicCheck[],
  ctx: JudgeContext,
  live?: JudgeLiveHandle,
): Promise<CheckRunResult[]> {
  const trace = newJudgeTrace("deterministic", null);
  live?.attach(trace);
  const results: CheckRunResult[] = [];
  for (const check of checks) {
    const t0 = Date.now();
    let res: CheckResult;
    try {
      res = await check.fn(ctx);
    } catch (err) {
      res = {
        pass: false,
        detail: `check threw: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    const durationMs = Date.now() - t0;
    results.push({ name: check.name, ...res, durationMs });
    trace.steps.push({
      index: trace.steps.length,
      kind: "check",
      text: res.detail ?? null,
      tool: check.name,
      args: null,
      output: null,
      pass: res.pass,
      startedAt: new Date(t0).toISOString(),
      durationMs,
      tokens: null,
      costUsd: null,
    });
  }
  finishJudgeTrace(trace); // costUsd/tokens stay null — no LLM involved
  return results;
}

/** Common check: every scenario task reached a terminal-success status. */
export function allTasksCompleted(): DeterministicCheck {
  return {
    name: "all-tasks-completed",
    fn: async (ctx) => {
      const bad = ctx.tasks.filter((t) => !["done", "completed"].includes(t.status));
      return bad.length === 0
        ? { pass: true }
        : {
            pass: false,
            detail: `tasks not done: ${bad.map((t) => `${t.title}=${t.status}`).join(", ")}`,
          };
    },
  };
}

/** Common check: a file exists in the sandbox and (optionally) matches a pattern. */
export function fileContains(path: string, pattern?: RegExp): DeterministicCheck {
  return {
    name: `file-contains:${path}`,
    fn: async (ctx) => {
      const content = await ctx.readFile(path);
      if (content === null) return { pass: false, detail: `${path} not found` };
      if (pattern && !pattern.test(content)) {
        return { pass: false, detail: `${path} does not match ${pattern}` };
      }
      return { pass: true, detail: `${path} (${content.length} bytes)` };
    },
  };
}

/** Like {@link fileContains}, but against ctx.workers[worker] (multi-worker v1, v6 §0.9). */
export function fileContainsOnWorker(
  worker: number,
  path: string,
  pattern: RegExp,
): DeterministicCheck {
  return {
    name: `file-contains[w${worker}]:${path}`,
    fn: async (ctx) => {
      const w = ctx.workers[worker];
      if (!w) return { pass: false, detail: `worker ${worker} not booted` };
      const content = await w.readFile(path);
      if (content === null) return { pass: false, detail: `${path} not found` };
      if (!pattern.test(content)) {
        return { pass: false, detail: `${path} does not match ${pattern}` };
      }
      return { pass: true, detail: `${path} (${content.length} bytes)` };
    },
  };
}

/** Passes when the file does NOT exist on that worker (isolation proof, v6 §0.9). */
export function fileAbsentOnWorker(worker: number, path: string): DeterministicCheck {
  return {
    name: `file-absent[w${worker}]:${path}`,
    fn: async (ctx) => {
      const w = ctx.workers[worker];
      if (!w) return { pass: false, detail: `worker ${worker} not booted` };
      const content = await w.readFile(path);
      return content === null
        ? { pass: true, detail: `${path} absent` }
        : { pass: false, detail: `${path} exists (${content.length} bytes)` };
    },
  };
}

/** One named test group: a shell command (typically `bun test <file>`) that exits 0 when green. */
export interface TestGroup {
  /** Short label for the group (surfaced in the check detail). */
  name: string;
  /** Command run inside the target worker's sandbox; exit 0 == green. */
  cmd: string;
}

/**
 * Graded code-correctness check (v8.0 §6): runs N independent test groups on a
 * worker and scores the FRACTION that pass — `score = green / total`. Unlike
 * {@link fileContains} (binary), this yields partial credit so a config that
 * fixes 3 of 5 graded bugs ranks above one that fixes 1. `pass` mirrors
 * all-green (score === 1); the dimension aggregation in the runner consumes the
 * `score`, while gate usage falls back to `pass`. A group whose command throws
 * counts as red (it does not abort the remaining groups).
 *
 * Reuses the `seed.exec` heredoc test-suite machinery from the old
 * `build-verify-fix` scenario, generalized to multiple gradeable groups for
 * `bug-ladder`.
 */
export function testGroupsGreen(
  groups: TestGroup[],
  worker = 0,
  cwd = "/workspace",
): DeterministicCheck {
  return {
    name: `test-groups-green[w${worker}]`,
    fn: async (ctx) => {
      const w = ctx.workers[worker];
      if (!w) return { pass: false, score: 0, detail: `worker ${worker} not booted` };
      const total = groups.length;
      if (total === 0) return { pass: true, score: 1, detail: "no test groups" };
      const outcomes: { name: string; green: boolean; note?: string }[] = [];
      for (const g of groups) {
        try {
          const res = await w.exec(`cd ${cwd} && ${g.cmd}`);
          outcomes.push({
            name: g.name,
            green: res.exitCode === 0,
            note: res.exitCode === 0 ? undefined : (res.stderr || res.stdout).slice(0, 200),
          });
        } catch (err) {
          outcomes.push({
            name: g.name,
            green: false,
            note: err instanceof Error ? err.message : String(err),
          });
        }
      }
      const green = outcomes.filter((o) => o.green).length;
      const score = green / total;
      const failed = outcomes.filter((o) => !o.green).map((o) => o.name);
      return {
        pass: green === total,
        score,
        detail:
          green === total
            ? `${green}/${total} test groups green`
            : `${green}/${total} test groups green (red: ${failed.join(", ")})`,
      };
    },
  };
}

/** One ground-truth fact to grade: a regex the recall file must satisfy, with a label. */
export interface GradedFact {
  /** Short label for the fact (surfaced in the check detail). */
  label: string;
  /** Pattern the file content must match for this fact to count as recalled. */
  pattern: RegExp;
}

/**
 * Graded recall check (v8.0 §6): reads one file and scores the FRACTION of
 * ground-truth facts present — `score = matched / total`. Partial credit so a
 * config that recalls 2 of 3 seeded facts ranks above one that recalls 0. `pass`
 * mirrors all-matched (score === 1). A missing file scores 0.
 *
 * Reuses the `seed.memories` + `fileContains` per-fact pattern from the old
 * `memory-seeded-recall` scenario, generalized to a graded multi-fact answer
 * key for `memory-distractor`.
 */
export function factsRecalled(path: string, facts: GradedFact[], worker = 0): DeterministicCheck {
  return {
    name: `facts-recalled[w${worker}]:${path}`,
    fn: async (ctx) => {
      const w = ctx.workers[worker];
      if (!w) return { pass: false, score: 0, detail: `worker ${worker} not booted` };
      const total = facts.length;
      if (total === 0) return { pass: true, score: 1, detail: "no facts" };
      const content = await w.readFile(path);
      if (content === null) return { pass: false, score: 0, detail: `${path} not found` };
      const missing = facts.filter((f) => !f.pattern.test(content)).map((f) => f.label);
      const matched = total - missing.length;
      const score = matched / total;
      return {
        pass: matched === total,
        score,
        detail:
          matched === total
            ? `${matched}/${total} facts recalled`
            : `${matched}/${total} facts recalled (missing: ${missing.join(", ")})`,
      };
    },
  };
}

/** Normalize text for stage comparison: trim, drop blank lines, collapse trailing whitespace. */
function normalizeLines(text: string): string[] {
  return text
    .split("\n")
    .map((l) => l.replace(/\s+$/, ""))
    .filter((l) => l.length > 0);
}

/**
 * One stage of a chained transform pipeline (v8.0 §6, relay-pipeline). Each stage
 * is owned by one worker, reads its predecessor's output (handed off via swarm
 * memory), applies a pure transform, and writes the result to its own receipt
 * file. The expected output is RECOMPUTED from the per-attempt seeded source at
 * grade time (`transform` is applied to the previous stage's expected output),
 * so the ground truth is never a constant in the scenario file or the prompt.
 */
export interface PipelineStage {
  /** Short label for the stage (surfaced in the check detail). */
  label: string;
  /** Worker index that owns this stage (reads predecessor, writes its receipt). */
  worker: number;
  /** Absolute path of the receipt file this stage's worker writes. */
  path: string;
  /**
   * Pure transform from the PREVIOUS stage's expected line array to this stage's
   * expected line array. For stage 0, `prev` is the seeded source lines.
   */
  transform: (prev: string[]) => string[];
}

/**
 * Graded chained-pipeline correctness check (v8.0 §6, relay-pipeline). A random
 * per-attempt source payload is seeded on the origin worker's sandbox; each stage
 * applies a deterministic transform whose CORRECT output is recomputed here (by
 * folding the stage transforms over the seeded source) and compared, line-for-
 * line, against that stage's receipt file. The receipts live on separate worker
 * sandboxes, so each downstream worker can only obtain its input via the memory
 * handoff — there is no shared disk.
 *
 * `score = stages whose receipt matches the recomputed expected output / total`
 * — partial credit, and because the stages are dependency-chained a corruption at
 * stage k naturally tanks stages k+1… (a config that nails stage 1 but botches
 * stage 2 still ranks above one that botched stage 1). Each stage's fidelity is
 * scored INDEPENDENTLY against the recomputed truth (not against the worker's own
 * upstream receipt), so a downstream worker that faithfully transforms a WRONG
 * input still scores 0 on its own stage — the expected output is anchored to the
 * seed, not to whatever the previous worker actually produced.
 *
 * The source payload is read from the origin worker at grade time (it is random
 * per attempt and appears in NO prompt), so the expected outputs cannot be
 * pre-derived from the task text. Reuses the cross-worker `workers` + `dependsOn`
 * + per-worker-file machinery from the old `relay-handoff` scenario, generalized
 * to a graded multi-stage transform chain.
 */
export function pipelineStagesCorrect(
  source: { worker: number; path: string },
  stages: PipelineStage[],
): DeterministicCheck {
  return {
    name: `pipeline-stages:w${source.worker}→[${stages.map((s) => `w${s.worker}`).join(",")}]`,
    fn: async (ctx) => {
      const total = stages.length;
      if (total === 0) return { pass: true, score: 1, detail: "no stages" };
      const originWorker = ctx.workers[source.worker];
      if (!originWorker) {
        return { pass: false, score: 0, detail: `source worker ${source.worker} not booted` };
      }
      const sourceContent = await originWorker.readFile(source.path);
      if (sourceContent === null) {
        return { pass: false, score: 0, detail: `source file ${source.path} not found` };
      }
      // Fold the stage transforms over the seeded source to recompute each
      // stage's EXPECTED output. Each stage is anchored to the seed, not to the
      // previous worker's actual (possibly wrong) receipt.
      let expected = normalizeLines(sourceContent);
      const correct: string[] = [];
      const wrong: string[] = [];
      for (const stage of stages) {
        expected = stage.transform(expected);
        const w = ctx.workers[stage.worker];
        if (!w) {
          wrong.push(`${stage.label}(w${stage.worker} not booted)`);
          continue;
        }
        const actual = await w.readFile(stage.path);
        if (actual === null) {
          wrong.push(`${stage.label}(missing)`);
          continue;
        }
        const actualLines = normalizeLines(actual);
        const ok =
          actualLines.length === expected.length && actualLines.every((l, i) => l === expected[i]);
        if (ok) correct.push(stage.label);
        else wrong.push(stage.label);
      }
      const score = correct.length / total;
      return {
        pass: correct.length === total,
        score,
        detail:
          correct.length === total
            ? `all ${total} pipeline stages correct`
            : `${correct.length}/${total} pipeline stages correct (wrong: ${wrong.join(", ")})`,
      };
    },
  };
}
