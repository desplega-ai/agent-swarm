import type { Client, Row } from "@libsql/client";
import type {
  ArtifactRow,
  AttemptExclusion,
  AttemptRow,
  AttemptStatus,
  CostSource,
  EvalRunRow,
  JudgeStep,
  JudgmentRow,
  PhaseTimings,
  ReasoningEffortLevel,
  RunStatus,
  SandboxInfo,
  TokenTotals,
  WorkerRosterEntry,
} from "../types.ts";

function rowToRun(r: Row): EvalRunRow {
  return {
    id: r.id as string,
    name: (r.name as string) ?? null,
    status: r.status as RunStatus,
    scenarioIds: JSON.parse(r.scenario_ids as string),
    configIds: JSON.parse(r.config_ids as string),
    attemptsPerCell: Number(r.attempts_per_cell),
    concurrency: Number(r.concurrency),
    judgeModel: (r.judge_model as string) ?? null,
    efforts: parseJsonColumn<Record<string, ReasoningEffortLevel>>(r.efforts_json),
    maxMeteredUsd: r.max_metered_usd == null ? null : Number(r.max_metered_usd),
    preset: (r.preset as string) ?? null,
    rerunOf: (r.rerun_of as string) ?? null,
    summaryPostedAt: (r.summary_posted_at as string) ?? null,
    createdAt: r.created_at as string,
    finishedAt: (r.finished_at as string) ?? null,
  };
}

function parseJsonColumn<T>(value: unknown): T | null {
  if (typeof value !== "string" || value.length === 0) return null;
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

function rowToAttempt(r: Row): AttemptRow {
  return {
    id: r.id as string,
    runId: r.run_id as string,
    scenarioId: r.scenario_id as string,
    configId: r.config_id as string,
    attemptIndex: Number(r.attempt_index),
    status: r.status as AttemptStatus,
    scenarioVersion: r.scenario_version == null ? null : Number(r.scenario_version),
    suiteVersion: (r.suite_version as string) ?? null,
    exclusion: (r.exclusion as AttemptExclusion) ?? null,
    retries: Number(r.retries),
    sandboxId: (r.sandbox_id as string) ?? null,
    apiUrl: (r.api_url as string) ?? null,
    taskIds: JSON.parse((r.task_ids as string) ?? "[]"),
    score: r.score === null ? null : Number(r.score),
    passed: r.passed === null ? null : Boolean(r.passed),
    error: (r.error as string) ?? null,
    costUsd: r.cost_usd === null ? null : Number(r.cost_usd),
    costSource: (r.cost_source as CostSource) ?? null,
    judgeCostUsd: r.judge_cost_usd === null ? null : Number(r.judge_cost_usd),
    tokens: parseJsonColumn<TokenTotals>(r.tokens_json),
    reasoningEffort: (r.reasoning_effort as ReasoningEffortLevel) ?? null,
    appliedReasoningEffort: (r.applied_reasoning_effort as ReasoningEffortLevel) ?? null,
    sandbox: parseJsonColumn<SandboxInfo>(r.sandbox_json),
    // v7 §10.1 — null on pre-v7 rows (readers fall back to sandbox.workers).
    workers: parseJsonColumn<WorkerRosterEntry[]>(r.workers_json),
    timings: parseJsonColumn<PhaseTimings>(r.timings_json),
    durationMs: r.duration_ms === null ? null : Number(r.duration_ms),
    startedAt: (r.started_at as string) ?? null,
    finishedAt: (r.finished_at as string) ?? null,
  };
}

function rowToJudgment(r: Row): JudgmentRow {
  return {
    id: r.id as string,
    attemptId: r.attempt_id as string,
    kind: r.kind as "llm" | "deterministic",
    name: r.name as string,
    pass: Boolean(r.pass),
    score: r.score === null ? null : Number(r.score),
    reasoning: (r.reasoning as string) ?? null,
    raw: (r.raw as string) ?? null,
    durationMs: r.duration_ms === null ? null : Number(r.duration_ms),
    costUsd: r.cost_usd === null ? null : Number(r.cost_usd),
    tokens: parseJsonColumn<TokenTotals>(r.tokens_json),
    steps: parseJsonColumn<JudgeStep[]>(r.steps_json),
    // v8.0 OutcomeSpec v2 — NULL on gate rows and all pre-v2 rows.
    dimension: (r.dimension as string) ?? null,
    weight: r.weight === null ? null : Number(r.weight),
    createdAt: r.created_at as string,
  };
}

export function newRunId(): string {
  const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "");
  return `run-${stamp}-${crypto.randomUUID().slice(0, 6)}`;
}

