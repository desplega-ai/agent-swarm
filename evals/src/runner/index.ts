import type { Client } from "@libsql/client";
import { recomputeCost } from "../cost/recompute.ts";
import {
  clearAttemptResults,
  getRun,
  insertArtifact,
  insertAttempt,
  insertJudgment,
  listAttempts,
  listUnfinishedAttempts,
  setRunStatus,
  updateAttempt,
} from "../db/queries.ts";
import { AgenticJudgeError, judgeAgentic } from "../judge/agentic.ts";
import { runChecks } from "../judge/deterministic.ts";
import { beginJudging, clearJudging, endJudging } from "../judge/live-registry.ts";
import { judgeWithLlm } from "../judge/llm.ts";
import {
  beginAttemptProgress,
  finishAttemptProgress,
  formatRunnerLog,
  logLevelFor,
  pushAttemptLog,
  recordAttemptTimings,
  setAttemptPhase,
} from "../live/attempt-progress.ts";
import { flattenTranscript, type SessionCostRow, SwarmClient } from "../swarm/client.ts";
import {
  bootStack,
  collectHarnessSessionFiles,
  markAttemptStart,
  type StackHandle,
  sandboxExec,
  sandboxReadFile,
  sweepRunSandboxes,
} from "../swarm/sandbox.ts";
import type {
  AttemptRow,
  CostSource,
  DeterministicCheck,
  HarnessConfig,
  JudgeContext,
  JudgeTrace,
  PhaseTimings,
  SandboxInfo,
  Scenario,
  SwarmTask,
  TokenTotals,
} from "../types.ts";

const DEFAULT_TASK_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_MAX_RETRIES = 1; // infra retries per attempt (fresh sandboxes each try)

export interface Registry {
  scenarios: Map<string, Scenario>;
  configs: Map<string, HarnessConfig>;
}

/** Live stacks per run, so signal handlers / cancel endpoints can tear them down. */
const activeStacksByRun = new Map<string, Set<StackHandle>>();

function trackStack(runId: string, stack: StackHandle): () => void {
  let set = activeStacksByRun.get(runId);
  if (!set) {
    set = new Set();
    activeStacksByRun.set(runId, set);
  }
  set.add(stack);
  return () => {
    set?.delete(stack);
    if (set && set.size === 0) activeStacksByRun.delete(runId);
  };
}

/** Kill every live stack of one run (used by cancel). */
export async function killRunStacks(runId: string): Promise<void> {
  const stacks = [...(activeStacksByRun.get(runId) ?? [])];
  await Promise.allSettled(stacks.map((s) => s.kill()));
}

/** Kill every live stack of every run (used by SIGINT/SIGTERM handlers). */
export async function killAllActiveStacks(): Promise<void> {
  const runIds = [...activeStacksByRun.keys()];
  await Promise.allSettled(runIds.map((id) => killRunStacks(id)));
}

export function attemptId(
  runId: string,
  scenarioId: string,
  configId: string,
  index: number,
): string {
  return `${runId}_${scenarioId}_${configId}_${index}`;
}

export async function ensureAttemptRows(db: Client, runId: string): Promise<void> {
  const run = await getRun(db, runId);
  if (!run) throw new Error(`run ${runId} not found`);
  for (const scenarioId of run.scenarioIds) {
    for (const configId of run.configIds) {
      for (let i = 0; i < run.attemptsPerCell; i++) {
        await insertAttempt(db, {
          id: attemptId(runId, scenarioId, configId, i),
          runId,
          scenarioId,
          configId,
          attemptIndex: i,
        });
      }
    }
  }
}

