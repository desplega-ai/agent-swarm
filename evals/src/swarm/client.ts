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
  createdAt: string;
}

export interface SessionCostRow {
  totalCostUsd: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
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
   * Fails fast with "aborted" when the signal fires (cancel kills the sandboxes,
   * so every subsequent poll would otherwise spin until the deadline).
   */
  async waitForTask(
    id: string,
    opts: {
      timeoutMs: number;
      intervalMs?: number;
      onStatus?: (status: string) => void;
      signal?: AbortSignal;
    },
  ): Promise<SwarmTask & { timedOut?: boolean }> {
    const interval = opts.intervalMs ?? 5_000;
    const deadline = Date.now() + opts.timeoutMs;
    let lastStatus = "";
    let task: SwarmTask | null = null;
    while (Date.now() < deadline) {
      if (opts.signal?.aborted) throw new Error("aborted");
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
    if (opts.signal?.aborted) throw new Error("aborted");
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
  async getStableSessionLogs(
    taskId: string,
    timeoutMs = 30_000,
    signal?: AbortSignal,
  ): Promise<SessionLogRow[]> {
    const deadline = Date.now() + timeoutMs;
    if (signal?.aborted) throw new Error("aborted");
    let rows = await this.getSessionLogs(taskId).catch(() => [] as SessionLogRow[]);
    while (Date.now() < deadline) {
      await Bun.sleep(5_000);
      if (signal?.aborted) throw new Error("aborted");
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
   * Poll until cost rows are stable (two consecutive successful non-empty
   * equal-length polls — never the first non-empty poll, rows trickle in one
   * per iteration on CLI exit), the empty budget elapses with no rows ever
   * seen, or the hard budget elapses (last snapshot wins). By the time the
   * cost phase runs the task is terminal AND the log capture already idled
   * ≥10s, so rows are normally present on the first poll: the happy path is
   * one stability interval (≈2s), and 12s of total silence means no adapter
   * is going to post rows (e.g. claude on an OAuth subscription).
   */
  async waitForSessionCostRows(
    taskId: string,
    opts: {
      /** Hard budget; elapsing returns the last snapshot (or `[]`). Default 25s. */
      timeoutMs?: number;
      /** Give up early when NO rows have ever appeared. Default 12s. */
      emptyTimeoutMs?: number;
      /** Poll interval. Default 2s. */
      intervalMs?: number;
      signal?: AbortSignal;
    } = {},
  ): Promise<SessionCostRow[]> {
    const timeoutMs = opts.timeoutMs ?? 25_000;
    const emptyTimeoutMs = opts.emptyTimeoutMs ?? 12_000;
    const intervalMs = opts.intervalMs ?? 2_000;
    const t0 = Date.now();
    /** Last successful snapshot — a failed poll keeps it (doesn't reset stability). */
    let prev: SessionCostRow[] | null = null;
    let sawRows = false;
    while (true) {
      if (opts.signal?.aborted) throw new Error("aborted");
      const rows = await this.getSessionCosts(taskId).catch(() => null);
      if (rows) {
        if (rows.length > 0 && prev !== null && prev.length === rows.length) return rows;
        if (rows.length > 0) sawRows = true;
        prev = rows;
      }
      const elapsed = Date.now() - t0;
      if (!sawRows && elapsed >= emptyTimeoutMs) return [];
      if (elapsed >= timeoutMs) return prev ?? [];
      await Bun.sleep(intervalMs);
    }
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

/** One renderable transcript event, parsed from a raw harness JSONL line. */
export interface TranscriptEvent {
  role: "assistant" | "user" | "result" | "raw";
  kind: "text" | "tool_use" | "tool_result" | "raw";
  /** Tool name for tool_use events. */
  name?: string;
  text: string;
  cli?: string;
  iteration?: number;
}

function eventsFromContentBlocks(
  blocks: unknown,
  role: "assistant" | "user",
  base: Pick<TranscriptEvent, "cli" | "iteration">,
): TranscriptEvent[] {
  if (!Array.isArray(blocks)) {
    return typeof blocks === "string" && blocks.trim()
      ? [{ role, kind: "text", text: blocks.trim(), ...base }]
      : [];
  }
  const out: TranscriptEvent[] = [];
  for (const block of blocks) {
    const b = block as Record<string, unknown>;
    if (b.type === "text" && typeof b.text === "string" && b.text.trim()) {
      out.push({ role, kind: "text", text: b.text.trim(), ...base });
    } else if (b.type === "tool_use") {
      out.push({
        role,
        kind: "tool_use",
        name: String(b.name ?? "tool"),
        text: JSON.stringify(b.input ?? {}, null, 2),
        ...base,
      });
    } else if (b.type === "tool_result") {
      const content =
        typeof b.content === "string" ? b.content : JSON.stringify(b.content ?? "", null, 2);
      out.push({ role, kind: "tool_result", text: content, ...base });
    }
  }
  return out;
}

/**
 * Parse raw harness JSONL session-log rows into structured transcript events.
 * Understands Claude stream-json; unrecognized lines become `raw` events so no
 * provider's output is silently dropped.
 */
export function parseTranscriptEvents(rows: SessionLogRow[]): TranscriptEvent[] {
  const events: TranscriptEvent[] = [];
  for (const row of rows) {
    const base = { cli: row.cli, iteration: row.iteration };
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(row.content) as Record<string, unknown>;
    } catch {
      if (row.content.trim()) events.push({ role: "raw", kind: "raw", text: row.content, ...base });
      continue;
    }
    const type = parsed.type as string | undefined;
    if (type === "assistant" || type === "user") {
      const message = parsed.message as Record<string, unknown> | undefined;
      events.push(...eventsFromContentBlocks(message?.content ?? parsed.content, type, base));
    } else if (type === "result") {
      events.push({
        role: "result",
        kind: "text",
        text: JSON.stringify(
          { result: parsed.result, cost: parsed.total_cost_usd, turns: parsed.num_turns },
          null,
          2,
        ),
        ...base,
      });
    } else if (type === "system") {
      // boot/system events are noise for judging and viewing
    } else {
      events.push({ role: "raw", kind: "raw", text: row.content, ...base });
    }
  }
  return events;
}

/**
 * Best-effort flattening of raw harness JSONL session logs into a readable
 * transcript for LLM judging.
 */
export function flattenTranscript(rows: SessionLogRow[]): string {
  return parseTranscriptEvents(rows)
    .map((e) => {
      const label = e.role === "raw" ? "RAW" : e.role.toUpperCase();
      if (e.kind === "tool_use") return `${label}: [tool_use ${e.name}] ${clip(e.text)}`;
      if (e.kind === "tool_result") return `${label}: [tool_result] ${clip(e.text)}`;
      return `${label}: ${clip(e.text, 2000)}`;
    })
    .join("\n");
}
