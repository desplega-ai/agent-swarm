import type { Client, Row } from "@libsql/client";
import type {
  ArtifactRow,
  AttemptRow,
  AttemptStatus,
  EvalRunRow,
  JudgmentRow,
  RunStatus,
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
    createdAt: r.created_at as string,
    finishedAt: (r.finished_at as string) ?? null,
  };
}

function rowToAttempt(r: Row): AttemptRow {
  return {
    id: r.id as string,
    runId: r.run_id as string,
    scenarioId: r.scenario_id as string,
    configId: r.config_id as string,
    attemptIndex: Number(r.attempt_index),
    status: r.status as AttemptStatus,
    retries: Number(r.retries),
    sandboxId: (r.sandbox_id as string) ?? null,
    apiUrl: (r.api_url as string) ?? null,
    taskIds: JSON.parse((r.task_ids as string) ?? "[]"),
    score: r.score === null ? null : Number(r.score),
    passed: r.passed === null ? null : Boolean(r.passed),
    error: (r.error as string) ?? null,
    costUsd: r.cost_usd === null ? null : Number(r.cost_usd),
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
    createdAt: r.created_at as string,
  };
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
  },
): Promise<void> {
  await db.execute({
    sql: `INSERT INTO eval_runs (id, name, scenario_ids, config_ids, attempts_per_cell, concurrency)
          VALUES (?, ?, ?, ?, ?, ?)`,
    args: [
      run.id,
      run.name ?? null,
      JSON.stringify(run.scenarioIds),
      JSON.stringify(run.configIds),
      run.attemptsPerCell,
      run.concurrency,
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

export async function insertAttempt(
  db: Client,
  a: { id: string; runId: string; scenarioId: string; configId: string; attemptIndex: number },
): Promise<void> {
  await db.execute({
    sql: `INSERT OR IGNORE INTO attempts (id, run_id, scenario_id, config_id, attempt_index)
          VALUES (?, ?, ?, ?, ?)`,
    args: [a.id, a.runId, a.scenarioId, a.configId, a.attemptIndex],
  });
}

export async function updateAttempt(
  db: Client,
  id: string,
  patch: Partial<{
    status: AttemptStatus;
    retries: number;
    sandboxId: string | null;
    apiUrl: string | null;
    taskIds: string[];
    score: number | null;
    passed: boolean | null;
    error: string | null;
    costUsd: number | null;
    durationMs: number | null;
    startedAt: string;
    finishedAt: string;
  }>,
): Promise<void> {
  const cols: string[] = [];
  const args: (string | number | null)[] = [];
  const map: Record<string, string> = {
    status: "status",
    retries: "retries",
    sandboxId: "sandbox_id",
    apiUrl: "api_url",
    taskIds: "task_ids",
    score: "score",
    passed: "passed",
    error: "error",
    costUsd: "cost_usd",
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

/** Reset errored attempts to pending so `resume` retries them (e.g. after a bug fix). */
export async function resetErrorAttempts(db: Client, runId: string): Promise<number> {
  const res = await db.execute({
    sql: `UPDATE attempts SET status = 'pending', retries = 0, error = NULL,
          started_at = NULL, finished_at = NULL WHERE run_id = ? AND status = 'error'`,
    args: [runId],
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
  },
): Promise<void> {
  await db.execute({
    sql: `INSERT INTO judgments (id, attempt_id, kind, name, pass, score, reasoning, raw)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      j.id,
      j.attemptId,
      j.kind,
      j.name,
      j.pass ? 1 : 0,
      j.score ?? null,
      j.reasoning ?? null,
      j.raw ?? null,
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
