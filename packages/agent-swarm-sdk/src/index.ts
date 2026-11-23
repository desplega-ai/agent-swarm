/**
 * @desplega.ai/agent-swarm-sdk: a typed, fetch-based client for the Agent Swarm HTTP API.
 *
 *   const swarm = createSwarm();
 *   const task = await swarm.tasks.run("Summarize yesterday's merged PRs");
 *   console.log(task.output);
 *
 * Request and response types come from the server's OpenAPI spec (openapi.gen.ts).
 */
import type { components, paths } from "./openapi.gen.js";

type Json<T> = T extends { content: { "application/json": infer B } } ? B : never;

export type Task = components["schemas"]["AgentTask"];
export type TaskStatus = Task["status"];
export type SendTaskInput = Json<NonNullable<paths["/api/tasks"]["post"]["requestBody"]>>;
export type TaskDetails = Json<paths["/api/tasks/{id}"]["get"]["responses"][200]>;
export type Agent = Json<paths["/api/agents"]["get"]["responses"][200]>["agents"][number];
export type ListAgentsQuery = NonNullable<paths["/api/agents"]["get"]["parameters"]["query"]>;
export type MemorySearchInput = Json<
  NonNullable<paths["/api/memory/search"]["post"]["requestBody"]>
>;
export type MemoryResult = Json<
  paths["/api/memory/search"]["post"]["responses"][200]
>["results"][number];
export type RunScriptInput = Json<NonNullable<paths["/api/scripts/run"]["post"]["requestBody"]>>;
export type ScriptRun = Json<paths["/api/scripts/run"]["post"]["responses"][200]>;
export type { components, paths };

/** Statuses a task never leaves. Mirrors TERMINAL_TASK_STATUSES on the server. */
export const TERMINAL_STATUSES: readonly TaskStatus[] = [
  "completed",
  "failed",
  "cancelled",
  "superseded",
  "skipped",
];

export type SwarmErrorCode =
  | "missing_api_key"
  | "network_error"
  | "bad_request"
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "conflict"
  | "rate_limited"
  | "server_error"
  | "http_error"
  | "timeout"
  | "aborted"
  | "task_failed"
  | "script_failed";

/**
 * Every failure the client raises. Branch on `code`; `status` is the HTTP status
 * (0 when no response came back), `hint` says how to fix it when there is a known fix.
 */
export class SwarmError extends Error {
  readonly code: SwarmErrorCode;
  readonly status: number;
  readonly hint: string | undefined;
  /** For a 429, seconds the server asked to wait (its `Retry-After`). */
  readonly retryAfter: number | undefined;
  /** The parsed error body, when the server sent one. */
  readonly body: unknown;
  /** For `task_failed`, `timeout` and `aborted` from a wait: the task as last seen. */
  readonly task: TaskDetails | undefined;
  /** For `script_failed`: the run, with its stdout, stderr and error. */
  readonly run: ScriptRun | undefined;

  constructor(
    code: SwarmErrorCode,
    message: string,
    extra: {
      status?: number;
      hint?: string;
      retryAfter?: number;
      body?: unknown;
      task?: TaskDetails;
      run?: ScriptRun;
      cause?: unknown;
    } = {},
  ) {
    super(message, extra.cause === undefined ? undefined : { cause: extra.cause });
    this.name = "SwarmError";
    this.code = code;
    this.status = extra.status ?? 0;
    this.hint = extra.hint;
    this.retryAfter = extra.retryAfter;
    this.body = extra.body;
    this.task = extra.task;
    this.run = extra.run;
  }
}

export type SwarmOptions = {
  /** Swarm API key, sent as `Authorization: Bearer`. Default: `AGENT_SWARM_API_KEY`, then `API_KEY`. */
  apiKey?: string;
  /** API base URL. Default: `AGENT_SWARM_URL`, then `MCP_BASE_URL`, then `http://localhost:3013`. */
  baseUrl?: string;
  /** Act as this agent (`X-Agent-ID`). Needed by `scripts.run`. Default: `AGENT_ID`. */
  agentId?: string;
  /** Extra headers on every request. */
  headers?: Record<string, string>;
  /** A fetch implementation. Default: the global `fetch`. */
  fetch?: typeof fetch;
};

export type WaitOptions = {
  /** Give up after this many ms with a `timeout` error. Default: 30 minutes. */
  timeoutMs?: number;
  /** Poll interval in ms. Default: 2000. */
  intervalMs?: number;
  signal?: AbortSignal;
};

export type SendOptions = {
  /** Makes retries safe: the same key never creates a second task. */
  idempotencyKey?: string;
  signal?: AbortSignal;
};

export type Swarm = ReturnType<typeof createSwarm>;

