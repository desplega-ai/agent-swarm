/**
 * Offline grading for grader validation (see grader-validation.test.ts).
 *
 * `gradeOffline` mirrors the runner's scoring path in runAttemptOnce with the
 * same primitives (`tasksCompletedCheck`, `runChecks`, `dimensionScoreFromChecks`,
 * `efficiencyScore`, `finalizeScore`), so a synthetic context is graded exactly
 * as a live attempt would be. Only LLM-judge dimensions are stubbed: the caller
 * passes the score the judge would return. Everything deterministic is real.
 *
 * `nullContext` is what a do-nothing agent leaves behind: every scenario task
 * `completed` with an empty result, no files, no session logs, an empty API.
 */

import { runChecks } from "../src/judge/deterministic.ts";
import { normalizeOutcome } from "../src/normalize-outcome.ts";
import { tasksCompletedCheck } from "../src/runner/index.ts";
import { dimensionScoreFromChecks, efficiencyScore, finalizeScore } from "../src/scoring.ts";
import {
  type JudgeContext,
  type JudgeWorkerContext,
  type Scenario,
  type SwarmTask,
  scenarioWorkerCount,
} from "../src/types.ts";

/** What a scenario's grader makes of one synthetic run. */
export interface OfflineGrade {
  /** Gate results, `tasks-completed` first (the runner prepends it). */
  gates: { name: string; pass: boolean; detail?: string }[];
  /** Names of failed gates other than the implicit `tasks-completed`. */
  failedScenarioGates: string[];
  dimensions: { name: string; weight: number; subScore: number; source: string }[];
  score: number;
  passed: boolean;
}

export interface GradeOfflineOptions {
  scenario: Scenario;
  ctx: JudgeContext;
  /**
   * The upfront scenario tasks the runner awaits (feeds `tasks-completed`).
   * Default: every ctx task whose id starts with `task-` (see {@link nullContext}).
   */
  upfrontTasks?: SwarmTask[];
  /** Score an LLM judge returns for every judge dimension. */
  judgeScore: number;
  /** Agent cost / wall clock fed to the deterministic efficiency dimension. Default: 0. */
  costUsd?: number | null;
  durationMs?: number;
}

export async function gradeOffline(opts: GradeOfflineOptions): Promise<OfflineGrade> {
  const { scenario, ctx } = opts;
  const normalized = normalizeOutcome(scenario.outcome);
  const upfront = opts.upfrontTasks ?? ctx.tasks.filter((t) => t.id.startsWith("task-"));

  const gateChecks = [tasksCompletedCheck(upfront), ...normalized.gates];
  const gateResults = await runChecks(gateChecks, ctx);
  const gates = gateResults.map((r) => ({ name: r.name, pass: r.pass, detail: r.detail }));
  const allGatesPass = gateResults.every((r) => r.pass);

  const dimensions: OfflineGrade["dimensions"] = [];
  for (const dim of normalized.dimensions) {
    if (dim.checks && dim.checks.length > 0) {
      const results = await runChecks(dim.checks, ctx);
      const subScore = dimensionScoreFromChecks(
        results.map((res, i) => ({
          value: res.score ?? (res.pass ? 1 : 0),
          weight: dim.checks?.[i]?.weight ?? 1,
        })),
      );
      dimensions.push({ name: dim.name, weight: dim.weight, subScore, source: "checks" });
    } else if (dim.judge) {
      dimensions.push({
        name: dim.name,
        weight: dim.weight,
        subScore: opts.judgeScore,
        source: "judge (stubbed)",
      });
    } else if (dim.name === "efficiency") {
      // Deterministic efficiency: MIN of the cost and time sub-scores; a missing
      // metric drops out, and no metric at all drops the dimension.
      const subScores: number[] = [];
      const costUsd = opts.costUsd === undefined ? 0 : opts.costUsd;
      if (scenario.budgetUsd !== undefined && costUsd !== null) {
        subScores.push(efficiencyScore(costUsd, scenario.budgetUsd));
      }
      if (scenario.budgetMs !== undefined) {
        subScores.push(efficiencyScore(opts.durationMs ?? 0, scenario.budgetMs));
      }
      if (subScores.length > 0) {
        dimensions.push({
          name: dim.name,
          weight: dim.weight,
          subScore: Math.min(...subScores),
          source: "efficiency",
        });
      }
    } else {
      dimensions.push({ name: dim.name, weight: dim.weight, subScore: 0, source: "empty" });
    }
  }

  const { score, passed } = finalizeScore({
    allGatesPass,
    dimensions: dimensions.map((d) => ({ weight: d.weight, subScore: d.subScore })),
    passThreshold: normalized.passThreshold,
  });
  return {
    gates,
    failedScenarioGates: gates
      .filter((g) => !g.pass && g.name !== "tasks-completed")
      .map((g) => g.name),
    dimensions,
    score,
    passed,
  };
}

