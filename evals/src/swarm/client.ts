import type { SwarmTask } from "../types.ts";

const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled", "superseded"]);

export interface SessionLogRow {
  id: string;
  taskId: string;
  sessionId: string;
  iteration: number;
  cli: string;
  content: string;
  lineNumber: number;
}

export interface SessionCostRow {
  totalCostUsd: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  model: string | null;
  costSource: string;
}

/** Thin authenticated client for one attempt's swarm API. */
export class SwarmClient {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
  ) {}

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`${method} ${path} -> ${res.status}: ${text.slice(0, 500)}`);
    }
    return (text ? JSON.parse(text) : {}) as T;
  }

  async get<T = unknown>(path: string): Promise<T> {
    return this.request<T>("GET", path);
  }

  async createTask(opts: {
    task: string;
    agentId: string;
    outputSchema?: Record<string, unknown>;
  }): Promise<SwarmTask> {
    const res = await this.request<Record<string, unknown>>("POST", "/api/tasks", {
      task: opts.task,
      agentId: opts.agentId,
      source: "api",
      ...(opts.outputSchema ? { outputSchema: opts.outputSchema } : {}),
    });
    const task = unwrapTask(res);
    if (!task.id)
      throw new Error(`task create returned no id: ${JSON.stringify(res).slice(0, 300)}`);
    return normalizeTask(task);
  }

  async getTask(id: string): Promise<SwarmTask> {
    const res = await this.request<Record<string, unknown>>("GET", `/api/tasks/${id}`);
    return normalizeTask(unwrapTask(res));
  }

  /**
   * Poll until the task reaches a terminal status. Returns the final task with
   * `timedOut: true` set when the budget elapses (caller decides how to grade).
   */
  async waitForTask(
    id: string,
    opts: { timeoutMs: number; intervalMs?: number; onStatus?: (status: string) => void },
  ): Promise<SwarmTask & { timedOut?: boolean }> {
    const interval = opts.intervalMs ?? 5_000;
    const deadline = Date.now() + opts.timeoutMs;
    let lastStatus = "";
    let task: SwarmTask | null = null;
    while (Date.now() < deadline) {
      try {
        task = await this.getTask(id);
        if (task.status !== lastStatus) {
          lastStatus = task.status;
          opts.onStatus?.(task.status);
        }
        if (TERMINAL_STATUSES.has(task.status)) return task;
      } catch {
        // transient API blip — keep polling until the deadline
      }
      await Bun.sleep(interval);
    }
    try {
      await this.request("POST", `/api/tasks/${id}/cancel`, { reason: "eval attempt timeout" });
    } catch {
      // best-effort cancel
    }
    return { ...(task ?? { id, title: "", description: "", status: "unknown" }), timedOut: true };
  }

  async getSessionLogs(taskId: string): Promise<SessionLogRow[]> {
    const res = await this.request<{ logs: SessionLogRow[] }>(
      "GET",
      `/api/tasks/${taskId}/session-logs`,
    );
    return res.logs ?? [];
  }

  /**
   * Session logs are flushed by the worker in 50-line / 5s batches and lag task
   * completion. Poll until the row count is stable across two polls (or the
   * budget elapses) so the judged transcript isn't cut off mid-stream.
   */
  async getStableSessionLogs(taskId: string, timeoutMs = 30_000): Promise<SessionLogRow[]> {
    const deadline = Date.now() + timeoutMs;
    let rows = await this.getSessionLogs(taskId).catch(() => [] as SessionLogRow[]);
    while (Date.now() < deadline) {
      await Bun.sleep(5_000);
      const next = await this.getSessionLogs(taskId).catch(() => rows);
      if (next.length === rows.length && rows.length > 0) return next;
      rows = next;
    }
    return rows;
  }

  async getSessionCosts(taskId: string): Promise<SessionCostRow[]> {
    const res = await this.request<{ costs: SessionCostRow[] }>(
      "GET",
      `/api/session-costs?taskId=${taskId}`,
    );
    return res.costs ?? [];
  }

  /**
   * Total USD for a task. Cost rows are written by adapters on CLI exit and lag
   * task completion by ~10-15s, so poll briefly before giving up.
   */
  async waitForTaskCost(
    taskId: string,
    fallback: number | null,
    timeoutMs = 45_000,
  ): Promise<number | null> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const costs = await this.getSessionCosts(taskId);
        if (costs.length > 0) {
          return costs.reduce((sum, c) => sum + (c.totalCostUsd ?? 0), 0);
        }
      } catch {
        // keep polling
      }
      await Bun.sleep(5_000);
    }
    // No session-cost rows in time — the task row's aggregate may have caught up.
    try {
      const task = await this.getTask(taskId);
      const aggregate = (task as Record<string, unknown>).totalCostUsd;
      if (typeof aggregate === "number") return aggregate;
    } catch {
      // fall through
    }
    return fallback;
  }
}

/**
 * Some endpoints return the task flat, others wrap it as {task: {...}} — and on
 * flat responses `.task` is the task TEXT (a string), so only unwrap objects.
 */
function unwrapTask(res: Record<string, unknown>): SwarmTask {
  if (typeof res.task === "object" && res.task !== null) return res.task as SwarmTask;
  return res as unknown as SwarmTask;
}

function normalizeTask(raw: SwarmTask): SwarmTask {
  const r = raw as Record<string, unknown>;
  return {
    ...raw,
    title: (r.title as string) ?? (r.taskPreview as string) ?? "",
    description: (r.task as string) ?? (r.description as string) ?? "",
    result: (r.output as string) ?? (r.result as string) ?? null,
  };
}

const MAX_LINE_CHARS = 600;

function clip(text: string, max = MAX_LINE_CHARS): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine;
}

function textFromContentBlocks(blocks: unknown): string[] {
  if (!Array.isArray(blocks)) return typeof blocks === "string" ? [clip(blocks)] : [];
  const out: string[] = [];
  for (const block of blocks) {
    const b = block as Record<string, unknown>;
    if (b.type === "text" && typeof b.text === "string") out.push(clip(b.text, 2000));
    else if (b.type === "tool_use") {
      out.push(`[tool_use ${b.name}] ${clip(JSON.stringify(b.input ?? {}))}`);
    } else if (b.type === "tool_result") {
      out.push(`[tool_result] ${clip(JSON.stringify(b.content ?? ""))}`);
    }
  }
  return out;
}

/**
 * Best-effort flattening of raw harness JSONL session logs into a readable
 * transcript for LLM judging. Understands Claude stream-json events; anything
 * unrecognized is included as a clipped raw line.
 */
export function flattenTranscript(rows: SessionLogRow[]): string {
  const lines: string[] = [];
  for (const row of rows) {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(row.content) as Record<string, unknown>;
    } catch {
      lines.push(clip(row.content));
      continue;
    }
    const type = parsed.type as string | undefined;
    if (type === "assistant" || type === "user") {
      const message = parsed.message as Record<string, unknown> | undefined;
      const role = type === "assistant" ? "ASSISTANT" : "USER";
      for (const text of textFromContentBlocks(message?.content ?? parsed.content)) {
        lines.push(`${role}: ${text}`);
      }
    } else if (type === "result") {
      lines.push(
        `RESULT: ${clip(JSON.stringify({ result: parsed.result, cost: parsed.total_cost_usd, turns: parsed.num_turns }))}`,
      );
    } else if (type === "system") {
      // boot/system events are noise for judging
    } else {
      lines.push(clip(row.content));
    }
  }
  return lines.join("\n");
}
