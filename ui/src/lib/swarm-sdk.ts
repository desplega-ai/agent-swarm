/**
 * In-SPA mirror of `BROWSER_SDK_JS` (see `src/artifact-sdk/browser-sdk.ts`).
 *
 * The classic SDK runs inside an iframed page and routes through
 * `/@swarm/api/*` (server injects bearer + agent-id). The JSON renderer runs
 * IN the SPA — there is no server-side bearer-injection layer — so we call
 * the swarm API directly with the SPA's stored bearer.
 *
 * Method ids are flat strings of the form `<domain>.<op>` so the JSON-render
 * action handler can route via a single allowlist (`tasks.create`,
 * `agents.list`, etc.). The class-style nested API (`sdk.tasks.create(...)`)
 * is provided in `makeSwarmSDK` for callers that want it.
 *
 * Per `root.md` "What We're NOT Doing": JSON pages' declared actions in v1
 * may only target the swarm API using the viewer's bearer.
 *
 * Full HTTP API reference: https://docs.agent-swarm.dev/docs/api-reference
 */

const SDK_METHODS = [
  // tasks
  "tasks.create",
  "tasks.list",
  "tasks.get",
  "tasks.storeProgress",
  // agents
  "agents.list",
  "agents.get",
  // events
  "events.create",
  "events.list",
  "events.batch",
  "events.counts",
  // memory
  "memory.search",
  "memory.list",
  "memory.get",
  "memory.rate",
  // repos
  "repos.list",
  "repos.get",
  "repos.create",
  "repos.update",
  "repos.delete",
  // schedules
  "schedules.list",
  "schedules.get",
  "schedules.create",
  "schedules.update",
  "schedules.delete",
  "schedules.run",
  // approval-requests
  "approvalRequests.list",
  "approvalRequests.get",
  "approvalRequests.create",
  "approvalRequests.respond",
] as const;

export type SwarmSdkMethod = (typeof SDK_METHODS)[number];

export const SWARM_SDK_METHODS: readonly SwarmSdkMethod[] = SDK_METHODS;

export interface SwarmSdkContext {
  /** Absolute API base URL (no trailing slash), e.g. `http://localhost:3013`. */
  apiUrl: string;
  /**
   * Returns the per-request header map. Mirrors `ApiClient.getHeaders` —
   * factored as a callable so the bearer is re-read on every action invoke.
   */
  getHeaders: () => Record<string, string>;
  /** Override of `globalThis.fetch` (test injection point). */
  fetch?: typeof fetch;
}

type Body = Record<string, unknown> | undefined;
type Filters = Record<string, unknown> | undefined;

export interface SwarmSDKInstance {
  // Flat dispatch — looked up by the JSON renderer via `params.sdk`.
  invoke(method: SwarmSdkMethod, args?: Record<string, unknown>): Promise<unknown>;

  // Class-style nested API.
  tasks: {
    create(body: Body): Promise<unknown>;
    list(filters?: Filters): Promise<unknown>;
    get(id: string): Promise<unknown>;
    storeProgress(id: string, data: Body): Promise<unknown>;
  };
  agents: {
    list(): Promise<unknown>;
    get(id: string): Promise<unknown>;
  };
  events: {
    create(body: Body): Promise<unknown>;
    list(filters?: Filters): Promise<unknown>;
    batch(body: Body): Promise<unknown>;
    counts(filters?: Filters): Promise<unknown>;
  };
  memory: {
    search(body: Body): Promise<unknown>;
    list(filters?: Filters): Promise<unknown>;
    get(id: string): Promise<unknown>;
    rate(body: Body): Promise<unknown>;
  };
  repos: {
    list(): Promise<unknown>;
    get(id: string): Promise<unknown>;
    create(body: Body): Promise<unknown>;
    update(id: string, body: Body): Promise<unknown>;
    delete(id: string): Promise<unknown>;
  };
  schedules: {
    list(): Promise<unknown>;
    get(id: string): Promise<unknown>;
    create(body: Body): Promise<unknown>;
    update(id: string, body: Body): Promise<unknown>;
    delete(id: string): Promise<unknown>;
    run(id: string): Promise<unknown>;
  };
  approvalRequests: {
    list(filters?: Filters): Promise<unknown>;
    get(id: string): Promise<unknown>;
    create(body: Body): Promise<unknown>;
    respond(id: string, body: Body): Promise<unknown>;
  };
}

