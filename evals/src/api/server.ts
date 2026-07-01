import { join, normalize, sep } from "node:path";
import { DEFAULT_CONFIG_IDS } from "../../configs/index.ts";
import { CONFIG_PRESETS } from "../../configs/presets.ts";
import { getClaudeAliasMap, listOpenrouterModels } from "../cost/pricing.ts";
import { getDb, initDb } from "../db/client.ts";
import {
  createRun,
  getArtifact,
  getAttempt,
  getRun,
  listArtifacts,
  listAttempts,
  listAttemptsByScenario,
  listJudgments,
  listRuns,
  newRunId,
  resetErrorAttempts,
} from "../db/queries.ts";
import { getJudgeLive } from "../judge/live-registry.ts";
import { getAttemptProgress } from "../live/attempt-progress.ts";
import { loadRegistry, serializeConfig, serializeScenario } from "../registry.ts";
import { summarizeRun } from "../results.ts";
import {
  executeRun,
  forceCancelInactiveRun,
  killAllActiveStacks,
  killRunStacks,
  reconcileOrphanedRuns,
} from "../runner/index.ts";
import { type SessionLogRow, SwarmClient } from "../swarm/client.ts";
import { cleanVersion } from "../swarm/version.ts";
import {
  type AnalyticsFilter,
  type AttemptRow,
  type AttemptTaskRecord,
  type AttemptTasksSnapshot,
  aggregateCostRows,
  CASCADE_SKIP_RE,
  type CostRowTotals,
  type RunVersions,
  type SandboxInfo,
} from "../types.ts";
import { type AnalyticsSourceRow, buildAnalytics } from "./analytics.ts";

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const UI_DIST = join(import.meta.dir, "../../ui/dist");

const DEFAULT_JUDGE_MODEL = "deepseek/deepseek-v4-pro";
const encoder = new TextEncoder();
let warnedOpenApi = false;

/** One JSONL line of a raw-session-logs artifact. Old artifacts lack id/createdAt. */
interface RawSessionLogLine {
  id?: string;
  taskId?: string;
  sessionId?: string;
  iteration?: number;
  cli?: string;
  content?: string;
  lineNumber?: number;
  createdAt?: string;
}

/** Attempt statuses for which a live sandbox may still be producing logs. */
const LIVE_ATTEMPT_STATUSES = new Set(["pending", "running", "judging"]);
const TERMINAL_RUN_STATUSES = new Set(["done", "failed", "cancelled"]);

const LIVE_FETCH_TIMEOUT_MS = 8_000;

/** Reject after `ms` so a dead sandbox can never stall the transcript endpoint. */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  const signal = AbortSignal.timeout(ms);
  return new Promise<T>((resolve, reject) => {
    signal.addEventListener(
      "abort",
      () => reject(new Error(`live transcript fetch timed out after ${ms}ms`)),
      { once: true },
    );
    promise.then(resolve, reject);
  });
}

/**
 * Fetch fresh session-log rows straight from a still-running attempt's sandbox.
 * Uses the attempt's stored task ids when present; otherwise lists the sandbox's
 * tasks (every task in a throwaway eval sandbox belongs to this attempt).
 * Single-shot reads — the UI polls this endpoint, so no stability polling here.
 */
async function fetchLiveTranscriptRows(
  sandbox: SandboxInfo,
  taskIds: string[],
): Promise<SessionLogRow[]> {
  const client = new SwarmClient(sandbox.apiUrl, sandbox.swarmKey);
  let ids = taskIds;
  if (ids.length === 0) {
    const res = await client.get<{ tasks?: { id?: unknown }[] } | { id?: unknown }[]>("/api/tasks");
    const tasks = Array.isArray(res) ? res : (res.tasks ?? []);
    ids = tasks
      .map((t) => t?.id)
      .filter((id): id is string => typeof id === "string" && id.length > 0);
  }
  const rows: SessionLogRow[] = [];
  for (const taskId of ids) {
    rows.push(...(await client.getSessionLogs(taskId)));
  }
  return rows;
}

// ---- per-task records (v7.5 items 2/5/6 — frozen contract) ----

/** Frozen server-side clip for per-task outcome/error text (v7.5 item 2). */
const TASK_TEXT_CLIP_CHARS = 4000;

/** Non-empty string clipped to TASK_TEXT_CLIP_CHARS; null otherwise. */
function clipTaskText(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0) return null;
  return value.length > TASK_TEXT_CLIP_CHARS ? value.slice(0, TASK_TEXT_CLIP_CHARS) : value;
}

