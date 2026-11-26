#!/usr/bin/env bun
/**
 * `bun run ui:dev --app <id> | --page <id|slug> | --route <path>`: start the dashboard dev
 * server (apps/ui, Vite, hot reload) on loopback, already connected to a swarm API with a fixed
 * dashboard user, and print one ready line with the URL to open. Browsing, screenshots and
 * video stay with the caller's tool (agent-browser, Playwright, qa-use). Runbook:
 * runbooks/app-and-page-dev.md. Argument, user and target checks are shared with
 * `agent-swarm ui-dev` (src/commands/ui-dev.ts), which needs no checkout.
 *
 * The dashboard's API URL is the dev server's own origin. Vite proxies `/api`, `/health`,
 * `/status`, `/p/*` and `/@swarm/*` to the target API, so the browser sees one origin: no CORS
 * allowlist entry for the port, page `frame-ancestors 'self'` matches, and the page-session
 * cookie is first-party.
 *
 * Exit codes: 0 clean stop (SIGINT/SIGTERM), 1 dev server failure, 2 usage or config error.
 */
import { resolve } from "node:path";
import { prepareUiDev, printReady, type UiDevSession, UsageError } from "../../src/commands/ui-dev";

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

export async function main(argv: string[]): Promise<number> {
  if (argv.includes("-h") || argv.includes("--help")) {
    console.log(HELP);
    return 0;
  }
  let session: UiDevSession;
  try {
    session = await prepareUiDev(argv);
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    console.error(`ui:dev: ${error.message}`);
    return 2;
  }
  const { options, apiKey, user } = session;

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
        // Vite's default Host allowlist (loopback and IPs) blocks DNS rebinding of the keyed
        // bundle; an inherited VITE_ALLOWED_HOSTS=* would turn it off.
        VITE_ALLOWED_HOSTS: "",
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

  const url = `${origin}${session.path}`;
  try {
    await waitForHttp(url, child, READY_TIMEOUT_MS);
  } catch (error) {
    console.error(`ui:dev: ${error instanceof Error ? error.message : String(error)}`);
    stop();
    await child.exited;
    return 1;
  }

  printReady(session, origin);

  const code = await child.exited;
  return stopping ? 0 : code === 0 ? 1 : code;
}

if (import.meta.main) {
  process.exit(await main(Bun.argv.slice(2)));
}
