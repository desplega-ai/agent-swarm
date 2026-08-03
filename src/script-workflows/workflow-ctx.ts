import { readScriptSdkJsonResponse } from "../scripts-runtime/response-limit";
import { mcpToolNameForSdkMethod } from "../scripts-runtime/sdk-allowlist";
import { stdlib } from "../scripts-runtime/stdlib";

type StepStatusResponse = {
  stepKey: string;
  stepType: string;
  /**
   * Journal status. Optional only for wire-compat with an older API build
   * that returned `result` alone — a missing status is read as "completed",
   * which is exactly how those builds behaved.
   */
  status?: "completed" | "failed";
  result?: unknown;
  error?: string;
};

type ReplayedStep =
  | { found: true; status: "completed"; result: unknown }
  | { found: true; status: "failed"; error?: string }
  | { found: false };

type StepWriteResponse = { ok: true } | { error: string };

type RawLlmConfig = {
  prompt: string;
  model?: string;
  schema?: Record<string, unknown>;
};

type AgentTaskConfig = {
  template?: string;
  task?: string;
  agentId?: string;
  tags?: string[];
  priority?: number;
  offerMode?: boolean;
  dir?: string;
  vcsRepo?: string;
  model?: string;
  parentTaskId?: string;
  requestedByUserId?: string;
  outputSchema?: Record<string, unknown>;
  /**
   * Block until the dispatched task reaches a terminal status and journal
   * its real output. Defaults to `true` — this is the natural semantic for
   * a durable step. Set `false` to keep the legacy fire-and-poll-yourself
   * behavior: a single dispatch call that journals `{taskId, status}`
   * immediately (status is usually "pending").
   */
  waitForCompletion?: boolean;
  /**
   * Max time (ms) to wait for the task to reach a terminal status before
   * throwing a timeout error. Only applies when `waitForCompletion` is true.
   * Default: 2 hours. Each poll round-trip already long-polls server-side
   * for up to ~30s, so this is checked with ~30s granularity. The
   * *effective* deadline is always clamped to the run's shared, absolute
   * `SCRIPT_RUN_MAX_WALL_MS` cap (same clamp for every step in the run,
   * concurrent or not — never divided across concurrently waiting steps).
   * If the run-level cap fires first, the supervisor kills the harness
   * process, and every step resumes polling its own journaled taskId (no
   * duplicate dispatch) on the next reconciliation.
   */
  timeoutMs?: number;
  /**
   * When the task ends `failed` / `cancelled` / `superseded`, throw so the
   * failure surfaces to the workflow author (default). Set `false` to
   * instead resolve with `{taskId, status, error}` and let the workflow
   * decide what to do.
   */
  failOnTaskFailure?: boolean;
};

const DEFAULT_AGENT_TASK_TIMEOUT_MS = 2 * 60 * 60 * 1000; // 2h — plan/implement/review steps commonly run this long
const AGENT_TASK_TRANSIENT_RETRY_LIMIT = 5;
const AGENT_TASK_TRANSIENT_RETRY_BASE_MS = 500;
const DEFAULT_DRAIN_GRACE_MS = 35_000; // a bit above the server's ~30s long-poll window per call

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Absolute wall-clock deadline shared by every `ctx.step.agentTask` wait in
 * this run — sourced from the persisted run row's `startedAt` (survives
 * supervisor restarts) and the server-resolved `SCRIPT_RUN_MAX_WALL_MS`
 * (see executor.ts). N concurrent `Promise.all` waits each clamp their own
 * per-step deadline to this SAME absolute point — never divided by N, never
 * re-derived per step.
 */
function runWallDeadlineMs(): number | undefined {
  const startedAt = Date.parse(process.env.SCRIPT_RUN_STARTED_AT ?? "");
  const maxWallMs = Number(process.env.SCRIPT_RUN_MAX_WALL_MS);
  if (!Number.isFinite(startedAt) || !Number.isFinite(maxWallMs) || maxWallMs <= 0) {
    return undefined;
  }
  return startedAt + maxWallMs;
}