export async function createRun(
  db: Client,
  run: {
    id: string;
    name?: string;
    scenarioIds: string[];
    configIds: string[];
    attemptsPerCell: number;
    concurrency: number;
    judgeModel?: string;
    /** Effective effort per config id (see `planRunEfforts`); `{}` when no config has one. */
    efforts?: Record<string, ReasoningEffortLevel>;
    /** Hard cap on metered spend in USD; omit for no cap. */
    maxMeteredUsd?: number;
    /** Preset the run was started from (POST /api/runs `preset`); scheduled presets get a summary. */
    preset?: string;
    /** The scheduled run this run is an automatic rerun of. */
    rerunOf?: string;
  },
): Promise<void> {
  await db.execute({
    sql: `INSERT INTO eval_runs
            (id, name, scenario_ids, config_ids, attempts_per_cell, concurrency, judge_model, efforts_json, max_metered_usd, preset, rerun_of)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      run.id,
      run.name ?? null,
      JSON.stringify(run.scenarioIds),
      JSON.stringify(run.configIds),
      run.attemptsPerCell,
      run.concurrency,
      run.judgeModel ?? null,
      JSON.stringify(run.efforts ?? {}),
      run.maxMeteredUsd ?? null,
      run.preset ?? null,
      run.rerunOf ?? null,
    ],
  });
}

export async function setRunStatus(db: Client, id: string, status: RunStatus): Promise<void> {
  await db.execute({
    sql: `UPDATE eval_runs SET status = ?, finished_at = CASE WHEN ? IN ('done','failed','cancelled')
          THEN strftime('%Y-%m-%dT%H:%M:%fZ','now') ELSE finished_at END WHERE id = ?`,
    args: [status, status, id],
  });
}

export async function getRun(db: Client, id: string): Promise<EvalRunRow | null> {
  const res = await db.execute({ sql: "SELECT * FROM eval_runs WHERE id = ?", args: [id] });
  const row = res.rows[0];
  return row ? rowToRun(row) : null;
}

export async function listRuns(db: Client): Promise<EvalRunRow[]> {
  const res = await db.execute("SELECT * FROM eval_runs ORDER BY created_at DESC");
  return res.rows.map(rowToRun);
}

/**
 * The most recent finished runs of one preset that started before `beforeCreatedAt`,
 * newest first: the regression baseline's nights. Reruns (`rerun_of` set) and runs that
 * did not finish cleanly are not nights.
 */
export async function listBaselineRunIds(
  db: Client,
  opts: { preset: string; beforeCreatedAt: string; limit: number },
): Promise<string[]> {
  const res = await db.execute({
    sql: `SELECT id FROM eval_runs
          WHERE preset = ? AND rerun_of IS NULL AND status = 'done' AND created_at < ?
          ORDER BY created_at DESC LIMIT ?`,
    args: [opts.preset, opts.beforeCreatedAt, opts.limit],
  });
  return res.rows.map((r) => r.id as string);
}

/** The automatic reruns of a scheduled run, oldest first. */
export async function listRerunRuns(db: Client, parentRunId: string): Promise<EvalRunRow[]> {
  const res = await db.execute({
    sql: "SELECT * FROM eval_runs WHERE rerun_of = ? ORDER BY created_at ASC",
    args: [parentRunId],
  });
  return res.rows.map(rowToRun);
}

/** An attempt row plus the concrete model it ran on (`attempts.resolved_model`). */
export type AttemptWithModel = AttemptRow & { resolvedModel: string | null };

/** Every attempt of the given runs, oldest run first. Chunked: SQLite caps bound variables. */
export async function listAttemptsForRuns(
  db: Client,
  runIds: string[],
): Promise<AttemptWithModel[]> {
  const out: AttemptWithModel[] = [];
  for (let i = 0; i < runIds.length; i += 200) {
    const chunk = runIds.slice(i, i + 200);
    const res = await db.execute({
      sql: `SELECT a.*, r.created_at AS run_created_at FROM attempts a
            JOIN eval_runs r ON r.id = a.run_id
            WHERE a.run_id IN (${chunk.map(() => "?").join(",")})
            ORDER BY r.created_at ASC, a.attempt_index ASC`,
      args: chunk,
    });
    for (const r of res.rows) {
      out.push({ ...rowToAttempt(r), resolvedModel: (r.resolved_model as string) ?? null });
    }
  }
  return out;
}

/** Record that a run's Slack summary went out. False when it was already recorded. */
export async function markSummaryPosted(db: Client, runId: string): Promise<boolean> {
  const res = await db.execute({
    sql: `UPDATE eval_runs SET summary_posted_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
          WHERE id = ? AND summary_posted_at IS NULL`,
    args: [runId],
  });
  return res.rowsAffected > 0;
}

export async function insertAttempt(
  db: Client,
  a: {
    id: string;
    runId: string;
    scenarioId: string;
    configId: string;
    attemptIndex: number;
    /** Version of the scenario at scheduling time (see scenarios/suite.ts). */
    scenarioVersion?: number | null;
    /** Suite version when the scenario at that version is in the manifest. */
    suiteVersion?: string | null;
  },
): Promise<void> {
  await db.execute({
    sql: `INSERT OR IGNORE INTO attempts
            (id, run_id, scenario_id, config_id, attempt_index, scenario_version, suite_version)
          VALUES (?, ?, ?, ?, ?, ?, ?)`,
    args: [
      a.id,
      a.runId,
      a.scenarioId,
      a.configId,
      a.attemptIndex,
      a.scenarioVersion ?? null,
      a.suiteVersion ?? null,
    ],
  });
}

export async function updateAttempt(
  db: Client,
  id: string,
  patch: Partial<{
    status: AttemptStatus;
    exclusion: AttemptExclusion | null;
    scenarioVersion: number | null;
    suiteVersion: string | null;
    retries: number;
    sandboxId: string | null;
    apiUrl: string | null;
    taskIds: string[];
    score: number | null;
    passed: boolean | null;
    error: string | null;
    costUsd: number | null;
    costSource: CostSource | null;
    judgeCostUsd: number | null;
    /** Pre-serialized JSON strings — callers JSON.stringify, stored as-is. */
    tokensJson: string | null;
    resolvedModel: string | null;
    reasoningEffort: ReasoningEffortLevel | null;
    appliedReasoningEffort: ReasoningEffortLevel | null;
    sandboxJson: string | null;
    workersJson: string | null;
    timingsJson: string | null;
    durationMs: number | null;
    startedAt: string;
    finishedAt: string;
  }>,
): Promise<void> {
  const cols: string[] = [];
  const args: (string | number | null)[] = [];
  const map: Record<string, string> = {
    status: "status",
    exclusion: "exclusion",
    scenarioVersion: "scenario_version",
    suiteVersion: "suite_version",
    retries: "retries",
    sandboxId: "sandbox_id",
    apiUrl: "api_url",
    taskIds: "task_ids",
    score: "score",
    passed: "passed",
    error: "error",
    costUsd: "cost_usd",
    costSource: "cost_source",
    judgeCostUsd: "judge_cost_usd",
    tokensJson: "tokens_json",
    resolvedModel: "resolved_model",
    reasoningEffort: "reasoning_effort",
    appliedReasoningEffort: "applied_reasoning_effort",
    sandboxJson: "sandbox_json",
    workersJson: "workers_json",
    timingsJson: "timings_json",
    durationMs: "duration_ms",
    startedAt: "started_at",
    finishedAt: "finished_at",
  };
  for (const [key, col] of Object.entries(map)) {
    if (!(key in patch)) continue;
    const v = (patch as Record<string, unknown>)[key];
    cols.push(`${col} = ?`);
    if (key === "taskIds") args.push(JSON.stringify(v));
    else if (key === "passed") args.push(v === null ? null : v ? 1 : 0);
    else args.push(v as string | number | null);
  }
  if (cols.length === 0) return;
  args.push(id);
  await db.execute({ sql: `UPDATE attempts SET ${cols.join(", ")} WHERE id = ?`, args });
}

export async function getAttempt(db: Client, id: string): Promise<AttemptRow | null> {
  const res = await db.execute({ sql: "SELECT * FROM attempts WHERE id = ?", args: [id] });
  const row = res.rows[0];
  return row ? rowToAttempt(row) : null;
}

export async function listAttempts(db: Client, runId: string): Promise<AttemptRow[]> {
  const res = await db.execute({
    sql: "SELECT * FROM attempts WHERE run_id = ? ORDER BY scenario_id, config_id, attempt_index",
    args: [runId],
  });
  return res.rows.map(rowToAttempt);
}

/** Attempts that still need work (for resume-after-crash and retry). */
export async function listUnfinishedAttempts(db: Client, runId: string): Promise<AttemptRow[]> {
  const res = await db.execute({
    sql: `SELECT * FROM attempts WHERE run_id = ? AND status IN ('pending','running','judging')
          ORDER BY scenario_id, config_id, attempt_index`,
    args: [runId],
  });
  return res.rows.map(rowToAttempt);
}

/** Drop a prior (interrupted) execution's judgments/artifacts before re-running an attempt. */
export async function clearAttemptResults(db: Client, attemptId: string): Promise<void> {
  await db.execute({ sql: "DELETE FROM judgments WHERE attempt_id = ?", args: [attemptId] });
  await db.execute({ sql: "DELETE FROM artifacts WHERE attempt_id = ?", args: [attemptId] });
}

/** Recent attempts for one scenario across all runs (scenario detail page). */
export async function listAttemptsByScenario(
  db: Client,
  scenarioId: string,
  limit = 50,
): Promise<AttemptRow[]> {
  const res = await db.execute({
    sql: `SELECT * FROM attempts WHERE scenario_id = ? AND started_at IS NOT NULL
          ORDER BY started_at DESC LIMIT ?`,
    args: [scenarioId, limit],
  });
  return res.rows.map(rowToAttempt);
}

/**
 * Reset errored attempts to pending so `resume` retries them (e.g. after a bug fix).
 * Also clears `exclusion`: a retried attempt is a real attempt again, and cancelled
 * attempts (dead run, cost cap) come back through here too.
 */
export async function resetErrorAttempts(db: Client, runId: string): Promise<number> {
  const res = await db.execute({
    sql: `UPDATE attempts SET status = 'pending', retries = 0, error = NULL, exclusion = NULL,
          started_at = NULL, finished_at = NULL WHERE run_id = ? AND status = 'error'`,
    args: [runId],
  });
  return res.rowsAffected;
}

/**
 * Close out attempts that will never finish: `pending`/`running`/`judging` rows of a run
 * that is no longer executing. They end as `error` with `exclusion = 'cancelled'` (the
 * status CHECK cannot take a new value additively), so they no longer read as work in
 * flight and never count toward a score. `resume` resets them to `pending`.
 * `runId` omitted = every run (boot: nothing is executing in a fresh process).
 */
export async function cancelUnfinishedAttempts(
  db: Client,
  opts: { reason: string; runId?: string },
): Promise<number> {
  const res = await db.execute({
    sql: `UPDATE attempts
          SET status = 'error', exclusion = 'cancelled', error = ?,
              finished_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
          WHERE status IN ('pending','running','judging')${opts.runId ? " AND run_id = ?" : ""}`,
    args: opts.runId ? [opts.reason, opts.runId] : [opts.reason],
  });
  return res.rowsAffected;
}

export async function insertJudgment(
  db: Client,
  j: {
    id: string;
    attemptId: string;
    kind: "llm" | "deterministic";
    name: string;
    pass: boolean;
    score?: number | null;
    reasoning?: string | null;
    raw?: string | null;
    durationMs?: number | null;
    costUsd?: number | null;
    /** Pre-serialized JSON strings — callers JSON.stringify, stored as-is. */
    tokensJson?: string | null;
    stepsJson?: string | null;
    /** v8.0 OutcomeSpec v2 — NULL for gate rows (gates are not dimensions). */
    dimension?: string | null;
    weight?: number | null;
  },
): Promise<void> {
  await db.execute({
    sql: `INSERT INTO judgments (id, attempt_id, kind, name, pass, score, reasoning, raw,
          duration_ms, cost_usd, tokens_json, steps_json, dimension, weight)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      j.id,
      j.attemptId,
      j.kind,
      j.name,
      j.pass ? 1 : 0,
      j.score ?? null,
      j.reasoning ?? null,
      j.raw ?? null,
      j.durationMs ?? null,
      j.costUsd ?? null,
      j.tokensJson ?? null,
      j.stepsJson ?? null,
      j.dimension ?? null,
      j.weight ?? null,
    ],
  });
}