/** All-null record for a task id nothing else is known about (v1-era rows). */
function emptyTaskRecord(id: string): AttemptTaskRecord {
  return {
    id,
    title: null,
    status: null,
    outcome: null,
    error: null,
    skipped: false,
    dependsOn: [],
    agentId: null,
    // task-ids source = attempt.taskIds only (the run's upfront tasks) → always run.
    origin: "run",
    costUsd: null,
    tokens: null,
    createdAt: null,
    finishedAt: null,
    durationMs: null,
  };
}

/** Raw task-record timestamp: passed through verbatim (never reformatted); null when absent. */
function taskTimestamp(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * Frozen item-7 duration rule (v7.7): `Date.parse(finishedAt) -
 * Date.parse(createdAt)`, null unless BOTH parse to finite numbers and the
 * difference is >= 0.
 */
function taskDurationMs(createdAt: string | null, finishedAt: string | null): number | null {
  if (createdAt === null || finishedAt === null) return null;
  const start = Date.parse(createdAt);
  const end = Date.parse(finishedAt);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  const diff = end - start;
  return diff >= 0 ? diff : null;
}

/**
 * Normalize one swarm task record — a stored tasks.json entry or a live
 * GET /api/tasks/:id payload — into the frozen AttemptTaskRecord shape (v7.5
 * items 2/5/6). title = non-empty entry.title; outcome = first non-empty of
 * entry.result / entry.output (clipped); error = entry.failureReason (clipped);
 * `skipped` keeps the runner-set flag when present and otherwise re-derives the
 * R6 cascade-skip classification (CASCADE_SKIP_RE on failureReason). Every
 * field degrades to null/[]/false; costUsd/tokens start null and are joined by
 * the caller (never on the live source). v7.7 item 7 (frozen): the task's own
 * `createdAt`/`finishedAt` timestamps pass through verbatim (present on both
 * stored tasks.json entries and live GET /api/tasks/:id payloads) with the
 * server-computed durationMs — see taskDurationMs above for the null rules.
 */
function normalizeAttemptTask(entry: Record<string, unknown>, id: string): AttemptTaskRecord {
  const status = typeof entry.status === "string" && entry.status.length > 0 ? entry.status : null;
  const failureReason = typeof entry.failureReason === "string" ? entry.failureReason : "";
  const agentId =
    (typeof entry.agentId === "string" && entry.agentId.length > 0 ? entry.agentId : null) ??
    (typeof entry.assignedAgentId === "string" && entry.assignedAgentId.length > 0
      ? entry.assignedAgentId
      : null);
  const createdAt = taskTimestamp(entry.createdAt);
  const finishedAt = taskTimestamp(entry.finishedAt);
  return {
    id,
    title: clipTaskText(entry.title),
    status,
    outcome: clipTaskText(entry.result) ?? clipTaskText(entry.output),
    error: clipTaskText(entry.failureReason),
    skipped:
      entry.skipped === true ||
      (entry.skipped === undefined && status === "failed" && CASCADE_SKIP_RE.test(failureReason)),
    dependsOn: Array.isArray(entry.dependsOn)
      ? entry.dependsOn.filter((d): d is string => typeof d === "string")
      : [],
    agentId,
    // Display-only run-vs-seed tag (runner-set on the tasks.json artifact). Absent
    // on pre-tag artifacts AND on the live GET /api/tasks/:id payload → "run", so the
    // panel shows every record by default exactly as before this field existed.
    origin: entry.origin === "seed" ? "seed" : "run",
    costUsd: null,
    tokens: null,
    createdAt,
    finishedAt,
    durationMs: taskDurationMs(createdAt, finishedAt),
  };
}

/** Defensive read of one stored session-cost row into the aggregation subset. */
function costRowTotals(raw: Record<string, unknown>): CostRowTotals {
  return {
    totalCostUsd: numOrNull(raw.totalCostUsd),
    inputTokens: numOrNull(raw.inputTokens),
    outputTokens: numOrNull(raw.outputTokens),
    cacheReadTokens: numOrNull(raw.cacheReadTokens),
    cacheWriteTokens: numOrNull(raw.cacheWriteTokens),
    model: typeof raw.model === "string" && raw.model.length > 0 ? raw.model : null,
  };
}

/**
 * Parse the session-costs.json meta artifact (`[{ taskId, rows }]` — the cost
 * phase's snapshot) into taskId → rows. Missing/malformed artifact → empty
 * map: per-task cost degrades to null exactly like v1-era attempts.
 */
function parseSessionCostsByTask(content: string | null): Map<string, CostRowTotals[]> {
  const byTask = new Map<string, CostRowTotals[]>();
  if (!content) return byTask;
  try {
    const parsed: unknown = JSON.parse(content);
    if (!Array.isArray(parsed)) return byTask;
    for (const item of parsed) {
      if (item === null || typeof item !== "object") continue;
      const { taskId, rows } = item as { taskId?: unknown; rows?: unknown };
      if (typeof taskId !== "string" || taskId.length === 0 || !Array.isArray(rows)) continue;
      byTask.set(
        taskId,
        rows
          .filter((r): r is Record<string, unknown> => r !== null && typeof r === "object")
          .map(costRowTotals),
      );
    }
  } catch {
    // malformed artifact — cost columns degrade to null
  }
  return byTask;
}

/**
 * Assemble the stored-artifact response of GET /api/attempts/:id/tasks (v7.5
 * items 2/5/6 — FROZEN precedence after the live source):
 *   tasks.json present → "tasks-artifact": normalized entries joined with
 *                        session-costs.json per-task cost (aggregateCostRows —
 *                        the round-7 per-member rule keyed by single taskId);
 *   taskIds non-empty  → "task-ids": one all-null record per id;
 *   else               → { source: null, live: false, tasks: [] }.
 * Ordering: attempt.taskIds creation order first, artifact-only extras
 * appended in artifact order. Malformed tasks.json degrades to "task-ids";
 * Σ per-task cost may be < attempt costUsd on recompute-priced attempts —
 * allowed (per-task cost is harness-reported, like roster member cost).
 */
export function buildAttemptTaskRecords(opts: {
  taskIds: string[];
  /** Content of the tasks.json artifact (kind "task"); null when absent. */
  tasksArtifact: string | null;
  /** Content of the session-costs.json meta artifact; null when absent. */
  costsArtifact: string | null;
}): AttemptTasksSnapshot {
  let entries: { id: string; entry: Record<string, unknown> }[] | null = null;
  if (opts.tasksArtifact !== null) {
    try {
      const parsed: unknown = JSON.parse(opts.tasksArtifact);
      if (Array.isArray(parsed)) {
        entries = parsed
          .filter((e): e is Record<string, unknown> => e !== null && typeof e === "object")
          .filter((e) => typeof e.id === "string" && e.id.length > 0)
          .map((e) => ({ id: e.id as string, entry: e }));
      }
    } catch {
      // malformed tasks.json — degrade to the task-ids source below
    }
  }
  if (entries === null) {
    if (opts.taskIds.length === 0) return { source: null, live: false, tasks: [] };
    return { source: "task-ids", live: false, tasks: opts.taskIds.map(emptyTaskRecord) };
  }
  const byId = new Map(entries.map((e) => [e.id, e.entry]));
  const seen = new Set<string>();
  const records: AttemptTaskRecord[] = [];
  for (const id of opts.taskIds) {
    if (seen.has(id)) continue;
    seen.add(id);
    const entry = byId.get(id);
    records.push(entry ? normalizeAttemptTask(entry, id) : emptyTaskRecord(id));
  }
  for (const { id, entry } of entries) {
    if (seen.has(id)) continue;
    seen.add(id);
    records.push(normalizeAttemptTask(entry, id));
  }
  const costsByTask = parseSessionCostsByTask(opts.costsArtifact);
  for (const record of records) {
    const rows = costsByTask.get(record.id);
    if (!rows || rows.length === 0) continue;
    const { costUsd, tokens } = aggregateCostRows(rows);
    record.costUsd = costUsd;
    record.tokens = tokens;
  }
  return { source: "tasks-artifact", live: false, tasks: records };
}

/**
 * Fresh per-task records straight from a still-running attempt's stack
 * (?live=1 — v7.5 frozen): one GET /api/tasks/:id per attempt.taskIds entry.
 * costUsd/tokens are ALWAYS null on this source; any failure makes the route
 * fall through to the stored artifacts (same philosophy as the live
 * transcript). Single-shot reads — the UI polls this endpoint.
 */
export async function fetchLiveTaskRecords(
  sandbox: SandboxInfo,
  taskIds: string[],
): Promise<AttemptTaskRecord[]> {
  const client = new SwarmClient(sandbox.apiUrl, sandbox.swarmKey);
  const records: AttemptTaskRecord[] = [];
  for (const id of taskIds) {
    records.push(normalizeAttemptTask(await client.getTask(id), id));
  }
  return records;
}

/**
 * Distinct cleaned sandbox versions across a run's attempts (v5 spec §1.5),
 * first-seen order. Historical rows store ANSI-dirty values — cleanVersion()
 * re-cleans on read. Empty arrays when nothing was captured.
 */
function computeRunVersions(attempts: AttemptRow[]): RunVersions {
  const api: string[] = [];
  const worker: string[] = [];
  for (const attempt of attempts) {
    const apiVersion = cleanVersion(attempt.sandbox?.apiVersion);
    if (apiVersion !== null && !api.includes(apiVersion)) api.push(apiVersion);
    // Legacy v1 blobs store a flat `workerVersion`; sandboxJson v2 stores
    // per-worker `workers[].version` (cast keeps both readable — old DB rows
    // are v1, the SandboxInfo type is v2-only).
    const raw = attempt.sandbox as {
      workerVersion?: string | null;
      workers?: { version?: string | null }[];
    } | null;
    const workerVersions = Array.isArray(raw?.workers)
      ? raw.workers.map((w) => w?.version)
      : [raw?.workerVersion];
    for (const value of workerVersions) {
      const workerVersion = cleanVersion(value);
      if (workerVersion !== null && !worker.includes(workerVersion)) worker.push(workerVersion);
    }
  }
  return { api, worker };
}

/**
 * Analytics source query (v5 spec §1.1 + v7 §6.1 token columns). json_valid
 * guards keep malformed/empty JSON columns from failing the whole aggregation —
 * they degrade to NULL like every other missing field on old rows.
 *
 * worker_version reads BOTH sandboxJson shapes (v6 spec §0.3): legacy v1 blobs
 * store a flat `workerVersion`; v2 blobs store per-worker `workers[].version`
 * (worker 0 is representative — workers are homogeneous within an attempt).
 * Mirrors computeRunVersions() above.
 */
export const ANALYTICS_SQL = `
  SELECT a.run_id, a.scenario_id, a.config_id, a.status, a.score, a.cost_usd, a.cost_source,
         a.judge_cost_usd, a.duration_ms,
         CASE WHEN json_valid(a.tokens_json)
              THEN json_extract(a.tokens_json, '$.model') END        AS token_model,
         CASE WHEN json_valid(a.tokens_json)
              THEN json_extract(a.tokens_json, '$.inputTokens') END  AS token_input,
         CASE WHEN json_valid(a.tokens_json)
              THEN json_extract(a.tokens_json, '$.outputTokens') END AS token_output,
         CASE WHEN json_valid(a.tokens_json)
              THEN json_extract(a.tokens_json, '$.cacheReadTokens') END  AS token_cache_read,
         CASE WHEN json_valid(a.tokens_json)
              THEN json_extract(a.tokens_json, '$.cacheWriteTokens') END AS token_cache_write,
         CASE WHEN json_valid(a.sandbox_json)
              THEN json_extract(a.sandbox_json, '$.apiVersion') END  AS api_version,
         CASE WHEN json_valid(a.sandbox_json)
              THEN COALESCE(
                json_extract(a.sandbox_json, '$.workerVersion'),
                json_extract(a.sandbox_json, '$.workers[0].version')
              ) END AS worker_version,
         r.name AS run_name, r.created_at AS run_created_at
  FROM attempts a JOIN eval_runs r ON r.id = a.run_id
  ORDER BY r.created_at ASC, a.attempt_index ASC`;

/** Defensive numeric read off a SQL/JSON value — null instead of NaN, always. */
function numOrNull(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * CSV filter query param (v7.6 §C3 — frozen wire rule): split on ",", trim,
 * drop empties, dedupe. Absent param → [] (no filter on that axis).
 */
export function parseFilterCsv(value: string | null): string[] {
  if (value === null) return [];
  const out: string[] = [];
  for (const part of value.split(",")) {
    const trimmed = part.trim();
    if (trimmed.length > 0 && !out.includes(trimmed)) out.push(trimmed);
  }
  return out;
}

/**
 * Attempt rows embedded in API responses always carry `workers` (v7 §10.2):
 * the per-member roster snapshot when captured, explicit null on pre-v7 rows
 * (the UI then falls back to the sandboxJson worker entries).
 */
function serializeAttempt(attempt: AttemptRow): AttemptRow {
  return { ...attempt, workers: attempt.workers ?? null };
}

/** Runs currently executing inside this server process (local-first trigger). */
const activeRuns = new Map<string, AbortController>();

export function resetActiveRunsForTests(): void {
  for (const controller of activeRuns.values()) controller.abort();
  activeRuns.clear();
}

export function addActiveRunForTests(runId: string): void {
  activeRuns.set(runId, new AbortController());
}

export function getMaxConcurrentRuns(): number {
  const raw = process.env.EVALS_MAX_CONCURRENT_RUNS;
  if (raw === undefined || raw.trim() === "") return 1;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : 1;
}

function concurrentRunsResponse(): Response | null {
  const max = getMaxConcurrentRuns();
  if (activeRuns.size < max) return null;
  return json(
    {
      error: `max concurrent eval runs reached (${activeRuns.size}/${max}); wait for an active run to finish or raise EVALS_MAX_CONCURRENT_RUNS`,
      activeRuns: activeRuns.size,
      maxConcurrentRuns: max,
    },
    429,
  );
}

function startRunExecution(db: ReturnType<typeof getDb>, runId: string): boolean {
  if (activeRuns.has(runId)) return false;
  const controller = new AbortController();
  activeRuns.set(runId, controller);
  executeRun({
    db,
    runId,
    registry: loadRegistry(),
    signal: controller.signal,
    log: (msg) => console.log(`[${runId}] ${msg}`),
  })
    .catch((err) => console.error(`[${runId}] execution crashed:`, err))
    .finally(() => activeRuns.delete(runId));
  return true;
}

async function sha256(value: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value)));
}