type SwarmScriptConfig = {
  name?: string;
  scriptName?: string;
  source?: string;
  args?: unknown;
  scope?: "agent" | "global";
  fsMode?: "none" | "workspace-rw";
  intent?: string;
  idempotencyKey?: string;
};

type WorkflowRunInfo = {
  id: string;
  agentId: string;
  args: unknown;
};

export type WorkflowCtx = {
  run: WorkflowRunInfo;
  step: {
    rawLlm: (label: string, config: RawLlmConfig) => Promise<unknown>;
    agentTask: (label: string, config: AgentTaskConfig) => Promise<unknown>;
    swarmScript: (label: string, config: SwarmScriptConfig) => Promise<unknown>;
    humanInTheLoop: () => Promise<never>;
  };
  swarm: Record<string, (args?: unknown) => Promise<unknown>>;
  stdlib: typeof stdlib;
  logger: Console;
};

function encodeStepKey(label: string): string {
  return encodeURIComponent(label);
}

function headers(apiKey: string, agentId: string): Record<string, string> {
  return {
    Authorization: `Bearer ${apiKey}`,
    "X-Agent-ID": agentId,
    "Content-Type": "application/json",
  };
}

function apiError(prefix: string, status: number, body: unknown): Error {
  const message =
    body && typeof body === "object" && "error" in body
      ? String((body as { error: unknown }).error)
      : JSON.stringify(body);
  return new Error(`${prefix} failed with ${status}: ${message}`);
}

export type BuiltWorkflowCtx = {
  ctx: WorkflowCtx;
  /**
   * Give any still-in-flight ctx.step.* calls (e.g. Promise.all siblings of
   * a step that just rejected) a bounded chance to finish and journal
   * before the harness finalizes the run and exits. No-ops immediately when
   * nothing is in flight. Never blocks indefinitely — callers past the
   * grace window are left running server-side and are picked up again by
   * the (runId, stepKey) contextKey lookup on the run's next resume.
   */
  drainInFlightSteps: (graceMs?: number) => Promise<void>;
};

