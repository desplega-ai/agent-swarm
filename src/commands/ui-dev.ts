/**
 * `agent-swarm ui-dev --app <id> | --page <id|slug> | --route <path>`: open a swarm app or page
 * in the dashboard, already connected to a swarm API as a fixed user, without a repo checkout.
 * It serves the dashboard bundle of `APP_URL` (default https://app.agent-swarm.dev) on
 * 127.0.0.1 and injects the connection into its index.html. `bun run ui:dev`
 * (scripts/ui-dev) shares the argument, user and target code and serves `apps/ui` source with
 * Vite instead. Runbook: runbooks/app-and-page-dev.md.
 *
 * The dashboard's API URL is this server's own origin. `/api`, `/health`, `/status`, `/p/*` and
 * `/@swarm/*` go to the swarm API; every other path goes to the dashboard host. The browser sees
 * one origin: no CORS allowlist entry for the port, page `frame-ancestors 'self'` matches, and
 * the page-session cookie is first-party.
 *
 * Exit codes: 0 clean stop (SIGINT/SIGTERM), 1 server failure, 2 usage or config error.
 */
import { parseArgs } from "node:util";
import { getApiKey } from "../utils/api-key";
import { DEFAULT_APP_URL, getAppUrl } from "../utils/constants";

export class UsageError extends Error {}

export type UiDevTarget =
  | { kind: "app"; id: string; name?: string }
  | { kind: "page"; id: string; slug?: string; contentType?: string; authMode?: string }
  | { kind: "route"; path: string };

export type UiDevOptions = {
  target: { kind: "app" | "page" | "route"; value: string };
  apiUrl: string;
  asEmail?: string;
  port: number;
  json: boolean;
};

export type UiDevSession = {
  options: UiDevOptions;
  apiKey: string;
  user: { id: string; email?: string | null };
  target: UiDevTarget;
  path: string;
};

/** The window global the dashboard reads its connection from (apps/ui deployment-config.ts). */
export const RUNTIME_CONFIG_GLOBAL = "__AGENT_SWARM_UI_CONFIG__";
/** apps/ui/index.html carries this meta tag once its bundle reads the runtime config. */
const RUNTIME_CONFIG_MARKER = 'name="agent-swarm-ui-runtime-config"';
const API_PATH = /^\/(?:api|health|status)(?:\/|$)|^\/(?:p|@swarm)\//;
// Bun's fetch decodes the body, so the encoding and length headers no longer describe it.
const DROPPED_HEADERS = [
  "host",
  "connection",
  "keep-alive",
  "transfer-encoding",
  "content-length",
  "content-encoding",
];

function isLoopback(url: URL): boolean {
  return ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
}

export function parseUiDevArgs(argv: string[], env = process.env): UiDevOptions {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      app: { type: "string" },
      page: { type: "string" },
      route: { type: "string" },
      "api-url": { type: "string" },
      "as-email": { type: "string" },
      port: { type: "string" },
      json: { type: "boolean" },
    },
  });
  if (positionals.length > 0) throw new UsageError(`unexpected argument: ${positionals[0]}`);
  const targets = (["app", "page", "route"] as const).filter((k) => values[k] !== undefined);
  if (targets.length !== 1) throw new UsageError("pass exactly one of --app, --page, --route");
  const kind = targets[0]!;
  const value = values[kind]!.trim();
  if (!value) throw new UsageError(`--${kind} is empty`);

  const base = env.MCP_BASE_URL?.replace(/\/+$/, "");
  const raw = (values["api-url"] ?? base)?.replace(/\/+$/, "");
  if (!raw) throw new UsageError("MCP_BASE_URL is not set and no --api-url was given");
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new UsageError(`not a URL: ${raw}`);
  }
  // The swarm key goes to this URL: only the configured API or a loopback test API.
  if (raw !== base && !isLoopback(parsed)) {
    throw new UsageError(`--api-url must be $MCP_BASE_URL or a loopback URL, got ${raw}`);
  }

  const port = Number(values.port ?? 5274);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new UsageError(`--port must be a port number, got ${values.port}`);
  }
  return {
    target: { kind, value },
    apiUrl: raw,
    asEmail: values["as-email"],
    port,
    json: values.json ?? false,
  };
}