async function constantTimeEqual(a: string, b: string): Promise<boolean> {
  const [left, right] = await Promise.all([sha256(a), sha256(b)]);
  let diff = 0;
  for (let i = 0; i < left.length; i++) diff |= (left[i] ?? 0) ^ (right[i] ?? 0);
  return diff === 0;
}

async function isAuthorized(req: Request): Promise<boolean> {
  const key = process.env.EVALS_API_KEY;
  if (!key) return true;
  const header = req.headers.get("authorization") ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(header);
  if (!match) return false;
  return constantTimeEqual(match[1] ?? "", key);
}

function unauthorized(): Response {
  return json({ error: "missing or invalid EVALS_API_KEY bearer token" }, 401);
}

function warnIfApiOpen(): void {
  if (process.env.EVALS_API_KEY || warnedOpenApi) return;
  warnedOpenApi = true;
  console.warn("WARNING: EVALS_API_KEY is unset; /api/* is open. Set it before deployment.");
}

export async function startServer(
  port = Number(process.env.EVALS_PORT ?? 4801),
  opts: {
    reconcileOrphanedRuns?: typeof reconcileOrphanedRuns;
    forceCancelInactiveRun?: typeof forceCancelInactiveRun;
  } = {},
) {
  await initDb();
  const db = getDb();
  const reconcile = opts.reconcileOrphanedRuns ?? reconcileOrphanedRuns;
  const forceCancel = opts.forceCancelInactiveRun ?? forceCancelInactiveRun;
  const reconciled = await reconcile(db, (msg) => console.log(`[orphan-reconcile] ${msg}`));
  if (reconciled > 0) {
    console.log(`[orphan-reconcile] reconciled ${reconciled} orphaned run(s)`);
  }
  warnIfApiOpen();

  const server = Bun.serve({
    port,
    idleTimeout: 60,
    routes: {
      "/": async () => {
        const index = Bun.file(join(UI_DIST, "index.html"));
        if (!(await index.exists())) {
          return json({ error: "UI not built — run `bun run ui:build` in evals/" }, 500);
        }
        return new Response(index);
      },
      "/health": () => json({ ok: true }),
      "/api/runs": {
        GET: async (req) => {
          if (!(await isAuthorized(req))) return unauthorized();
          const runs = await listRuns(db);
          const withSummaries = await Promise.all(
            runs.map(async (run) => {
              const attempts = await listAttempts(db, run.id);
              return {
                ...summarizeRun(run, attempts),
                versions: computeRunVersions(attempts),
                active: activeRuns.has(run.id),
              };
            }),
          );
          return json(withSummaries);
        },
        POST: async (req) => {
          if (!(await isAuthorized(req))) return unauthorized();
          const capped = concurrentRunsResponse();
          if (capped) return capped;
          const body = (await req.json().catch(() => null)) as {
            name?: string;
            scenarioIds?: string[];
            configIds?: string[];
            attemptsPerCell?: number;
            concurrency?: number;
            judgeModel?: string;
          } | null;
          if (!body?.scenarioIds?.length || !body?.configIds?.length) {
            return json({ error: "scenarioIds and configIds are required" }, 400);
          }
          const registry = loadRegistry();
          for (const id of body.scenarioIds) {
            if (!registry.scenarios.has(id))
              return json({ error: `unknown scenario "${id}"` }, 400);
          }
          for (const id of body.configIds) {
            if (!registry.configs.has(id)) return json({ error: `unknown config "${id}"` }, 400);
          }
          const runId = newRunId();
          await createRun(db, {
            id: runId,
            name: body.name,
            scenarioIds: body.scenarioIds,
            configIds: body.configIds,
            attemptsPerCell: Math.max(1, body.attemptsPerCell ?? 1),
            concurrency: Math.max(1, body.concurrency ?? 2),
            judgeModel: body.judgeModel || undefined,
          });
          startRunExecution(db, runId);
          return json({ runId }, 201);
        },
      },
      "/api/runs/:id": async (req) => {
        if (!(await isAuthorized(req))) return unauthorized();
        const run = await getRun(db, req.params.id);
        if (!run) return json({ error: "run not found" }, 404);
        const attempts = await listAttempts(db, run.id);
        return json({
          ...summarizeRun(run, attempts),
          versions: computeRunVersions(attempts),
          attempts: attempts.map(serializeAttempt),
          active: activeRuns.has(run.id),
        });
      },
      "/api/runs/:id/resume": {
        POST: async (req) => {
          if (!(await isAuthorized(req))) return unauthorized();
          const run = await getRun(db, req.params.id);
          if (!run) return json({ error: "run not found" }, 404);
          if (activeRuns.has(run.id)) return json({ error: "run is already executing" }, 409);
          const capped = concurrentRunsResponse();
          if (capped) return capped;
          await resetErrorAttempts(db, run.id);
          startRunExecution(db, run.id);
          return json({ runId: run.id, resumed: true }, 202);
        },
      },
      "/api/runs/:id/cancel": {
        POST: async (req) => {
          if (!(await isAuthorized(req))) return unauthorized();
          const run = await getRun(db, req.params.id);
          if (!run) return json({ error: "run not found" }, 404);
          const controller = activeRuns.get(run.id);
          if (!controller) {
            if (TERMINAL_RUN_STATUSES.has(run.status)) {
              return json({ error: `run is already ${run.status}` }, 409);
            }
            const swept = await forceCancel(db, run.id, (msg) => console.log(`[${run.id}] ${msg}`));
            return json({ runId: run.id, cancelled: true, forced: true, swept }, 202);
          }
          controller.abort();
          await killRunStacks(run.id);
          return json({ runId: run.id, cancelled: true }, 202);
        },
      },
      "/api/attempts/:id": async (req) => {
        if (!(await isAuthorized(req))) return unauthorized();
        const attempt = await getAttempt(db, req.params.id);
        if (!attempt) return json({ error: "attempt not found" }, 404);
        const [judgments, artifacts] = await Promise.all([
          listJudgments(db, attempt.id),
          listArtifacts(db, attempt.id),
        ]);
        return json({ attempt: serializeAttempt(attempt), judgments, artifacts });
      },
      /**
       * Live judge-trace stream (v3 spec §4 — frozen contract). Registry-only,
       * in-process read: ALWAYS 200, no DB lookup. Unknown attempt, finished
       * attempt, cleared entry, restarted server → { judging: false, traces: [] }.
       * Only meaningful while attempt.status === "judging"; finished attempts
       * use the persisted judgments instead.
       */
      "/api/attempts/:id/judge-live": async (req) => {
        if (!(await isAuthorized(req))) return unauthorized();
        return json(getJudgeLive(req.params.id));
      },
      /**
       * Live runner progress (v4 spec §3 — frozen contract). Registry-only,
       * in-process read: ALWAYS 200, no DB lookup — same philosophy as
       * judge-live. Unknown attempt, finished attempt, restarted server →
       * { active: false, startedAt: null, currentPhase: null,
       *   currentPhaseStartedAt: null, phases: {}, log: [] }.
       */
      "/api/attempts/:id/progress": async (req) => {
        if (!(await isAuthorized(req))) return unauthorized();
        return json(getAttemptProgress(req.params.id));
      },
      "/api/attempts/:id/transcript": async (req) => {
        if (!(await isAuthorized(req))) return unauthorized();
        const attempt = await getAttempt(db, req.params.id);
        if (!attempt) return json({ error: "attempt not found" }, 404);
        const harness = loadRegistry().configs.get(attempt.configId)?.provider ?? null;
        const wantLive = new URL(req.url).searchParams.get("live") === "1";
        if (wantLive && LIVE_ATTEMPT_STATUSES.has(attempt.status) && attempt.sandbox) {
          try {
            const rows = await withTimeout(
              fetchLiveTranscriptRows(attempt.sandbox, attempt.taskIds),
              LIVE_FETCH_TIMEOUT_MS,
            );
            return json({ source: "raw-session-logs", harness, rows, text: null, live: true });
          } catch {
            // sandbox dead, unreachable, or slow — fall through to the stored artifacts
          }
        }
        const artifacts = await listArtifacts(db, attempt.id, { withContent: true });
        const raw = artifacts.find((a) => a.kind === "raw-session-logs");
        if (raw?.content) {
          const rows = raw.content
            .split("\n")
            .filter(Boolean)
            .map((line, index) => {
              try {
                const r = JSON.parse(line) as RawSessionLogLine;
                const iteration = r.iteration ?? 0;
                const lineNumber = r.lineNumber ?? 0;
                return {
                  // old artifacts lack id/createdAt — synthesize id, leave createdAt empty
                  id: r.id ?? `${iteration}:${lineNumber}`,
                  taskId: r.taskId ?? "",
                  sessionId: r.sessionId ?? "",
                  iteration,
                  cli: r.cli ?? "",
                  content: r.content ?? "",
                  lineNumber,
                  createdAt: r.createdAt ?? "",
                };
              } catch {
                // never drop rows — surface unparseable lines as raw content (item 15)
                return {
                  id: `raw:${index}`,
                  taskId: "",
                  sessionId: "",
                  iteration: 0,
                  cli: "",
                  content: line,
                  lineNumber: index,
                  createdAt: "",
                };
              }
            });
          return json({ source: "raw-session-logs", harness, rows, text: null, live: false });
        }
        const flat = artifacts.find((a) => a.kind === "transcript");
        if (flat?.content) {
          return json({
            source: "transcript",
            harness,
            rows: null,
            text: flat.content,
            live: false,
          });
        }
        return json({ source: null, harness, rows: null, text: null, live: false });
      },
      /**
       * Per-task records (v7.5 items 2/5/6 — frozen contract). 404 only for an
       * unknown attempt (matches /transcript). ?live=1 on a still-live attempt
       * reads the stack directly (costUsd/tokens null on that source); any live
       * failure falls through to the stored tasks.json + session-costs.json
       * artifacts. v1-era attempts (no artifacts) degrade to the "task-ids" /
       * null sources with all-null fields — nothing in the DB is rewritten.
       */
      "/api/attempts/:id/tasks": async (req) => {
        if (!(await isAuthorized(req))) return unauthorized();
        const attempt = await getAttempt(db, req.params.id);
        if (!attempt) return json({ error: "attempt not found" }, 404);
        const wantLive = new URL(req.url).searchParams.get("live") === "1";
        if (wantLive && LIVE_ATTEMPT_STATUSES.has(attempt.status) && attempt.sandbox) {
          try {
            const tasks = await withTimeout(
              fetchLiveTaskRecords(attempt.sandbox, attempt.taskIds),
              LIVE_FETCH_TIMEOUT_MS,
            );
            return json({ source: "live", live: true, tasks } satisfies AttemptTasksSnapshot);
          } catch {
            // sandbox dead, unreachable, or slow — fall through to the stored artifacts
          }
        }
        const artifacts = await listArtifacts(db, attempt.id, { withContent: true });
        const tasksArtifact =
          artifacts.find((a) => a.kind === "task" && a.name === "tasks.json") ??
          artifacts.find((a) => a.kind === "task");
        const costsArtifact = artifacts.find(
          (a) => a.kind === "meta" && a.name === "session-costs.json",
        );
        return json(
          buildAttemptTaskRecords({
            taskIds: attempt.taskIds,
            tasksArtifact: tasksArtifact?.content ?? null,
            costsArtifact: costsArtifact?.content ?? null,
          }),
        );
      },
      "/api/scenarios": async (req) => {
        if (!(await isAuthorized(req))) return unauthorized();
        const registry = loadRegistry();
        return json([...registry.scenarios.values()].map(serializeScenario));
      },
      /**
       * Scenario detail (v7 §5.2 — frozen): unknown ids return 200 with
       * `scenario: null` + the bare id, so historical runs referencing removed
       * scenarios keep a working detail page (recentAttempts is queried by the
       * stored id — registry-independent). Known ids keep the legacy shape.
       */
      "/api/scenarios/:id": async (req) => {
        if (!(await isAuthorized(req))) return unauthorized();
        const registry = loadRegistry();
        const scenario = registry.scenarios.get(req.params.id);
        const recent = await listAttemptsByScenario(db, req.params.id);
        const recentAttempts = recent.map(serializeAttempt);
        if (!scenario) {
          return json({ scenario: null, scenarioId: req.params.id, recentAttempts });
        }
        return json({ scenario: serializeScenario(scenario), recentAttempts });
      },
      "/api/configs": async (req) => {
        if (!(await isAuthorized(req))) return unauthorized();
        const registry = loadRegistry();
        return json(
          [...registry.configs.values()].map((c) => ({
            ...serializeConfig(c),
            isDefault: DEFAULT_CONFIG_IDS.includes(c.id),
          })),
        );
      },
      /** Quick-run config presets (v7.7 item 1) — static catalog data, validated by registry.test.ts. */
      "/api/presets": async (req) => {
        if (!(await isAuthorized(req))) return unauthorized();
        return json(CONFIG_PRESETS);
      },
      "/api/models": async (req) => {
        if (!(await isAuthorized(req))) return unauthorized();
        const models = await listOpenrouterModels();
        // v7 §8: frozen claude alias map (fable → claude-fable-5, …) so the UI
        // resolves bare aliases stored on historical rows at display time.
        const aliases = await getClaudeAliasMap();
        return json({ defaultJudgeModel: DEFAULT_JUDGE_MODEL, models, aliases });
      },
      /**
       * Pre-aggregated analytics (v5 spec §1 — frozen contract). One SQL pass
       * over attempts × eval_runs, shaped by the pure buildAnalytics().
       *
       * v7.6 §C3 (frozen wire contract): optional `harnesses` and `configs`
       * query params (CSV — split on ",", trim, drop empties, dedupe) narrow
       * the source rows BEFORE aggregation, so every section re-aggregates
       * over the filtered rows. Unknown values match nothing (empty
       * aggregates, no error); no params → the unfiltered v5 behavior.
       */
      "/api/analytics": async (req) => {
        if (!(await isAuthorized(req))) return unauthorized();
        const params = new URL(req.url).searchParams;
        const filter: AnalyticsFilter = {
          harnesses: parseFilterCsv(params.get("harnesses")),
          configIds: parseFilterCsv(params.get("configs")),
        };
        const res = await db.execute(ANALYTICS_SQL);
        const rows: AnalyticsSourceRow[] = res.rows.map((r) => ({
          runId: r.run_id as string,
          scenarioId: r.scenario_id as string,
          configId: r.config_id as string,
          status: r.status as string,
          score: r.score === null ? null : Number(r.score),
          costUsd: r.cost_usd === null ? null : Number(r.cost_usd),
          costSource: (r.cost_source as string) ?? null,
          judgeCostUsd: r.judge_cost_usd === null ? null : Number(r.judge_cost_usd),
          durationMs: r.duration_ms === null ? null : Number(r.duration_ms),
          tokenModel: (r.token_model as string) ?? null,
          // v7 §6.1: token sums; numOrNull guards stored-JSON garbage (no NaN).
          tokenInput: numOrNull(r.token_input),
          tokenOutput: numOrNull(r.token_output),
          tokenCacheRead: numOrNull(r.token_cache_read),
          tokenCacheWrite: numOrNull(r.token_cache_write),
          apiVersion: (r.api_version as string) ?? null,
          workerVersion: (r.worker_version as string) ?? null,
          runName: (r.run_name as string) ?? null,
          runCreatedAt: r.run_created_at as string,
        }));
        // v7 §7.1/§8: historical bare-alias model keys group under the latest
        // concrete family id — same map the UI receives on /api/models.
        return json(buildAnalytics(rows, loadRegistry(), await getClaudeAliasMap(), filter));
      },
      "/api/artifacts/:id": async (req) => {
        if (!(await isAuthorized(req))) return unauthorized();
        const artifact = await getArtifact(db, req.params.id);
        if (!artifact) return json({ error: "artifact not found" }, 404);
        const name = artifact.name ?? artifact.id;
        const headers: Record<string, string> = {
          "content-type": name.endsWith(".json")
            ? "application/json; charset=utf-8"
            : "text/plain; charset=utf-8",
        };
        if (new URL(req.url).searchParams.get("download") === "1") {
          headers["content-disposition"] = `attachment; filename="${name.replace(/"/g, "")}"`;
        }
        return new Response(artifact.content, { headers });
      },
    },
    async fetch(req) {
      const url = new URL(req.url);
      if (req.method === "GET" && !url.pathname.startsWith("/api/")) {
        let pathname: string;
        try {
          pathname = decodeURIComponent(url.pathname);
        } catch {
          return json({ error: "not found" }, 404);
        }
        const resolved = normalize(join(UI_DIST, pathname));
        // traversal guard: only serve paths inside the built UI dist
        if (resolved === UI_DIST || resolved.startsWith(UI_DIST + sep)) {
          const file = Bun.file(resolved);
          if (await file.exists()) return new Response(file);
        }
      }
      if (url.pathname.startsWith("/api/") && !(await isAuthorized(req))) return unauthorized();
      return json({ error: "not found" }, 404);
    },
  });

  const shutdown = () => {
    console.log("\nshutting down — aborting active runs and tearing down live sandboxes…");
    for (const controller of activeRuns.values()) controller.abort();
    void killAllActiveStacks()
      .then(() => Bun.sleep(500))
      .finally(() => process.exit(130));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  console.log(`evals UI on http://localhost:${server.port}`);
  return server;
}

if (import.meta.main) {
  await startServer();
}
