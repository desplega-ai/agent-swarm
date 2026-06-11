import type { Client } from "@libsql/client";
import {
  getRun,
  insertArtifact,
  insertAttempt,
  insertJudgment,
  listAttempts,
  listUnfinishedAttempts,
  setRunStatus,
  updateAttempt,
} from "../db/queries.ts";
import { runChecks } from "../judge/deterministic.ts";
import { judgeWithLlm } from "../judge/llm.ts";
import { flattenTranscript, SwarmClient } from "../swarm/client.ts";
import { bootStack, sandboxExec, sandboxReadFile } from "../swarm/sandbox.ts";
import type {
  AttemptRow,
  DeterministicCheck,
  HarnessConfig,
  JudgeContext,
  Scenario,
  SwarmTask,
} from "../types.ts";

const DEFAULT_TASK_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_MAX_RETRIES = 1; // infra retries per attempt (fresh sandboxes each try)

export interface Registry {
  scenarios: Map<string, Scenario>;
  configs: Map<string, HarnessConfig>;
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
  log: (msg: string) => void;
}): Promise<void> {
  const { db, attempt, scenario, config, log } = opts;
  const startedAt = Date.now();
  const taskTimeoutMs = scenario.timeoutMs ?? DEFAULT_TASK_TIMEOUT_MS;
  // Sandbox TTL covers boot + all tasks + judging, with slack for retries inside.
  const timeoutSec = Math.ceil((taskTimeoutMs * scenario.tasks.length + 10 * 60 * 1000) / 1000);

  await updateAttempt(db, attempt.id, {
    status: "running",
    startedAt: new Date().toISOString(),
    error: null,
  });

  const stack = await bootStack({
    config,
    swarmSlug: `evals-${attempt.runId}`,
    timeoutSec,
    log: (msg) => log(`[boot] ${msg}`),
  });
  await updateAttempt(db, attempt.id, {
    sandboxId: stack.workerSandbox.sandboxID,
    apiUrl: stack.apiUrl,
  });

  try {
    const client = new SwarmClient(stack.apiUrl, stack.swarmKey);

    for (const cmd of scenario.seed?.exec ?? []) {
      log(`[seed] ${cmd}`);
      const res = await sandboxExec(stack.workerSandbox.sandboxID, cmd);
      if (res.exitCode !== 0) {
        throw new Error(
          `seed command failed (${res.exitCode}): ${cmd}\n${res.stderr.slice(0, 500)}`,
        );
      }
    }

    const tasks: SwarmTask[] = [];
    for (const spec of scenario.tasks) {
      const created = await client.createTask({
        task: `${spec.title}\n\n${spec.description}`,
        agentId: stack.workerAgentId,
      });
      log(`[task] created ${created.id} — waiting (timeout ${Math.round(taskTimeoutMs / 1000)}s)`);
      const final = await client.waitForTask(created.id, {
        timeoutMs: taskTimeoutMs,
        onStatus: (s) => log(`[task] ${created.id} -> ${s}`),
      });
      tasks.push(final);
    }
    await updateAttempt(db, attempt.id, { taskIds: tasks.map((t) => t.id) });

    // Gather gradeable outputs (logs lag completion — wait for a stable count).
    const logRows = (await Promise.all(tasks.map((t) => client.getStableSessionLogs(t.id)))).flat();
    const transcript = flattenTranscript(logRows);

    let costUsd: number | null = null;
    for (const task of tasks) {
      const c = await client.waitForTaskCost(
        task.id,
        typeof task.totalCostUsd === "number" ? task.totalCostUsd : null,
      );
      if (c !== null) costUsd = (costUsd ?? 0) + c;
    }

    await updateAttempt(db, attempt.id, { status: "judging" });

    const ctx: JudgeContext = {
      tasks,
      transcript,
      exec: (cmd) => sandboxExec(stack.workerSandbox.sandboxID, cmd),
      readFile: (path) => sandboxReadFile(stack.workerSandbox.sandboxID, path),
      apiGet: (path) => client.get(path),
    };

    const checks = [tasksCompletedCheck(tasks), ...(scenario.outcome.checks ?? [])];
    const checkResults = await runChecks(checks, ctx);
    for (const result of checkResults) {
      await insertJudgment(db, {
        id: crypto.randomUUID(),
        attemptId: attempt.id,
        kind: "deterministic",
        name: result.name,
        pass: result.pass,
        reasoning: result.detail ?? null,
      });
      log(
        `[check] ${result.name}: ${result.pass ? "pass" : "FAIL"}${result.detail ? ` (${result.detail})` : ""}`,
      );
    }
    const checksPass = checkResults.every((r) => r.pass);

    let llmPass = true;
    let score: number | null = null;
    if (scenario.outcome.llmJudge) {
      const threshold = scenario.outcome.passThreshold ?? 0.7;
      const verdict = await judgeWithLlm({
        scenario,
        rubric: scenario.outcome.llmJudge.rubric,
        tasks,
        transcript,
        model: scenario.outcome.llmJudge.model,
      });
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
      });
      log(`[judge] llm score=${verdict.score.toFixed(2)} pass=${llmPass}`);
    }

    const passed = checksPass && llmPass;
    if (score === null) score = passed ? 1 : 0;

    // Persist artifacts (redacted) before the sandboxes die.
    await insertArtifact(db, {
      id: crypto.randomUUID(),
      attemptId: attempt.id,
      kind: "transcript",
      content: stack.redact(transcript).slice(0, 400_000),
    });
    await insertArtifact(db, {
      id: crypto.randomUUID(),
      attemptId: attempt.id,
      kind: "task",
      name: "tasks.json",
      content: stack.redact(JSON.stringify(tasks, null, 2)),
    });
    const workerLog = await sandboxExec(
      stack.workerSandbox.sandboxID,
      "tail -n 300 /tmp/agent-swarm-e2b-worker.log",
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

    await updateAttempt(db, attempt.id, {
      status: passed ? "passed" : "failed",
      passed,
      score,
      costUsd,
      durationMs: Date.now() - startedAt,
      finishedAt: new Date().toISOString(),
    });
    log(
      `[done] ${passed ? "PASSED" : "FAILED"} score=${score.toFixed(2)}${costUsd !== null ? ` cost=$${costUsd.toFixed(4)}` : ""}`,
    );
  } finally {
    await stack.kill();
  }
}