async function getJson(url: string, headers: Record<string, string>) {
  const res = await fetch(url, { headers });
  if (res.status === 401) throw new UsageError(`${url} rejected the swarm API key (HTTP 401)`);
  return {
    status: res.status,
    body: res.ok ? ((await res.json()) as Record<string, unknown>) : {},
  };
}

/** Ported from the app-shot prototype: match the primary email or an alias, case-insensitive. */
async function pickUser(apiUrl: string, headers: Record<string, string>, asEmail?: string) {
  const { status, body } = await getJson(`${apiUrl}/api/users`, headers);
  if (status !== 200) throw new UsageError(`GET /api/users returned HTTP ${status}`);
  const users = (body.users ?? []) as ({
    id: string;
    email?: string | null;
    emailAliases?: string[];
  } | null)[];
  const withEmail = users.filter((u): u is NonNullable<typeof u> => Boolean(u?.email));
  if (!asEmail) {
    if (!withEmail[0]) throw new UsageError("no swarm user with an email: pass --as-email");
    return withEmail[0];
  }
  const want = asEmail.toLowerCase();
  const match = withEmail.find(
    (u) => u.email?.toLowerCase() === want || u.emailAliases?.some((a) => a.toLowerCase() === want),
  );
  if (!match) throw new UsageError(`no swarm user with email ${asEmail}`);
  return match;
}

async function resolveTarget(
  options: UiDevOptions,
  headers: Record<string, string>,
): Promise<{ target: UiDevTarget; path: string }> {
  const { kind, value } = options.target;
  if (kind === "route") {
    const path = value.startsWith("/") ? value : `/${value}`;
    return { target: { kind, path }, path };
  }
  if (kind === "app") {
    const { status, body } = await getJson(
      `${options.apiUrl}/api/apps/${encodeURIComponent(value)}`,
      headers,
    );
    if (status !== 200) throw new UsageError(`app ${value} not found (HTTP ${status})`);
    const app = (body.app ?? body) as { id?: string; name?: string };
    const id = app.id ?? value;
    return { target: { kind, id, name: app.name }, path: `/apps/${id}` };
  }
  const byId = /^[0-9a-f]{32}$/.test(value);
  const url = byId
    ? `${options.apiUrl}/api/pages/${value}`
    : `${options.apiUrl}/api/pages/resolve?slug=${encodeURIComponent(value)}`;
  const { status, body } = await getJson(url, headers);
  if (status !== 200) throw new UsageError(`page ${value} not found (HTTP ${status})`);
  const page = body as { id: string; slug?: string; contentType?: string; authMode?: string };
  return {
    target: {
      kind,
      id: page.id,
      slug: page.slug,
      contentType: page.contentType,
      authMode: page.authMode,
    },
    path: `/pages/${page.id}`,
  };
}

async function portFree(port: number): Promise<boolean> {
  try {
    const server = Bun.listen({ hostname: "127.0.0.1", port, socket: { data() {} } });
    server.stop(true);
    return true;
  } catch {
    return false;
  }
}

/**
 * Parse the arguments, then check the key, the user, the target and the port. Throws
 * UsageError (exit 2) on any of them.
 */
export async function prepareUiDev(argv: string[]): Promise<UiDevSession> {
  const options = parseUiDevArgs(argv);
  const apiKey = getApiKey();
  if (!apiKey) throw new UsageError("no swarm API key: set AGENT_SWARM_API_KEY or API_KEY");
  const headers: Record<string, string> = { Authorization: `Bearer ${apiKey}` };
  try {
    const user = await pickUser(options.apiUrl, headers, options.asEmail);
    // Check the target as the dashboard will read it: as that user.
    const resolved = await resolveTarget(options, { ...headers, "X-Swarm-User-Id": user.id });
    if (!(await portFree(options.port))) {
      throw new UsageError(`port ${options.port} is taken: stop that process or pass --port`);
    }
    return { options, apiKey, user, ...resolved };
  } catch (error) {
    // fetch rejects with a TypeError when the API is unreachable.
    if (error instanceof TypeError) throw new UsageError(error.message);
    throw error;
  }
}

/** The ready line both commands print once the URL answers. */
export function printReady(session: UiDevSession, origin: string): void {
  const { options } = session;
  const ready = {
    url: `${origin}${session.path}`,
    target: session.target,
    apiUrl: options.apiUrl,
    userId: session.user.id,
    userEmail: session.user.email ?? null,
    warnings: [
      `the UI acts with your swarm key on ${options.apiUrl}: action clicks and form submits write there`,
    ],
    pid: process.pid,
  };
  console.log(options.json ? JSON.stringify(ready) : `UI_DEV_READY ${JSON.stringify(ready)}`);
}