function newPhaseTimings(): PhaseTimings {
  return {
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
}

/** Stopwatch for one phase: returns elapsed ms alongside the result. */
async function timed<T>(fn: () => Promise<T>): Promise<{ result: T; ms: number }> {
  const t0 = Date.now();
  const result = await fn();
  return { result, ms: Date.now() - t0 };
}

/** Aggregate swarm session-cost rows into TokenTotals (model = first non-null). */
function sumRowTokens(rows: SessionCostRow[]): TokenTotals {
  return {
    model: rows.find((r) => r.model)?.model ?? null,
    inputTokens: rows.reduce((s, r) => s + (r.inputTokens ?? 0), 0),
    outputTokens: rows.reduce((s, r) => s + (r.outputTokens ?? 0), 0),
    cacheReadTokens: rows.reduce((s, r) => s + (r.cacheReadTokens ?? 0), 0),
    cacheWriteTokens: rows.reduce((s, r) => s + (r.cacheWriteTokens ?? 0), 0),
  };
}

/** Sum two nullable USD amounts; null only when BOTH are null. */
function sumNullableCosts(a: number | null, b: number | null): number | null {
  if (a === null && b === null) return null;
  return (a ?? 0) + (b ?? 0);
}

/**
 * Field-wise sum of two judge token totals (failed agentic trace + llm
 * fallback). Model = the fallback's, else the failed trace's; null when both
 * are null.
 */
function mergeJudgeTokens(
  failed: TokenTotals | null,
  fallback: TokenTotals | null,
): TokenTotals | null {
  if (!failed && !fallback) return null;
  return {
    model: fallback?.model ?? failed?.model ?? null,
    inputTokens: (failed?.inputTokens ?? 0) + (fallback?.inputTokens ?? 0),
    outputTokens: (failed?.outputTokens ?? 0) + (fallback?.outputTokens ?? 0),
    cacheReadTokens: (failed?.cacheReadTokens ?? 0) + (fallback?.cacheReadTokens ?? 0),
    cacheWriteTokens: (failed?.cacheWriteTokens ?? 0) + (fallback?.cacheWriteTokens ?? 0),
  };
}

const SEED_OUTPUT_CLIP = 20_000;

/** Implicit deterministic check: every scenario task ended `completed`. */
function tasksCompletedCheck(tasks: SwarmTask[]): DeterministicCheck {
  return {
    name: "tasks-completed",
    fn: async () => {
      const bad = tasks.filter((t) => t.status !== "completed");
      return bad.length === 0
        ? { pass: true, detail: `${tasks.length} task(s) completed` }
        : {
            pass: false,
            detail: bad
              .map(
                (t) =>
                  `task ${t.id}: ${t.status}${(t as { timedOut?: boolean }).timedOut ? " (timed out)" : ""}`,
              )
              .join("; "),
          };
    },
  };
}

async function runAttemptOnce(opts: {
  db: Client;
  attempt: AttemptRow;
  scenario: Scenario;
  config: HarnessConfig;
  judgeModel: string | null;
  /** Cancel signal — checked at every phase boundary and inside every polling await. */
  signal?: AbortSignal;
  log: (msg: string) => void;
}): Promise<void> {
  const { db, attempt, scenario, config, signal } = opts;
  // Live progress registry (v4 §2.1): every runner log line + phase transition
  // for this attempt flows through here while it executes; the full capture is
  // persisted as the runner.log artifact in the finally below.
  beginAttemptProgress(attempt.id);
  const log = (msg: string): void => {
    opts.log(msg);
    pushAttemptLog(attempt.id, logLevelFor(msg), msg);
  };
  const startedAt = Date.now();
  const taskTimeoutMs = scenario.timeoutMs ?? DEFAULT_TASK_TIMEOUT_MS;
  // Sandbox TTL covers boot + all tasks + judging, with slack for retries inside.
  const timeoutSec = Math.ceil((taskTimeoutMs * scenario.tasks.length + 10 * 60 * 1000) / 1000);

  await updateAttempt(db, attempt.id, {
    status: "running",
    startedAt: new Date().toISOString(),
    error: null,
  });
  // A re-run of an interrupted attempt must not keep half-written results.
  await clearAttemptResults(db, attempt.id);

  const timings = newPhaseTimings();
  setAttemptPhase(attempt.id, "boot");
  const boot = await timed(() =>
    bootStack({
      config,
      swarmSlug: `evals-${attempt.runId}`,
      timeoutSec,
      signal,
      log: (msg) => log(`[boot] ${msg}`),
    }),
  );
  const stack = boot.result;
  timings.bootMs = boot.ms;
  recordAttemptTimings(attempt.id, timings);
  const untrack = trackStack(attempt.runId, stack);
  // Written at boot so the live run-details page shows sandbox info while the
  // attempt runs. The swarmKey is deliberately stored/exposed — eval sandboxes
  // are throwaway.
  const sandboxInfo: SandboxInfo = {
    apiSandboxId: stack.apiSandbox.sandboxID,
    workerSandboxId: stack.workerSandbox.sandboxID,
    apiTemplate: stack.apiSandbox.templateID,
    workerTemplate: stack.workerSandbox.templateID,
    apiUrl: stack.apiUrl,
    swarmKey: stack.swarmKey,
    workerAgentId: stack.workerAgentId,
    domain: stack.workerSandbox.domain ?? null,
    apiStartedAt: stack.apiSandbox.startedAt ?? null,
    workerStartedAt: stack.workerSandbox.startedAt ?? null,
    expiresAt: stack.workerSandbox.endAt ?? stack.workerSandbox.expiresAt ?? null,
    apiVersion: stack.apiVersion,
    workerVersion: stack.workerVersion,
  };
  await updateAttempt(db, attempt.id, {
    sandboxId: stack.workerSandbox.sandboxID,
    apiUrl: stack.apiUrl,
    sandboxJson: JSON.stringify(sandboxInfo),
  });

  try {
    const client = new SwarmClient(stack.apiUrl, stack.swarmKey);
    await markAttemptStart(stack.workerSandbox.sandboxID);

    if (scenario.seed?.exec?.length) {
      signal?.throwIfAborted();
      setAttemptPhase(attempt.id, "seed");
      const seedT0 = Date.now();
      const seedOutputs: {
        cmd: string;
        exitCode: number;
        durationMs: number;
        stdout: string;
        stderr: string;
      }[] = [];
      try {
        for (const cmd of scenario.seed.exec) {
          log(`[seed] ${cmd}`);
          const cmdT0 = Date.now();
          const res = await sandboxExec(stack.workerSandbox.sandboxID, cmd);
          seedOutputs.push({
            cmd,
            exitCode: res.exitCode,
            durationMs: Date.now() - cmdT0,
            stdout: res.stdout.slice(0, SEED_OUTPUT_CLIP),
            stderr: res.stderr.slice(0, SEED_OUTPUT_CLIP),
          });
          log(`[seed] exit ${res.exitCode} in ${Date.now() - cmdT0}ms`);
          if (res.exitCode !== 0) {
            throw new Error(
              `seed command failed (${res.exitCode}): ${cmd}\n${res.stderr.slice(0, 500)}`,
            );
          }
        }
      } finally {
        // Written on success AND before a seed-failure throw (retry clears it).
        timings.seedMs = Date.now() - seedT0;
        recordAttemptTimings(attempt.id, timings);
        await insertArtifact(db, {
          id: crypto.randomUUID(),
          attemptId: attempt.id,
          kind: "meta",
          name: "seed-output.json",
          content: stack.redact(JSON.stringify(seedOutputs, null, 2)),
        });
      }
    }

    const tasks: SwarmTask[] = [];
    setAttemptPhase(attempt.id, "tasks");
    const tasksT0 = Date.now();
    for (const spec of scenario.tasks) {
      signal?.throwIfAborted();
      log(`[task] creating "${spec.title}" → agent ${stack.workerAgentId}`);
      const created = await client.createTask({
        task: `${spec.title}\n\n${spec.description}`,
        agentId: stack.workerAgentId,
      });
      log(`[task] created ${created.id} — waiting (timeout ${Math.round(taskTimeoutMs / 1000)}s)`);
      const taskT0 = Date.now();
      const final = await client.waitForTask(created.id, {
        timeoutMs: taskTimeoutMs,
        onStatus: (s) => log(`[task] ${created.id} -> ${s}`),
        signal,
      });
      timings.perTask.push({ taskId: created.id, ms: Date.now() - taskT0 });
      recordAttemptTimings(attempt.id, timings);
      tasks.push(final);
    }
    timings.tasksMs = Date.now() - tasksT0;
    recordAttemptTimings(attempt.id, timings);
    await updateAttempt(db, attempt.id, { taskIds: tasks.map((t) => t.id) });

    // Gather gradeable outputs (logs lag completion — wait for a stable count).
    signal?.throwIfAborted();
    setAttemptPhase(attempt.id, "log-capture");
    log(`[logs] waiting for stable session logs (${tasks.length} task(s))`);
    const logCapture = await timed(async () =>
      (
        await Promise.all(tasks.map((t) => client.getStableSessionLogs(t.id, undefined, signal)))
      ).flat(),
    );
    let logRows = logCapture.result;
    timings.logCaptureMs = logCapture.ms;
    recordAttemptTimings(attempt.id, timings);
    log(`[logs] captured ${logRows.length} session-log row(s) in ${logCapture.ms}ms`);

    // 1. harness-reported session-cost rows (stability-polled).
    signal?.throwIfAborted();
    setAttemptPhase(attempt.id, "cost");
    log(`[cost] waiting for stable session-cost rows (${tasks.length} task(s))`);
    const costT0 = Date.now();
    const costRowsByTask: { taskId: string; rows: SessionCostRow[] }[] = [];
    let allRows: SessionCostRow[] = [];
    for (const task of tasks) {
      const rows = await client.waitForSessionCostRows(task.id, undefined, signal);
      costRowsByTask.push({ taskId: task.id, rows });
      allRows = allRows.concat(rows);
    }
    let costMs = Date.now() - costT0;

    // The cost wait gave late log batches time to flush — re-fetch once and keep
    // the larger set (fixes transcripts losing their tail to the 30s stability cap).
    const refetch = await timed(async () =>
      (await Promise.all(tasks.map((t) => client.getSessionLogs(t.id).catch(() => [])))).flat(),
    );
    timings.logCaptureMs += refetch.ms;
    recordAttemptTimings(attempt.id, timings);
    if (refetch.result.length > logRows.length) logRows = refetch.result;
    const transcript = flattenTranscript(logRows);

    // Harness session files — captured before judging so cost recompute can reuse them.
    let sessionFiles: Awaited<ReturnType<typeof collectHarnessSessionFiles>> = {
      files: [],
      listing: [],
    };
    try {
      const collect = await timed(() =>
        collectHarnessSessionFiles(stack.workerSandbox.sandboxID, config.provider),
      );
      sessionFiles = collect.result;
      timings.artifactsMs = (timings.artifactsMs ?? 0) + collect.ms;
      recordAttemptTimings(attempt.id, timings);
    } catch (err) {
      log(
        `[artifacts] harness session capture failed: ${err instanceof Error ? err.message : err}`,
      );
    }

    // 2. recomputed from tokens × models.dev pricing; 3. tagged unpriced.
    const priced = allRows.some(
      (r) => (r.totalCostUsd ?? 0) > 0 || (r.costSource && r.costSource !== "unpriced"),
    );
    let costUsd: number | null = null;
    let costSource: CostSource | null = null;
    let tokens: TokenTotals | null = null;
    if (allRows.length > 0 && priced) {
      costUsd = allRows.reduce((s, r) => s + (r.totalCostUsd ?? 0), 0);
      costSource = "harness";
      tokens = sumRowTokens(allRows);
    } else {
      const recompute = await timed(() =>
        recomputeCost({
          provider: config.provider,
          configModel: config.model ?? null,
          logRows,
          sessionFiles: sessionFiles.files,
        }),
      );
      costMs += recompute.ms;
      tokens = recompute.result.tokens;
      if (recompute.result.costUsd !== null) {
        costUsd = recompute.result.costUsd;
        costSource = "recomputed";
      } else {
        costSource = "unpriced"; // tokens (if any) still stored
      }
    }
    timings.costMs = costMs;
    recordAttemptTimings(attempt.id, timings);
    log(`[cost] source=${costSource}${costUsd !== null ? ` $${costUsd.toFixed(4)}` : ""}`);
    // Raw session-cost rows, always — even when empty.
    await insertArtifact(db, {
      id: crypto.randomUUID(),
      attemptId: attempt.id,
      kind: "meta",
      name: "session-costs.json",
      content: stack.redact(JSON.stringify(costRowsByTask, null, 2)),
    });

    // No judge calls (real LLM spend) may run after a cancel.
    signal?.throwIfAborted();
    await updateAttempt(db, attempt.id, { status: "judging" });
    // Judges stream their (mutable) traces here; the API server reads them for
    // the polled /api/attempts/:id/judge-live endpoint. Cleared in `finally`.
    const judgeLive = beginJudging(attempt.id);
    // Aggregate judge LLM cost (harness overhead) — NEVER added to costUsd.
    let judgeCostUsd: number | null = null;
    const addJudgeCost = (c: number | null): void => {
      if (c !== null) judgeCostUsd = (judgeCostUsd ?? 0) + c;
    };

    const ctx: JudgeContext = {
      tasks,
      transcript,
      exec: (cmd) => sandboxExec(stack.workerSandbox.sandboxID, cmd),
      readFile: (path) => sandboxReadFile(stack.workerSandbox.sandboxID, path),
      apiGet: (path) => client.get(path),
    };

    const checks = [tasksCompletedCheck(tasks), ...(scenario.outcome.checks ?? [])];
    setAttemptPhase(attempt.id, "checks");
    log(`[check] running ${checks.length} deterministic check(s)`);
    const checksTimed = await timed(() => runChecks(checks, ctx, judgeLive));
    const checkResults = checksTimed.result;
    timings.checksMs = checksTimed.ms;
    recordAttemptTimings(attempt.id, timings);
    for (const result of checkResults) {
      await insertJudgment(db, {
        id: crypto.randomUUID(),
        attemptId: attempt.id,
        kind: "deterministic",
        name: result.name,
        pass: result.pass,
        reasoning: result.detail ?? null,
        durationMs: result.durationMs,
      });
      log(
        `[check] ${result.name}: ${result.pass ? "pass" : "FAIL"}${result.detail ? ` (${result.detail})` : ""}`,
      );
    }
    const checksPass = checkResults.every((r) => r.pass);

    const threshold = scenario.outcome.passThreshold ?? 0.7;
    let llmPass = true;
    let score: number | null = null;

    if (scenario.outcome.llmJudge) {
      const spec = scenario.outcome.llmJudge;
      signal?.throwIfAborted();
      setAttemptPhase(attempt.id, "llm-judge");
      log(`[judge] llm judge starting (model ${spec.model ?? opts.judgeModel ?? "default"})`);
      const llmTimed = await timed(() =>
        judgeWithLlm({
          scenario,
          rubric: spec.rubric,
          tasks,
          transcript,
          model: spec.model ?? opts.judgeModel ?? undefined,
          live: judgeLive,
        }),
      );
      const verdict = llmTimed.result;
      timings.llmJudgeMs = llmTimed.ms;
      recordAttemptTimings(attempt.id, timings);
      score = verdict.score;
      llmPass = verdict.pass && verdict.score >= threshold;
      await insertJudgment(db, {
        id: crypto.randomUUID(),
        attemptId: attempt.id,
        kind: "llm",
        name: "llm-judge",
        pass: llmPass,
        score: verdict.score,
        reasoning: verdict.reasoning,
        raw: verdict.raw,
        durationMs: verdict.trace.durationMs ?? llmTimed.ms,
        costUsd: verdict.trace.costUsd,
        tokensJson: verdict.trace.tokens ? JSON.stringify(verdict.trace.tokens) : null,
        stepsJson: JSON.stringify(verdict.trace.steps),
      });
      addJudgeCost(verdict.trace.costUsd);
      log(`[judge] llm score=${verdict.score.toFixed(2)} pass=${llmPass}`);
    }

    let agenticPass = true;
    if (scenario.outcome.agenticJudge) {
      const spec = scenario.outcome.agenticJudge;
      signal?.throwIfAborted();
      setAttemptPhase(attempt.id, "agentic-judge");
      log(
        `[judge] agentic judge starting (model ${spec.model ?? opts.judgeModel ?? "default"}` +
          `${spec.maxSteps ? `, maxSteps ${spec.maxSteps}` : ""})`,
      );
      const agenticT0 = Date.now();
      let verdict: Awaited<ReturnType<typeof judgeAgentic>>;
      let judgeName = "agentic-judge";
      // Kept on AgenticJudgeError so the failed loop's steps/cost are never lost.
      let failedTrace: JudgeTrace | null = null;
      try {
        verdict = await judgeAgentic({
          scenario,
          rubric: spec.rubric,
          tasks,
          transcript,
          ctx,
          model: spec.model ?? opts.judgeModel ?? undefined,
          maxSteps: spec.maxSteps,
          live: judgeLive,
        });
      } catch (err) {
        // Cancel mid-agentic-judge kills the sandbox, which makes the judge's
        // exec tools fail — don't start a fresh LLM judge call post-abort
        // (frozen contract: no judge calls run after the abort).
        signal?.throwIfAborted();
        // Agent never submitted a verdict (or judge-model flake) — fall back to
        // the plain LLM judge rather than burning the whole attempt.
        log(
          `[judge] agentic judge failed (${err instanceof Error ? err.message : err}); falling back to llm judge`,
        );
        failedTrace = err instanceof AgenticJudgeError ? err.trace : null;
        judgeName = "agentic-judge (llm fallback)";
        verdict = await judgeWithLlm({
          scenario,
          rubric: spec.rubric,
          tasks,
          transcript,
          model: spec.model ?? opts.judgeModel ?? undefined,
          live: judgeLive,
        });
      }
      timings.agenticJudgeMs = Date.now() - agenticT0;
      recordAttemptTimings(attempt.id, timings);
      agenticPass = verdict.pass && verdict.score >= threshold;
      // Agentic verdicts verify against the live sandbox, so they take score precedence.
      score = verdict.score;
      // Fallback path: merge the failed agentic trace with the fallback's —
      // the failed loop's spend is real and MUST be counted.
      const steps = failedTrace
        ? [...failedTrace.steps, ...verdict.trace.steps].map((s, i) => ({ ...s, index: i }))
        : verdict.trace.steps;
      const judgmentCost = failedTrace
        ? sumNullableCosts(failedTrace.costUsd, verdict.trace.costUsd)
        : verdict.trace.costUsd;
      const judgmentTokens = failedTrace
        ? mergeJudgeTokens(failedTrace.tokens, verdict.trace.tokens)
        : verdict.trace.tokens;
      await insertJudgment(db, {
        id: crypto.randomUUID(),
        attemptId: attempt.id,
        kind: "llm",
        name: judgeName,
        pass: agenticPass,
        score: verdict.score,
        reasoning: verdict.reasoning,
        raw: verdict.raw,
        durationMs: failedTrace
          ? timings.agenticJudgeMs
          : (verdict.trace.durationMs ?? timings.agenticJudgeMs),
        costUsd: judgmentCost,
        tokensJson: judgmentTokens ? JSON.stringify(judgmentTokens) : null,
        stepsJson: JSON.stringify(steps),
      });
      addJudgeCost(judgmentCost);
      log(`[judge] agentic score=${verdict.score.toFixed(2)} pass=${agenticPass}`);
    }

    // Live view flips judging → false; traces stay readable until clearJudging.
    endJudging(attempt.id);

    const passed = checksPass && llmPass && agenticPass;
    if (score === null) score = passed ? 1 : 0;

    // Persist artifacts (redacted) before the sandboxes die.
    signal?.throwIfAborted();
    setAttemptPhase(attempt.id, "artifacts");
    log("[artifacts] persisting transcript, session files, tasks, and sandbox logs");
    const artifactsT0 = Date.now();
    await insertArtifact(db, {
      id: crypto.randomUUID(),
      attemptId: attempt.id,
      kind: "transcript",
      content: stack.redact(transcript).slice(0, 400_000),
    });
    // Raw swarm session-log events, one JSON object per line (id/createdAt kept
    // so the transcript viewer can order + coalesce without hitting the dead stack).
    if (logRows.length > 0) {
      const jsonl = logRows
        .map((r) =>
          JSON.stringify({
            id: r.id,
            taskId: r.taskId,
            sessionId: r.sessionId,
            iteration: r.iteration,
            lineNumber: r.lineNumber,
            cli: r.cli,
            content: r.content,
            createdAt: r.createdAt,
          }),
        )
        .join("\n");
      await insertArtifact(db, {
        id: crypto.randomUUID(),
        attemptId: attempt.id,
        kind: "raw-session-logs",
        name: "session-logs.jsonl",
        content: stack.redact(jsonl).slice(0, 2_000_000),
      });
    }
    // The harness's own raw session files (collected pre-judging above).
    for (const file of sessionFiles.files) {
      await insertArtifact(db, {
        id: crypto.randomUUID(),
        attemptId: attempt.id,
        kind: "harness-session",
        name: file.path + (file.truncated ? " (truncated)" : ""),
        content: stack.redact(file.content),
      });
    }
    if (sessionFiles.files.length > 0) {
      log(`[artifacts] captured ${sessionFiles.files.length} harness session file(s)`);
    }
    if (sessionFiles.listing.length > 0) {
      await insertArtifact(db, {
        id: crypto.randomUUID(),
        attemptId: attempt.id,
        kind: "meta",
        name: "session-files.json",
        content: stack.redact(JSON.stringify(sessionFiles.listing, null, 2)),
      });
    }
    await insertArtifact(db, {
      id: crypto.randomUUID(),
      attemptId: attempt.id,
      kind: "task",
      name: "tasks.json",
      content: stack.redact(JSON.stringify(tasks, null, 2)),
    });
    const workerLog = await sandboxExec(
      stack.workerSandbox.sandboxID,
      "tail -n 2000 /tmp/agent-swarm-e2b-worker.log",
    ).catch(() => null);
    if (workerLog?.stdout) {
      await insertArtifact(db, {
        id: crypto.randomUUID(),
        attemptId: attempt.id,
        kind: "sandbox-log",
        name: "worker.log",
        content: stack.redact(workerLog.stdout),
      });
    }
    const apiLog = await sandboxExec(
      stack.apiSandbox.sandboxID,
      "tail -n 500 /tmp/agent-swarm-e2b-api.log",
    ).catch(() => null);
    if (apiLog?.stdout) {
      await insertArtifact(db, {
        id: crypto.randomUUID(),
        attemptId: attempt.id,
        kind: "sandbox-log",
        name: "api.log",
        content: stack.redact(apiLog.stdout),
      });
    }
    timings.artifactsMs = (timings.artifactsMs ?? 0) + (Date.now() - artifactsT0);
    recordAttemptTimings(attempt.id, timings);
    setAttemptPhase(attempt.id, null);

    await updateAttempt(db, attempt.id, {
      status: passed ? "passed" : "failed",
      passed,
      score,
      costUsd,
      costSource,
      judgeCostUsd,
      tokensJson: tokens ? JSON.stringify(tokens) : null,
      timingsJson: JSON.stringify(timings),
      durationMs: Date.now() - startedAt,
      finishedAt: new Date().toISOString(),
    });
    log(
      `[done] ${passed ? "PASSED" : "FAILED"} score=${score.toFixed(2)}${costUsd !== null ? ` cost=$${costUsd.toFixed(4)}` : ""}`,
    );
  } finally {
    // After final persistence on success, and on every error path — the live
    // registry never leaks. Retries re-enter via beginJudging (resets entry).
    clearJudging(attempt.id);
    // Persist the full captured runner log as an artifact (v4 §2.2). Best-effort:
    // a DB hiccup here must not mask the attempt's own error or skip teardown.
    // `clearAttemptResults` wipes it on retry — each try gets a fresh runner.log.
    try {
      const progressLog = finishAttemptProgress(attempt.id);
      if (progressLog.length > 0) {
        await insertArtifact(db, {
          id: crypto.randomUUID(),
          attemptId: attempt.id,
          kind: "log",
          name: "runner.log",
          content: stack.redact(formatRunnerLog(progressLog)),
        });
      }
    } catch (err) {
      opts.log(
        `[artifacts] runner.log persist failed: ${err instanceof Error ? err.message : err}`,
      );
    }
    untrack();
    await stack.kill();
  }
}

async function runAttemptWithRetry(opts: {
  db: Client;
  attempt: AttemptRow;
  registry: Registry;
  maxRetries: number;
  judgeModel: string | null;
  signal?: AbortSignal;
  log: (msg: string) => void;
}): Promise<void> {
  const { db, attempt, registry } = opts;
  // Own lines ([error]/[retry]) also flow into the live registry — pushAttemptLog
  // no-ops once runAttemptOnce's finally has already cleared the entry.
  const log = (msg: string): void => {
    opts.log(msg);
    pushAttemptLog(attempt.id, logLevelFor(msg), msg);
  };
  const scenario = registry.scenarios.get(attempt.scenarioId);
  const config = registry.configs.get(attempt.configId);
  if (!scenario || !config) {
    await updateAttempt(db, attempt.id, {
      status: "error",
      error: `unknown ${!scenario ? `scenario ${attempt.scenarioId}` : `config ${attempt.configId}`}`,
      finishedAt: new Date().toISOString(),
    });
    return;
  }
  for (let retry = attempt.retries; ; retry++) {
    try {
      await runAttemptOnce({
        db,
        attempt,
        scenario,
        config,
        judgeModel: opts.judgeModel,
        signal: opts.signal,
        // Raw log — runAttemptOnce wraps it once for the live registry itself.
        log: opts.log,
      });
      return;
    } catch (err) {
      const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
      log(`[error] ${message.split("\n")[0]}`);
      // Leak guard: boot failures throw before runAttemptOnce's inner finally can
      // run, so the progress entry may still be live. Idempotent — [] once cleared.
      const orphanedLog = finishAttemptProgress(attempt.id);
      if (opts.signal?.aborted) {
        // Cancelled mid-attempt — leave it pending so resume re-runs it cleanly.
        await updateAttempt(db, attempt.id, { status: "pending", retries: retry });
        return;
      }
      if (retry >= opts.maxRetries) {
        if (orphanedLog.length > 0) {
          // Terminal error before the stack existed (no redact available — the
          // boot log carries no secrets beyond throwaway sandbox ids). Best-effort.
          try {
            await insertArtifact(db, {
              id: crypto.randomUUID(),
              attemptId: attempt.id,
              kind: "log",
              name: "runner.log",
              content: formatRunnerLog(orphanedLog),
            });
          } catch {
            // never mask the terminal error below
          }
        }
        await updateAttempt(db, attempt.id, {
          status: "error",
          retries: retry,
          error: message.slice(0, 4000),
          finishedAt: new Date().toISOString(),
        });
        return;
      }
      await updateAttempt(db, attempt.id, { retries: retry + 1, error: message.slice(0, 4000) });
      log(`[retry] attempt ${attempt.id} retrying (${retry + 1}/${opts.maxRetries})`);
    }
  }
}

async function pool<T>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<void>,
  shouldStop?: () => boolean,
): Promise<void> {
  const queue = [...items];
  const workers = Array.from({ length: Math.max(1, concurrency) }, async () => {
    while (true) {
      if (shouldStop?.()) return;
      const item = queue.shift();
      if (item === undefined) return;
      await fn(item);
    }
  });
  await Promise.all(workers);
}