// ---- synthetic contexts ----

/** Roster of a scenario: workers 0..N-1, then the lead (when any) at index N, as the runner boots them. */
export function scenarioRoster(
  scenario: Scenario,
): { index: number; agentId: string; isLead: boolean }[] {
  const workerCount = scenarioWorkerCount(scenario.workers);
  const roster = Array.from({ length: workerCount }, (_, index) => ({
    index,
    agentId: `worker-${index}`,
    isLead: false,
  }));
  if (scenario.lead) roster.push({ index: workerCount, agentId: "lead", isLead: true });
  return roster;
}

export interface ContextOptions {
  tasks?: SwarmTask[];
  /** Files by `w<workerIndex>:<absolute path>`, e.g. `"w0:/workspace/audit/report.md"`. */
  files?: Record<string, string>;
  /** Canned `apiGet` responses by exact path. Session-log paths are served from `logs`. */
  api?: Record<string, unknown>;
  /** Session-log rows by task id (see `toolCallRows`). */
  logs?: Record<string, Record<string, unknown>[]>;
  /** Shell command results by exact command; unlisted commands exit 1 with no output. */
  exec?: Record<string, { exitCode?: number; stdout?: string; stderr?: string }>;
  transcript?: string;
}

/** A judge context over a scenario's roster with canned files, API answers, logs and commands. */
export function makeContext(scenario: Scenario, opts: ContextOptions = {}): JudgeContext {
  const workers: JudgeWorkerContext[] = scenarioRoster(scenario).map((member) => ({
    index: member.index,
    agentId: member.agentId,
    isLead: member.isLead,
    role: member.isLead ? "lead" : "worker",
    exec: async (cmd: string) => {
      const hit = opts.exec?.[cmd];
      return {
        exitCode: hit?.exitCode ?? (hit ? 0 : 1),
        stdout: hit?.stdout ?? "",
        stderr: hit?.stderr ?? "",
      };
    },
    readFile: async (path: string) => opts.files?.[`w${member.index}:${path}`] ?? null,
  }));
  const first = workers[0] as JudgeWorkerContext;
  return {
    tasks: opts.tasks ?? [],
    transcript: opts.transcript ?? "",
    exec: first.exec,
    readFile: first.readFile,
    workers,
    apiGet: async (path: string) => {
      const logMatch = path.match(/^\/api\/tasks\/([^/?]+)\/session-logs/);
      if (logMatch) return { logs: opts.logs?.[logMatch[1] as string] ?? [] };
      return opts.api?.[path] ?? {};
    },
  };
}

/** One completed scenario task per spec, ids `task-<i>`, empty result: what an agent that did nothing reports. */
export function nullTasks(scenario: Scenario): SwarmTask[] {
  return scenario.tasks.map((spec, i) => ({
    id: `task-${i}`,
    title: spec.title,
    description: spec.description,
    status: "completed",
    result: "",
    output: "",
    origin: "run" as const,
  }));
}

/** The context a do-nothing agent leaves: tasks completed and empty, nothing else. */
export function nullContext(scenario: Scenario, overrides: ContextOptions = {}): JudgeContext {
  return makeContext(scenario, { tasks: nullTasks(scenario), ...overrides });
}

// ---- session-log rows (Claude stream-json shape, as the harness stores them) ----

/** A tool_use row followed by its tool_result row. */
export function toolCallRows(
  taskId: string,
  toolName: string,
  input: unknown,
  result: unknown,
  callId: string,
): Record<string, unknown>[] {
  return [
    {
      id: `${callId}-use`,
      taskId,
      content: JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "tool_use", id: callId, name: toolName, input }] },
      }),
    },
    {
      id: `${callId}-result`,
      taskId,
      content: JSON.stringify({
        type: "user",
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: callId,
              content: typeof result === "string" ? result : JSON.stringify(result),
            },
          ],
        },
      }),
    },
  ];
}

/** What a scenario contributes to grader validation. */
export interface GraderFixture {
  /**
   * The context a correct solution leaves behind. Must grade as `passed`.
   * Build it from the scenario's own answer key, never from the checks' regexes.
   */
  reference: () => JudgeContext;
  /** Tasks the runner awaits for the reference run (default: `task-*` ids in the context). */
  referenceUpfrontTasks?: () => SwarmTask[];
  /**
   * Overrides for the null agent's context, for state the null agent still sees
   * (seeded history returned by the API, an empty-but-present list endpoint).
   */
  nullContext?: () => JudgeContext;
  /** Why a fixture is shaped as it is, for the next author. */
  notes?: string;
}