async function runAttemptWithRetry(opts: {
  db: Client;
  attempt: AttemptRow;
  registry: Registry;
  maxRetries: number;
  log: (msg: string) => void;
}): Promise<void> {
  const { db, attempt, registry, log } = opts;
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
      await runAttemptOnce({ db, attempt, scenario, config, log });
      return;
    } catch (err) {
      const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
      log(`[error] ${message.split("\n")[0]}`);
      if (retry >= opts.maxRetries) {
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
): Promise<void> {
  const queue = [...items];
  const workers = Array.from({ length: Math.max(1, concurrency) }, async () => {
    while (true) {
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
  log?: (msg: string) => void;
}): Promise<void> {
  const { db, runId, registry } = opts;
  const baseLog = opts.log ?? ((msg: string) => console.log(msg));
  const run = await getRun(db, runId);
  if (!run) throw new Error(`run ${runId} not found`);

  await ensureAttemptRows(db, runId);
  await setRunStatus(db, runId, "running");

  const unfinished = await listUnfinishedAttempts(db, runId);
  baseLog(
    `run ${runId}: ${unfinished.length} attempt(s) to execute (concurrency ${run.concurrency})`,
  );

  await pool(unfinished, run.concurrency, (attempt) =>
    runAttemptWithRetry({
      db,
      attempt,
      registry,
      maxRetries: opts.maxRetries ?? DEFAULT_MAX_RETRIES,
      log: (msg) =>
        baseLog(`[${attempt.scenarioId} × ${attempt.configId} #${attempt.attemptIndex}] ${msg}`),
    }),
  );

  const attempts = await listAttempts(db, runId);
  const allErrored = attempts.length > 0 && attempts.every((a) => a.status === "error");
  await setRunStatus(db, runId, allErrored ? "failed" : "done");
  baseLog(
    `run ${runId} finished: ${attempts.filter((a) => a.status === "passed").length}/${attempts.length} attempts passed`,
  );
}
