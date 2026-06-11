import { join, normalize, sep } from "node:path";
import { DEFAULT_CONFIG_IDS } from "../../configs/index.ts";
import { listOpenrouterModels } from "../cost/pricing.ts";
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
import { executeRun, killAllActiveStacks, killRunStacks } from "../runner/index.ts";
import { type SessionLogRow, SwarmClient } from "../swarm/client.ts";
import type { SandboxInfo } from "../types.ts";

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "content-type": "application/json", "access-control-allow-origin": "*" },
  });
}

const UI_DIST = join(import.meta.dir, "../../ui/dist");

const DEFAULT_JUDGE_MODEL = "deepseek/deepseek-v4-pro";

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

/** Runs currently executing inside this server process (local-first trigger). */
const activeRuns = new Map<string, AbortController>();

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

export async function startServer(port = Number(process.env.EVALS_PORT ?? 4801)) {
  await initDb();
  const db = getDb();

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
      "/api/runs": {
        GET: async () => {
          const runs = await listRuns(db);
          const withSummaries = await Promise.all(
            runs.map(async (run) => ({
              ...summarizeRun(run, await listAttempts(db, run.id)),
              active: activeRuns.has(run.id),
            })),
          );
          return json(withSummaries);
        },
        POST: async (req) => {
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
        const run = await getRun(db, req.params.id);
        if (!run) return json({ error: "run not found" }, 404);
        const attempts = await listAttempts(db, run.id);
        return json({
          ...summarizeRun(run, attempts),
          attempts,
          active: activeRuns.has(run.id),
        });
      },
      "/api/runs/:id/resume": {
        POST: async (req) => {
          const run = await getRun(db, req.params.id);
          if (!run) return json({ error: "run not found" }, 404);
          if (activeRuns.has(run.id)) return json({ error: "run is already executing" }, 409);
          await resetErrorAttempts(db, run.id);
          startRunExecution(db, run.id);
          return json({ runId: run.id, resumed: true }, 202);
        },
      },
      "/api/runs/:id/cancel": {
        POST: async (req) => {
          const run = await getRun(db, req.params.id);
          if (!run) return json({ error: "run not found" }, 404);
          const controller = activeRuns.get(run.id);
          if (!controller) return json({ error: "run is not executing in this server" }, 409);
          controller.abort();
          await killRunStacks(run.id);
          return json({ runId: run.id, cancelled: true }, 202);
        },
      },
      "/api/attempts/:id": async (req) => {
        const attempt = await getAttempt(db, req.params.id);
        if (!attempt) return json({ error: "attempt not found" }, 404);
        const [judgments, artifacts] = await Promise.all([
          listJudgments(db, attempt.id),
          listArtifacts(db, attempt.id),
        ]);
        return json({ attempt, judgments, artifacts });
      },
      /**
       * Live judge-trace stream (v3 spec §4 — frozen contract). Registry-only,
       * in-process read: ALWAYS 200, no DB lookup. Unknown attempt, finished
       * attempt, cleared entry, restarted server → { judging: false, traces: [] }.
       * Only meaningful while attempt.status === "judging"; finished attempts
       * use the persisted judgments instead.
       */
      "/api/attempts/:id/judge-live": (req) => json(getJudgeLive(req.params.id)),
      /**
       * Live runner progress (v4 spec §3 — frozen contract). Registry-only,
       * in-process read: ALWAYS 200, no DB lookup — same philosophy as
       * judge-live. Unknown attempt, finished attempt, restarted server →
       * { active: false, startedAt: null, currentPhase: null,
       *   currentPhaseStartedAt: null, phases: {}, log: [] }.
       */
      "/api/attempts/:id/progress": (req) => json(getAttemptProgress(req.params.id)),
      "/api/attempts/:id/transcript": async (req) => {
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
      "/api/scenarios": () => {
        const registry = loadRegistry();
        return json([...registry.scenarios.values()].map(serializeScenario));
      },
      "/api/scenarios/:id": async (req) => {
        const registry = loadRegistry();
        const scenario = registry.scenarios.get(req.params.id);
        if (!scenario) return json({ error: "scenario not found" }, 404);
        const recent = await listAttemptsByScenario(db, scenario.id);
        return json({ scenario: serializeScenario(scenario), recentAttempts: recent });
      },
      "/api/configs": () => {
        const registry = loadRegistry();
        return json(
          [...registry.configs.values()].map((c) => ({
            ...serializeConfig(c),
            isDefault: DEFAULT_CONFIG_IDS.includes(c.id),
          })),
        );
      },
      "/api/models": async () => {
        const models = await listOpenrouterModels();
        return json({ defaultJudgeModel: DEFAULT_JUDGE_MODEL, models });
      },
      "/api/artifacts/:id": async (req) => {
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