const STATUS_CODES: Record<number, SwarmErrorCode> = {
  400: "bad_request",
  401: "unauthorized",
  403: "forbidden",
  404: "not_found",
  409: "conflict",
  429: "rate_limited",
};

const HINTS: Partial<Record<SwarmErrorCode, string>> = {
  unauthorized: "Check the API key (apiKey option or AGENT_SWARM_API_KEY).",
  network_error: "Check that the swarm API is reachable at baseUrl (or AGENT_SWARM_URL).",
};

const env = (name: string): string | undefined =>
  (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.[name] ||
  undefined;

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });

/** Reject with `signal.reason` as soon as the signal aborts, even if `promise` never settles. */
function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  let onAbort = () => {};
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
  });
  return Promise.race([promise, aborted]).finally(() =>
    signal.removeEventListener("abort", onAbort),
  );
}

/**
 * Create a client. With no options it reads its config from the environment,
 * so `createSwarm()` works anywhere `AGENT_SWARM_API_KEY` is set.
 */
export function createSwarm(options: SwarmOptions = {}) {
  const apiKey = options.apiKey ?? env("AGENT_SWARM_API_KEY") ?? env("API_KEY");
  if (!apiKey) {
    throw new SwarmError("missing_api_key", "No swarm API key.", {
      hint: "Pass createSwarm({ apiKey }) or set AGENT_SWARM_API_KEY.",
    });
  }
  const base = (
    options.baseUrl ??
    env("AGENT_SWARM_URL") ??
    env("MCP_BASE_URL") ??
    "http://localhost:3013"
  ).replace(/\/+$/, "");
  const agentId = options.agentId ?? env("AGENT_ID");
  // Browsers reject a fetch detached from `window` ("Illegal invocation").
  const doFetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init));

  async function call<T>(
    method: string,
    path: string,
    init: { body?: unknown; headers?: Record<string, string>; signal?: AbortSignal } = {},
  ): Promise<T> {
    const aborted = (cause?: unknown) =>
      new SwarmError("aborted", `${method} ${path} aborted.`, { cause });
    if (init.signal?.aborted) throw aborted(init.signal.reason);
    let response: Response;
    let text: string;
    // The body read sits inside the same try: a reset or abort mid-body is a
    // transport failure too, not a raw TypeError or DOMException.
    try {
      [response, text] = await abortable(
        (async () => {
          const res = await doFetch(`${base}${path}`, {
            method,
            headers: {
              ...options.headers,
              authorization: `Bearer ${apiKey}`,
              ...(agentId ? { "x-agent-id": agentId } : {}),
              ...(init.body === undefined ? {} : { "content-type": "application/json" }),
              ...init.headers,
            },
            body: init.body === undefined ? undefined : JSON.stringify(init.body),
            signal: init.signal,
          });
          return [res, await res.text()] as const;
        })(),
        init.signal,
      );
    } catch (cause) {
      if (init.signal?.aborted) throw aborted(cause);
      const detail = cause instanceof Error ? cause.message : String(cause);
      throw new SwarmError("network_error", `${method} ${path} failed: ${detail}`, {
        hint: HINTS.network_error,
        cause,
      });
    }
    let body: unknown;
    try {
      body = text ? JSON.parse(text) : undefined;
    } catch {
      body = text;
    }
    if (!response.ok) {
      const code =
        STATUS_CODES[response.status] ?? (response.status >= 500 ? "server_error" : "http_error");
      const serverMessage =
        body && typeof body === "object" && "error" in body && typeof body.error === "string"
          ? body.error
          : response.statusText || text.slice(0, 300);
      const retryAfter = Number(response.headers.get("retry-after"));
      throw new SwarmError(code, `${method} ${path}: ${response.status} ${serverMessage}`, {
        status: response.status,
        hint: HINTS[code],
        retryAfter: Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : undefined,
        body,
      });
    }
    return body as T;
  }

  const id = (value: string) => encodeURIComponent(value);

  const tasks = {
    /** Create a task. A string is the task text; the lead routes it unless `agentId` is set. */
    send: (input: string | SendTaskInput, opts: SendOptions = {}): Promise<Task> =>
      call<Task>("POST", "/api/tasks", {
        body: typeof input === "string" ? { task: input } : input,
        headers: opts.idempotencyKey ? { "idempotency-key": opts.idempotencyKey } : undefined,
        signal: opts.signal,
      }),

    /** A task with its latest logs and attachments. */
    get: (taskId: string, opts: { logsLimit?: number } = {}): Promise<TaskDetails> =>
      call<TaskDetails>(
        "GET",
        `/api/tasks/${id(taskId)}${opts.logsLimit ? `?logsLimit=${opts.logsLimit}` : ""}`,
      ),

    /**
     * Resolve once the task reaches a terminal status (any of TERMINAL_STATUSES).
     * Transient network and 5xx errors are retried until the timeout. The timeout
     * bounds the whole wait, including a request that stalls.
     */
    async wait(taskId: string, opts: WaitOptions = {}): Promise<TaskDetails> {
      const { timeoutMs = 30 * 60_000, intervalMs = 2000, signal } = opts;
      let last: TaskDetails | undefined;
      // One signal stops the in-flight request and the sleep; `timedOut` records
      // which of the deadline or the caller's signal fired first.
      const stop = new AbortController();
      let timedOut = false;
      const onAbort = () => stop.abort(signal?.reason);
      // shortcut: setTimeout caps at 2^31-1 ms (~24.8 days); clamp rather than fire at once.
      const timer = setTimeout(
        () => {
          if (stop.signal.aborted) return;
          timedOut = true;
          stop.abort();
        },
        Math.min(timeoutMs, 2 ** 31 - 1),
      );
      if (signal?.aborted) onAbort();
      else signal?.addEventListener("abort", onAbort, { once: true });
      const stopped = (cause?: unknown) =>
        timedOut
          ? new SwarmError(
              "timeout",
              `Task ${taskId} is still ${last?.status ?? "unknown"} after ${timeoutMs}ms.`,
              { task: last, hint: "Raise timeoutMs, or call tasks.wait(id) again later.", cause },
            )
          : new SwarmError("aborted", `Stopped waiting for task ${taskId}.`, { task: last, cause });
      try {
        for (;;) {
          let details: TaskDetails | undefined;
          try {
            details = await call<TaskDetails>("GET", `/api/tasks/${id(taskId)}?logsLimit=1`, {
              signal: stop.signal,
            });
          } catch (error) {
            if (stop.signal.aborted) throw stopped(error);
            const transient =
              error instanceof SwarmError &&
              (error.code === "network_error" || error.code === "server_error");
            if (!transient) throw error;
          }
          // A response that lands after the deadline or abort does not count.
          if (stop.signal.aborted) throw stopped();
          if (details) {
            last = details;
            if (TERMINAL_STATUSES.includes(last.status)) return last;
          }
          try {
            await sleep(intervalMs, stop.signal);
          } catch (cause) {
            throw stopped(cause);
          }
        }
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
      }
    },

    /**
     * Send a task and wait for it. Resolves with the completed task; throws a
     * `task_failed` SwarmError (with `.task`) when it ends any other way.
     * `signal` also covers the submit: an aborted signal never creates the task.
     */
    async run(
      input: string | SendTaskInput,
      opts: SendOptions & WaitOptions = {},
    ): Promise<TaskDetails> {
      const sent = await tasks.send(input, opts);
      const done = await tasks.wait(sent.id, opts);
      if (done.status !== "completed") {
        throw new SwarmError(
          "task_failed",
          `Task ${done.id} ended ${done.status}${done.failureReason ? `: ${done.failureReason}` : "."}`,
          { task: done },
        );
      }
      return done;
    },
  };

  return {
    tasks,

    agents: {
      /** Agents with their capacity. */
      list: async (query: ListAgentsQuery = {}): Promise<Agent[]> => {
        const params = new URLSearchParams(
          Object.entries(query).flatMap(([k, v]) => (v === undefined ? [] : [[k, String(v)]])),
        ).toString();
        const page = await call<{ agents: Agent[] }>(
          "GET",
          `/api/agents${params ? `?${params}` : ""}`,
        );
        return page.agents;
      },
    },

    memory: {
      /** Semantic search over swarm memory. */
      search: async (
        query: string,
        opts: Omit<MemorySearchInput, "query"> = {},
      ): Promise<MemoryResult[]> =>
        (
          await call<{ results: MemoryResult[] }>("POST", "/api/memory/search", {
            body: { ...opts, query },
          })
        ).results,
    },

    scripts: {
      /**
       * Run a saved script by name. Resolves with the run; throws a `script_failed`
       * SwarmError (with `.run`) when the script errored or exited non-zero.
       * Needs `agentId` (or `AGENT_ID`).
       */
      async run(
        name: string,
        args?: unknown,
        opts: Omit<RunScriptInput, "name" | "args" | "source"> = {},
      ): Promise<ScriptRun> {
        const run = await call<ScriptRun>("POST", "/api/scripts/run", {
          body: { ...opts, name, args: args ?? {} },
        });
        if (run.error || run.runtimeError || run.exitCode !== 0) {
          const reason = run.runtimeError?.message ?? run.error ?? `exit code ${run.exitCode}`;
          throw new SwarmError("script_failed", `Script ${name} failed: ${reason}`, { run });
        }
        return run;
      },
    },
  };
}
