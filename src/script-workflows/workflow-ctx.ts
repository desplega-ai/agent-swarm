import { mcpToolNameForSdkMethod, stdlib } from "@swarm/scripts";

type StepStatusResponse =
  | { stepKey: string; stepType: string; result: unknown }
  | { error: string };

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
};

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

async function readJson(res: Response): Promise<unknown> {
  const text = await res.text();
  return text ? JSON.parse(text) : {};
}

function apiError(prefix: string, status: number, body: unknown): Error {
  const message =
    body && typeof body === "object" && "error" in body
      ? String((body as { error: unknown }).error)
      : JSON.stringify(body);
  return new Error(`${prefix} failed with ${status}: ${message}`);
}

export function buildWorkflowCtx(input: {
  runId: string;
  agentId: string;
  apiKey: string;
  baseUrl: string;
  args: unknown;
}): WorkflowCtx {
  const baseUrl = input.baseUrl.replace(/\/$/, "");
  const authHeaders = headers(input.apiKey, input.agentId);

  async function fetchJson(path: string, init: RequestInit = {}): Promise<unknown> {
    const res = await fetch(`${baseUrl}${path}`, {
      ...init,
      headers: { ...authHeaders, ...((init.headers as Record<string, string>) ?? {}) },
    });
    const body = await readJson(res);
    if (!res.ok) throw apiError(path, res.status, body);
    return body;
  }

  async function completedStep(
    label: string,
  ): Promise<{ found: true; result: unknown } | { found: false }> {
    const res = await fetch(
      `${baseUrl}/api/internal/script-runs/${input.runId}/steps/${encodeStepKey(label)}`,
      {
        headers: authHeaders,
      },
    );
    if (res.status === 404) return { found: false };
    const body = (await readJson(res)) as StepStatusResponse;
    if (!res.ok) throw apiError(`step ${label}`, res.status, body);
    return { found: true, result: "result" in body ? body.result : undefined };
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

  async function durableStep(
    label: string,
    stepType: string,
    config: unknown,
    execute: () => Promise<unknown>,
  ): Promise<unknown> {
    const replayed = await completedStep(label);
    if (replayed.found) return replayed.result;
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

  return {
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
        durableStep(label, "agent-task", config, async () =>
          fetchJson(`/api/internal/script-runs/${input.runId}/agent-task`, {
            method: "POST",
            body: JSON.stringify({ stepKey: label, ...config }),
          }),
        ),
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
}