export async function listJudgments(db: Client, attemptId: string): Promise<JudgmentRow[]> {
  const res = await db.execute({
    sql: "SELECT * FROM judgments WHERE attempt_id = ? ORDER BY created_at",
    args: [attemptId],
  });
  return res.rows.map(rowToJudgment);
}

export async function insertArtifact(
  db: Client,
  a: { id: string; attemptId: string; kind: ArtifactRow["kind"]; name?: string; content: string },
): Promise<void> {
  await db.execute({
    sql: "INSERT INTO artifacts (id, attempt_id, kind, name, content) VALUES (?, ?, ?, ?, ?)",
    args: [a.id, a.attemptId, a.kind, a.name ?? null, a.content],
  });
}

export async function listArtifacts(
  db: Client,
  attemptId: string,
  opts: { withContent?: boolean } = {},
): Promise<(Omit<ArtifactRow, "content"> & { content?: string; size: number })[]> {
  const res = await db.execute({
    sql: `SELECT id, attempt_id, kind, name, created_at, length(content) AS size
          ${opts.withContent ? ", content" : ""} FROM artifacts WHERE attempt_id = ? ORDER BY created_at`,
    args: [attemptId],
  });
  return res.rows.map((r) => ({
    id: r.id as string,
    attemptId: r.attempt_id as string,
    kind: r.kind as ArtifactRow["kind"],
    name: (r.name as string) ?? null,
    createdAt: r.created_at as string,
    size: Number(r.size),
    ...(opts.withContent ? { content: r.content as string } : {}),
  }));
}

export async function getArtifact(db: Client, id: string): Promise<ArtifactRow | null> {
  const res = await db.execute({ sql: "SELECT * FROM artifacts WHERE id = ?", args: [id] });
  const r = res.rows[0];
  if (!r) return null;
  return {
    id: r.id as string,
    attemptId: r.attempt_id as string,
    kind: r.kind as ArtifactRow["kind"],
    name: (r.name as string) ?? null,
    content: r.content as string,
    createdAt: r.created_at as string,
  };
}