export function buildWorkflowCtx(input: {
  runId: string;
  agentId: string;
  apiKey: string;
  baseUrl: string;
  args: unknown;
}): BuiltWorkflowCtx {
  const baseUrl = input.baseUrl.replace(/\/$/, "");
  const authHeaders = headers(input.apiKey, input.agentId);

  async function fetchJson(path: string, init: RequestInit = {}): Promise<unknown> {
    const res = await fetch(`${baseUrl}${path}`, {
      ...init,
      headers: { ...authHeaders, ...((init.headers as Record<string, string>) ?? {}) },
    });
    const body = await readScriptSdkJsonResponse(res, path);
    if (!res.ok) throw apiError(path, res.status, body);
    return body;
  }

  async function completedStep(label: string): Promise<ReplayedStep> {
    const res = await fetch(
      `${baseUrl}/api/internal/script-runs/${input.runId}/steps/${encodeStepKey(label)}`,
      {
        headers: authHeaders,
      },
    );
    if (res.status === 404) return { found: false };
    const body = (await readScriptSdkJsonResponse(
      res,
      `script workflow step ${label}`,
    )) as StepStatusResponse;
    if (!res.ok) throw apiError(`step ${label}`, res.status, body);
    if (body.status === "failed") return { found: true, status: "failed", error: body.error };
    return { found: true, status: "completed", result: body.result };
  }

  async function writeStep(
    label: string,
    stepType: string,
    config: unknown,
    status: "completed" | "failed",
    result?: unknown,
    error?: string,
    durationMs?: number,
  ): Promise<void> {
    const body = (await fetchJson(`/api/internal/script-runs/${input.runId}/steps`, {
      method: "POST",
      body: JSON.stringify({ stepKey: label, stepType, config, status, result, error, durationMs }),
    })) as StepWriteResponse;
    if (!("ok" in body)) throw new Error(`Failed to write journal step ${label}`);
  }

  async function postAgentTaskOnce(
    label: string,
    body: string,
  ): Promise<{ status: number; body: unknown }> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= AGENT_TASK_TRANSIENT_RETRY_LIMIT; attempt++) {
      try {
        const res = await fetch(`${baseUrl}/api/internal/script-runs/${input.runId}/agent-task`, {
          method: "POST",
          headers: authHeaders,
          body,
        });
        const parsed = await readScriptSdkJsonResponse(res, `agent-task ${label}`);
        return { status: res.status, body: parsed };
      } catch (err) {
        lastError = err;
        if (attempt === AGENT_TASK_TRANSIENT_RETRY_LIMIT) break;
        await sleep(AGENT_TASK_TRANSIENT_RETRY_BASE_MS * 2 ** attempt);
      }
    }
    throw lastError instanceof Error
      ? lastError
      : new Error(`agent-task ${label} request failed: ${String(lastError)}`);
  }

  async function waitForAgentTask(label: string, config: AgentTaskConfig): Promise<unknown> {
    const { waitForCompletion, timeoutMs, failOnTaskFailure, ...serverConfig } = config;
    const wait = waitForCompletion ?? true;
    const budgetMs = timeoutMs ?? DEFAULT_AGENT_TASK_TIMEOUT_MS;
    // Clamp to the run's shared absolute wall-clock cap — every concurrent
    // step clamps to the SAME point, not budgetMs/N.
    const requestedDeadline = Date.now() + budgetMs;
    const sharedDeadline = runWallDeadlineMs();
    const deadline =
      sharedDeadline !== undefined
        ? Math.min(requestedDeadline, sharedDeadline)
        : requestedDeadline;
    const requestBody = JSON.stringify({ stepKey: label, ...serverConfig });

    // Every call resolves to the SAME task: the server looks it up by a
    // (runId, stepKey) contextKey before creating one, so replaying this
    // loop after a crash/restart resumes polling the original task instead
    // of dispatching a duplicate.
    while (true) {
      const { status, body } = await postAgentTaskOnce(label, requestBody);

      if (status === 200) {
        return (body as { taskOutput: unknown }).taskOutput ?? null;
      }

      if (status === 409) {
        const info = body as { error: string; taskId: string };
        if (failOnTaskFailure ?? true) {
          throw new Error(`agent-task ${label} failed: ${info.error} (taskId ${info.taskId})`);
        }
        return { taskId: info.taskId, status: "failed", error: info.error };
      }

      if (status !== 202) {
        throw apiError(`agent-task ${label}`, status, body);
      }

      // 202: dispatched (or still pending) — this is the legacy return shape.
      if (!wait) return body;

      if (Date.now() >= deadline) {
        const info = body as { taskId: string; status: string };
        throw new Error(
          `agent-task ${label} timed out after ${budgetMs}ms waiting for taskId ${info.taskId} ` +
            `(last known status: ${info.status}). Increase config.timeoutMs or check the task directly.`,
        );
      }
      // The server already long-polls up to ~30s per call, so no extra
      // client-side sleep is needed before the next round-trip.
    }
  }

  // Every ctx.step.* call — sequential or fired concurrently via
  // Promise.all — registers its settling promise here, synchronously, before
  // its first await (so a step still blocked on its initial journal lookup
  // counts as in-flight too). If one step in a Promise.all rejects, the
  // others keep running detached in the background; drainInFlightSteps()
  // (called by the harness before it finalizes the run and exits) gives them
  // a bounded chance to reach their own journal write instead of being
  // silently orphaned.
  const inFlight = new Set<Promise<unknown>>();

  // Deliberately NOT `async`: the whole durable-step lifecycle — including
  // the very first `GET /steps/:label` journal lookup — lives inside
  // `settled`, and `inFlight.add(settled)` runs in the SAME synchronous turn
  // as the ctx.step.* call. Registering after the lookup left a window where
  // a Promise.all sibling could reject, the harness's drainInFlightSteps()
  // would see an empty set, and process.exit(1) would kill this step before
  // it ever dispatched, polled, or journaled anything.
  function durableStep(
    label: string,
    stepType: string,
    config: unknown,
    execute: () => Promise<unknown>,
  ): Promise<unknown> {
    const settled = (async () => {
      const replayed = await completedStep(label);
      if (replayed.found) {
        if (replayed.status === "failed") {
          // The journal already recorded this step as failed (e.g. the
          // harness died after the failure write but before it could post
          // the run failure). Rethrow the recorded error verbatim so the
          // resumed run fails exactly the way the original did — returning
          // `undefined` here would let the workflow sail past a failed
          // default-`failOnTaskFailure` child and be marked completed.
          throw new Error(
            replayed.error ?? `script workflow step ${label} failed (no error recorded)`,
          );
        }
        return replayed.result;
      }
      const startedAt = Date.now();
      try {
        const result = await execute();
        const durationMs = Date.now() - startedAt;
        await writeStep(label, stepType, config, "completed", result, undefined, durationMs);
        return result;
      } catch (err) {
        const durationMs = Date.now() - startedAt;
        const error = err instanceof Error ? err.message : String(err);
        await writeStep(label, stepType, config, "failed", undefined, error, durationMs);
        throw err;
      }
    })();
    inFlight.add(settled);
    // Separate chain for bookkeeping only — swallowing the rejection here
    // does not suppress it on `settled` itself, which is what callers
    // (and Promise.all) actually await.
    settled.catch(() => {}).finally(() => inFlight.delete(settled));
    return settled;
  }

  async function drainInFlightSteps(graceMs = DEFAULT_DRAIN_GRACE_MS): Promise<void> {
    if (inFlight.size === 0) return;
    await Promise.race([
      (async () => {
        while (inFlight.size > 0) {
          await Promise.allSettled([...inFlight]);
        }
      })(),
      sleep(graceMs),
    ]);
  }

  const swarm = new Proxy({} as Record<string, (args?: unknown) => Promise<unknown>>, {
    get(_target, prop) {
      if (typeof prop !== "string") return undefined;
      return (args?: unknown) =>
        fetchJson("/api/mcp-bridge", {
          method: "POST",
          body: JSON.stringify({ tool: mcpToolNameForSdkMethod(prop), args: args ?? {} }),
        });
    },
  });

  const ctx: WorkflowCtx = {
    run: { id: input.runId, agentId: input.agentId, args: input.args },
    step: {
      rawLlm: (label, config) =>
        durableStep(label, "raw-llm", config, async () =>
          fetchJson("/api/internal/raw-llm", {
            method: "POST",
            body: JSON.stringify(config),
          }),
        ),
      agentTask: (label, config) =>
        durableStep(label, "agent-task", config, () => waitForAgentTask(label, config)),
      swarmScript: (label, config) =>
        durableStep(label, "swarm-script", config, async () =>
          fetchJson("/api/scripts/run", {
            method: "POST",
            body: JSON.stringify({
              name: config.name ?? config.scriptName,
              source: config.source,
              args: config.args,
              scope: config.scope,
              fsMode: config.fsMode ?? "none",
              intent: config.intent ?? `script-run:${input.runId}:${label}`,
              idempotencyKey: config.idempotencyKey,
            }),
          }),
        ),
      humanInTheLoop: async () => {
        throw new Error("ctx.step.humanInTheLoop is stubbed in Script Workflows v1");
      },
    },
    swarm,
    stdlib,
    logger: console,
  };

  return { ctx, drainInFlightSteps };
}
