#!/usr/bin/env bun
/**
 * `bun run ui:dev --app <id> | --page <id|slug> | --route <path>`: start the dashboard dev
 * server (apps/ui, Vite, hot reload) on loopback, already connected to a swarm API with a fixed
 * dashboard user, and print one ready line with the URL to open. Browsing, screenshots and
 * video stay with the caller's tool (agent-browser, Playwright, qa-use). Runbook:
 * runbooks/app-and-page-dev.md.
 *
 * The dashboard's API URL is the dev server's own origin. Vite proxies `/api`, `/health`,
 * `/status`, `/p/*` and `/@swarm/*` to the target API, so the browser sees one origin: no CORS
 * allowlist entry for the port, page `frame-ancestors 'self'` matches, and the page-session
 * cookie is first-party.
 *
 * Exit codes: 0 clean stop (SIGINT/SIGTERM), 1 dev server failure, 2 usage or config error.
 */
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { getApiKey } from "../../src/utils/api-key";

const HELP = `Usage: bun run ui:dev (--app <id> | --page <id|slug> | --route <path>) [options]
       bun run app:dev <appId> [options]

Starts the dashboard dev server on 127.0.0.1, connected to the swarm API as a fixed user,
and prints UI_DEV_READY {json} with the URL to open. Runs until SIGINT/SIGTERM.

Options:
  --app <id>          Open /apps/<id>
  --page <id|slug>    Open /pages/<id> (a slug resolves to the newest matching page)
  --route <path>      Open any dashboard path, e.g. /apps/<id>/p/<page>?mode=chromeless
  --api-url <url>     Swarm API (default $MCP_BASE_URL). Another URL must be loopback.
  --as-email <email>  Dashboard user to view as (default: the first user with an email)
  --port <n>          Dev server port (default 5274)
  --json              Print only the ready JSON line
  -h, --help          Show this help

Prod writes: the UI acts with your swarm key. Clicking an app action or submitting a page
form writes to that API.`;

const READY_TIMEOUT_MS = 120_000;
const repoRoot = resolve(import.meta.dir, "../..");

export class UsageError extends Error {}

type Target =
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
): Promise<{ target: Target; path: string }> {
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

async function waitForHttp(url: string, child: Bun.Subprocess, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`dev server exited with code ${child.exitCode}`);
    const ok = await fetch(url)
      .then((res) => res.ok)
      .catch(() => false);
    if (ok) return;
    await Bun.sleep(250);
  }
  throw new Error(`dev server did not answer ${url} within ${timeoutMs} ms`);
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

export async function main(argv: string[]): Promise<number> {
  if (argv.includes("-h") || argv.includes("--help")) {
    console.log(HELP);
    return 0;
  }
  let options: UiDevOptions;
  let resolved: Awaited<ReturnType<typeof resolveTarget>>;
  let user: { id: string; email?: string | null };
  const apiKey = getApiKey();
  try {
    options = parseUiDevArgs(argv);
    if (!apiKey) throw new UsageError("no swarm API key: set AGENT_SWARM_API_KEY or API_KEY");
    const headers: Record<string, string> = { Authorization: `Bearer ${apiKey}` };
    user = await pickUser(options.apiUrl, headers, options.asEmail);
    // Check the target as the dashboard will read it: as that user.
    resolved = await resolveTarget(options, { ...headers, "X-Swarm-User-Id": user.id });
    if (!(await portFree(options.port))) {
      throw new UsageError(`port ${options.port} is taken: stop that process or pass --port`);
    }
  } catch (error) {
    if (!(error instanceof UsageError) && !(error instanceof TypeError)) throw error;
    console.error(`ui:dev: ${error.message}`);
    return 2;
  }

  const origin = `http://127.0.0.1:${options.port}`;
  // shortcut: swarm key in a loopback-only dev bundle; upgrade to a per-run user token
  // (POST /api/users/{id}/mcp-tokens, revoked on exit) if the UI is ever served beyond loopback.
  const child = Bun.spawn(
    [
      resolve(repoRoot, "node_modules/.bin/vite"),
      "--host",
      "127.0.0.1",
      "--port",
      String(options.port),
      "--strictPort",
      "--clearScreen",
      "false",
    ],
    {
      cwd: resolve(repoRoot, "apps/ui"),
      env: {
        ...process.env,
        VITE_API_URL: origin,
        VITE_API_KEY: apiKey,
        VITE_USER_ID: user.id,
        VITE_PROXY_TARGET: options.apiUrl,
        // Agent preview load: no UI telemetry, no nudge or popup overlays.
        VITE_AGENT_PREVIEW: "1",
      },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  // Vite's log goes to stderr so stdout carries only the ready line.
  const pump = async (stream: ReadableStream<Uint8Array>) => {
    for await (const chunk of stream) process.stderr.write(chunk);
  };
  void pump(child.stdout);
  void pump(child.stderr);

  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    child.kill("SIGTERM");
    setTimeout(() => child.kill("SIGKILL"), 5_000).unref();
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  const url = `${origin}${resolved.path}`;
  try {
    await waitForHttp(url, child, READY_TIMEOUT_MS);
  } catch (error) {
    console.error(`ui:dev: ${error instanceof Error ? error.message : String(error)}`);
    stop();
    await child.exited;
    return 1;
  }

  const ready = {
    url,
    target: resolved.target,
    apiUrl: options.apiUrl,
    userId: user.id,
    userEmail: user.email ?? null,
    warnings: [
      `the UI acts with your swarm key on ${options.apiUrl}: action clicks and form submits write there`,
    ],
    pid: process.pid,
  };
  console.log(options.json ? JSON.stringify(ready) : `UI_DEV_READY ${JSON.stringify(ready)}`);

  const code = await child.exited;
  return stopping ? 0 : code === 0 ? 1 : code;
}

if (import.meta.main) {
  process.exit(await main(Bun.argv.slice(2)));
}