export function makeSwarmSDK(ctx: SwarmSdkContext): SwarmSDKInstance {
  const f = ctx.fetch ?? fetch.bind(globalThis);

  async function call(
    method: "GET" | "POST" | "PUT" | "DELETE" | "PATCH",
    path: string,
    body?: Body,
  ): Promise<unknown> {
    const init: RequestInit = { method, headers: ctx.getHeaders() };
    if (body !== undefined) init.body = JSON.stringify(body);
    const res = await f(`${ctx.apiUrl}${path}`, init);
    const text = await res.text();
    let parsed: unknown = null;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
    }
    if (!res.ok) {
      const err = new Error(`swarm.sdk ${method} ${path}: ${res.status}`) as Error & {
        status?: number;
        response?: unknown;
      };
      err.status = res.status;
      err.response = parsed;
      throw err;
    }
    return parsed;
  }

  function qs(args: Filters): string {
    if (!args) return "";
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(args)) {
      if (v === undefined || v === null) continue;
      params.set(k, String(v));
    }
    const s = params.toString();
    return s ? `?${s}` : "";
  }

  const enc = encodeURIComponent;

  const tasks = {
    create: (body: Body) => call("POST", "/api/tasks", body),
    list: (filters?: Filters) => call("GET", `/api/tasks${qs(filters)}`),
    get: (id: string) => call("GET", `/api/tasks/${enc(id)}`),
    storeProgress: (id: string, data: Body) => call("POST", `/api/tasks/${enc(id)}/progress`, data),
  };
  const agents = {
    list: () => call("GET", "/api/agents"),
    get: (id: string) => call("GET", `/api/agents/${enc(id)}`),
  };
  const events = {
    create: (body: Body) => call("POST", "/api/events", body),
    list: (filters?: Filters) => call("GET", `/api/events${qs(filters)}`),
    batch: (body: Body) => call("POST", "/api/events/batch", body),
    counts: (filters?: Filters) => call("GET", `/api/events/counts${qs(filters)}`),
  };
  const memory = {
    search: (body: Body) => call("POST", "/api/memory/search", body),
    list: (filters?: Filters) => call("GET", `/api/memory/list${qs(filters)}`),
    get: (id: string) => call("GET", `/api/memory/${enc(id)}`),
    rate: (body: Body) => call("POST", "/api/memory/rate", body),
  };
  const repos = {
    list: () => call("GET", "/api/repos"),
    get: (id: string) => call("GET", `/api/repos/${enc(id)}`),
    create: (body: Body) => call("POST", "/api/repos", body),
    update: (id: string, body: Body) => call("PUT", `/api/repos/${enc(id)}`, body),
    delete: (id: string) => call("DELETE", `/api/repos/${enc(id)}`),
  };
  const schedules = {
    list: () => call("GET", "/api/schedules"),
    get: (id: string) => call("GET", `/api/schedules/${enc(id)}`),
    create: (body: Body) => call("POST", "/api/schedules", body),
    update: (id: string, body: Body) => call("PUT", `/api/schedules/${enc(id)}`, body),
    delete: (id: string) => call("DELETE", `/api/schedules/${enc(id)}`),
    run: (id: string) => call("POST", `/api/schedules/${enc(id)}/run`),
  };
  const approvalRequests = {
    list: (filters?: Filters) => call("GET", `/api/approval-requests${qs(filters)}`),
    get: (id: string) => call("GET", `/api/approval-requests/${enc(id)}`),
    create: (body: Body) => call("POST", "/api/approval-requests", body),
    respond: (id: string, body: Body) =>
      call("POST", `/api/approval-requests/${enc(id)}/respond`, body),
  };

  // Flat dispatch — used by the JSON renderer where each action's `sdk` is
  // a single string like "tasks.create".
  function invoke(method: SwarmSdkMethod, args?: Record<string, unknown>): Promise<unknown> {
    const a = args ?? {};
    switch (method) {
      case "tasks.create":
        return tasks.create(a);
      case "tasks.list":
        return tasks.list(a);
      case "tasks.get":
        return tasks.get(String(a.id));
      case "tasks.storeProgress":
        return tasks.storeProgress(String(a.id), (a.data as Body) ?? {});
      case "agents.list":
        return agents.list();
      case "agents.get":
        return agents.get(String(a.id));
      case "events.create":
        return events.create(a);
      case "events.list":
        return events.list(a);
      case "events.batch":
        return events.batch(a);
      case "events.counts":
        return events.counts(a);
      case "memory.search":
        return memory.search(a);
      case "memory.list":
        return memory.list(a);
      case "memory.get":
        return memory.get(String(a.id));
      case "memory.rate":
        return memory.rate(a);
      case "repos.list":
        return repos.list();
      case "repos.get":
        return repos.get(String(a.id));
      case "repos.create":
        return repos.create(a);
      case "repos.update":
        return repos.update(String(a.id), (a.body as Body) ?? a);
      case "repos.delete":
        return repos.delete(String(a.id));
      case "schedules.list":
        return schedules.list();
      case "schedules.get":
        return schedules.get(String(a.id));
      case "schedules.create":
        return schedules.create(a);
      case "schedules.update":
        return schedules.update(String(a.id), (a.body as Body) ?? a);
      case "schedules.delete":
        return schedules.delete(String(a.id));
      case "schedules.run":
        return schedules.run(String(a.id));
      case "approvalRequests.list":
        return approvalRequests.list(a);
      case "approvalRequests.get":
        return approvalRequests.get(String(a.id));
      case "approvalRequests.create":
        return approvalRequests.create(a);
      case "approvalRequests.respond":
        return approvalRequests.respond(String(a.id), (a.body as Body) ?? a);
    }
  }

  return {
    invoke,
    tasks,
    agents,
    events,
    memory,
    repos,
    schedules,
    approvalRequests,
  };
}