/**
 * Execute (or resume) an eval run: every unfinished attempt in the
 * scenarios x configs x attemptsPerCell matrix, with safe retry. Attempts that
 * already reached a terminal state are skipped, so re-invoking after a crash
 * or Ctrl-C continues where it left off.
 */
export async function executeRun(opts: {
  db: Client;
  runId: string;
  registry: Registry;
  maxRetries?: number;
  /** Abort starting new attempts (cancel / Ctrl-C). In-flight stacks are killed by the caller. */
  signal?: AbortSignal;
  log?: (msg: string) => void;
}): Promise<void> {
  const { db, runId, registry, signal } = opts;
  const baseLog = opts.log ?? ((msg: string) => console.log(msg));
  const run = await getRun(db, runId);
  if (!run) throw new Error(`run ${runId} not found`);

  await ensureAttemptRows(db, runId);
  await setRunStatus(db, runId, "running");

  // A previous execution may have died mid-attempt and leaked its sandboxes.
  const swept = await sweepRunSandboxes(runId, baseLog);
  if (swept > 0) baseLog(`swept ${swept} leaked sandbox(es) from a previous execution`);

  const unfinished = await listUnfinishedAttempts(db, runId);
  baseLog(
    `run ${runId}: ${unfinished.length} attempt(s) to execute (concurrency ${run.concurrency})`,
  );

  await pool(
    unfinished,
    run.concurrency,
    (attempt) =>
      runAttemptWithRetry({
        db,
        attempt,
        registry,
        maxRetries: opts.maxRetries ?? DEFAULT_MAX_RETRIES,
        judgeModel: run.judgeModel,
        signal,
        log: (msg) =>
          baseLog(`[${attempt.scenarioId} × ${attempt.configId} #${attempt.attemptIndex}] ${msg}`),
      }),
    () => signal?.aborted ?? false,
  );

  if (signal?.aborted) {
    await setRunStatus(db, runId, "cancelled");
    baseLog(`run ${runId} cancelled — unfinished attempts stay pending; resume to continue`);
    return;
  }
  const attempts = await listAttempts(db, runId);
  const allErrored = attempts.length > 0 && attempts.every((a) => a.status === "error");
  await setRunStatus(db, runId, allErrored ? "failed" : "done");
  baseLog(
    `run ${runId} finished: ${attempts.filter((a) => a.status === "passed").length}/${attempts.length} attempts passed`,
  );
}