/**
 * The dashboard HTML with the connection set before the app module runs, and without the
 * Plausible tags (an agent preview sends no analytics).
 */
export function injectRuntimeConfig(html: string, config: Record<string, string>): string {
  // `<` escaped so no value can close the script tag.
  const json = JSON.stringify(config).replace(/</g, "\\u003c");
  return html
    .replace(/<script\b[^>]*>[^<]*<\/script>\s*/g, (tag) => (tag.includes("plausible") ? "" : tag))
    .replace(
      /<head\b[^>]*>/,
      (head) => `${head}<script>window.${RUNTIME_CONFIG_GLOBAL}=${json}</script>`,
    );
}

function withoutHopHeaders(source: Headers): Headers {
  const headers = new Headers(source);
  for (const name of DROPPED_HEADERS) headers.delete(name);
  return headers;
}

/** `agent-swarm ui-dev` (src/cli.tsx routes here; its COMMAND_HELP holds the help text). */
export async function runUiDev(argv: string[]): Promise<number> {
  const uiUrl = getAppUrl();
  let session: UiDevSession;
  try {
    session = await prepareUiDev(argv);
    // An older dashboard build ignores the injected connection and would show /setup.
    const shell = await fetch(`${uiUrl}/`).then(
      async (res) => (res.ok ? res.text() : ""),
      () => null,
    );
    if (shell === null) throw new UsageError(`cannot reach the dashboard at ${uiUrl} (APP_URL)`);
    if (!shell.includes(RUNTIME_CONFIG_MARKER)) {
      const retry = uiUrl === DEFAULT_APP_URL ? "" : `, or set APP_URL=${DEFAULT_APP_URL}`;
      throw new UsageError(
        `the dashboard at ${uiUrl} (APP_URL) predates ui-dev: update it${retry}`,
      );
    }
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    console.error(`ui-dev: ${error.message}`);
    return 2;
  }

  const { apiUrl, port } = session.options;
  const origin = `http://127.0.0.1:${port}`;
  // shortcut: swarm key in a loopback-only HTML response; upgrade to a per-run user token
  // (POST /api/users/{id}/mcp-tokens, revoked on exit) if this is ever served beyond loopback.
  const config = {
    VITE_API_URL: origin,
    VITE_API_KEY: session.apiKey,
    VITE_USER_ID: session.user.id,
    // Agent preview load: no UI telemetry, no nudge or popup overlays.
    VITE_AGENT_PREVIEW: "1",
  };

  let server: ReturnType<typeof Bun.serve>;
  try {
    server = Bun.serve({
      hostname: "127.0.0.1",
      port,
      // shortcut: no WebSocket proxy (only Comb file presence uses one); add it if a view needs it.
      async fetch(req) {
        const url = new URL(req.url);
        const toApi = API_PATH.test(url.pathname);
        const headers = withoutHopHeaders(req.headers);
        // The key and the page-session cookie go to the swarm API only, never to the UI host.
        if (!toApi) {
          headers.delete("authorization");
          headers.delete("cookie");
        }
        let res: Response;
        try {
          res = await fetch(`${toApi ? apiUrl : uiUrl}${url.pathname}${url.search}`, {
            method: req.method,
            headers,
            body:
              req.method === "GET" || req.method === "HEAD" ? undefined : await req.arrayBuffer(),
            redirect: "manual",
          });
        } catch (error) {
          return new Response(`ui-dev: upstream unreachable: ${String(error)}`, { status: 502 });
        }
        const resHeaders = withoutHopHeaders(res.headers);
        if (!toApi && (res.headers.get("content-type") ?? "").includes("text/html")) {
          const html = injectRuntimeConfig(await res.text(), config);
          return new Response(html, { status: res.status, headers: resHeaders });
        }
        return new Response(res.body, { status: res.status, headers: resHeaders });
      },
    });
  } catch (error) {
    console.error(`ui-dev: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }

  printReady(session, origin);
  await new Promise<void>((resolve) => {
    process.once("SIGINT", () => resolve());
    process.once("SIGTERM", () => resolve());
  });
  await server.stop(true);
  return 0;
}
