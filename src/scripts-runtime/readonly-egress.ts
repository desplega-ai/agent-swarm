import { mcpToolNameForSdkMethod, SDK_READ_ONLY_METHODS } from "./sdk-allowlist";

/**
 * Network egress lockdown for READ-ONLY script runs (routing dry runs).
 *
 * Gating `ctx.swarm` and stripping connection descriptors is not sufficient on
 * its own: the subprocess still has a working global `fetch`, so a handler that
 * carries a credential in its own source — or that simply posts to an
 * unauthenticated webhook — could perform a real external write while being
 * "dry run". This patch rejects every non-swarm origin.
 *
 * The origin check alone is ALSO not sufficient: a handler using raw `fetch`
 * against the swarm API with its own auth headers would bypass the
 * `SDK_READ_ONLY_METHODS` gate and perform writes same-origin. So same-origin
 * requests are additionally matched against a deny-by-default (method, path)
 * allowlist mirroring what the read-only SDK surface actually emits (see
 * `bridgeRequestFor` in swarm-sdk.ts — keep the two in sync), and generic
 * `/api/mcp-bridge` calls are only forwarded for read-only bridge tools.
 * Note "GET" is not assumed safe: `GET /api/poll` claims a task and
 * `GET /api/config*` returns unmasked secrets, so both are absent below.
 *
 * Applied AFTER the credential-broker patch so it wraps it: the broker would
 * otherwise substitute real credentials into a request this layer then blocks,
 * which is harmless but wasteful, and ordering it this way keeps the rejection
 * the outermost behaviour.
 */

/** (method, pathname) pairs the read-only SDK surface emits as first-party REST calls. */
const READ_ONLY_REST_ROUTES: ReadonlyArray<{ method: string; path: RegExp }> = [
  // agent_info
  { method: "GET", path: /^\/me$/ },
  // task_list / task_get
  { method: "GET", path: /^\/api\/tasks(\/[^/]+)?$/ },
  // memory_get
  { method: "GET", path: /^\/api\/memory\/[^/]+$/ },
  // kv_get / kv_list (GET only — writes are PUT/POST/DELETE)
  { method: "GET", path: /^\/api\/kv(\/.*)?$/ },
  // repo_list
  { method: "GET", path: /^\/api\/repos$/ },
  // schedule_list
  { method: "GET", path: /^\/api\/schedules$/ },
  // routing_handler_list
  { method: "GET", path: /^\/api\/routing\/handlers$/ },
  // swarm_get
  { method: "GET", path: /^\/api\/agents$/ },
  // metrics_get
  { method: "GET", path: /^\/api\/metrics$/ },
  // service_list
  { method: "GET", path: /^\/api\/services$/ },
  // workflow_list / workflow_get / workflow_listRuns / workflow_getRun
  { method: "GET", path: /^\/api\/workflows(\/[^/]+(\/runs)?)?$/ },
  { method: "GET", path: /^\/api\/workflow-runs\/[^/]+$/ },
  // prompt_list / prompt_get
  { method: "GET", path: /^\/api\/prompt-templates(\/[^/]+)?$/ },
  // skill_list / skill_get / skill_getFile
  { method: "GET", path: /^\/api\/skills(\/[^/]+(\/files\/.+)?)?$/ },
  // mcpServer_list / mcpServer_get
  { method: "GET", path: /^\/api\/mcp-servers(\/[^/]+)?$/ },
  // classify / memory_search / script_search / skill_search — POST-shaped reads
  { method: "POST", path: /^\/api\/internal-ai\/classify$/ },
  { method: "POST", path: /^\/api\/memory\/search$/ },
  { method: "POST", path: /^\/api\/scripts\/search$/ },
  { method: "POST", path: /^\/api\/skills\/search$/ },
];

/** MCP tool names the generic bridge may invoke in read-only mode. */
const READ_ONLY_BRIDGE_TOOLS: ReadonlySet<string> = new Set(
  [...SDK_READ_ONLY_METHODS].map(mcpToolNameForSdkMethod),
);

function isAllowedRestRequest(method: string, pathname: string): boolean {
  return READ_ONLY_REST_ROUTES.some(
    (route) => route.method === method && route.path.test(pathname),
  );
}

async function requestBodyText(
  input: Parameters<typeof fetch>[0],
  init?: RequestInit,
): Promise<string | null> {
  if (typeof init?.body === "string") return init.body;
  if (init?.body === undefined && input instanceof Request) {
    try {
      return await input.clone().text();
    } catch {
      return null;
    }
  }
  // Streams/FormData/Blob bodies are never produced by the SDK bridge — deny.
  return null;
}

export function patchFetchForReadOnly(mcpBaseUrl: string): void {
  let allowedOrigin: string;
  try {
    allowedOrigin = new URL(mcpBaseUrl).origin;
  } catch {
    // An unparseable base URL means we cannot establish what "the swarm API"
    // is, so allow nothing rather than falling open.
    allowedOrigin = "";
  }

  const inner = globalThis.fetch;
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const rawUrl =
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    let url: URL | null = null;
    try {
      url = new URL(rawUrl);
    } catch {
      url = null;
    }
    if (!allowedOrigin || url === null || url.origin !== allowedOrigin) {
      throw new Error(
        `Network egress to ${url?.origin ?? rawUrl} is blocked in read-only mode (routing dry-run). ` +
          "Dry runs may only reach the swarm API.",
      );
    }

    const method = (
      init?.method ?? (input instanceof Request ? input.method : "GET")
    ).toUpperCase();

    if (method === "POST" && url.pathname === "/api/mcp-bridge") {
      // The bridge executes arbitrary MCP tools by name, so the path alone
      // says nothing about read-vs-write — gate on the tool in the body.
      let tool: unknown;
      const body = await requestBodyText(input, init);
      try {
        tool = body === null ? undefined : (JSON.parse(body) as { tool?: unknown }).tool;
      } catch {
        tool = undefined;
      }
      if (typeof tool !== "string" || !READ_ONLY_BRIDGE_TOOLS.has(tool)) {
        throw new Error(
          `MCP bridge call to tool '${typeof tool === "string" ? tool : "<unknown>"}' is blocked ` +
            "in read-only mode (routing dry-run) — dry runs may only invoke read-only tools.",
        );
      }
    } else if (!isAllowedRestRequest(method, url.pathname)) {
      throw new Error(
        `${method} ${url.pathname} is blocked in read-only mode (routing dry-run) — ` +
          "dry runs may only perform the read-only swarm API calls the SDK surface exposes.",
      );
    }

    return inner(input, init);
  }) as typeof fetch;
}
