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
 * `--api local` boots a throwaway API (scripts/ui-dev/local.ts) with the app or page copied in
 * from the source API or a `--fixture` bundle, and proxies to it instead.
 *
 * Exit codes: 0 clean stop (SIGINT/SIGTERM), 1 dev server, local API or copy failure, 2 usage
 * or config error.
 */
import { resolve } from "node:path";
import {
  parseUiDevArgs,
  prepareUiDev,
  printReady,
  type UiDevSession,
  UsageError,
} from "../../src/commands/ui-dev";
import {
  bootLocalApi,
  CopyError,
  createLocalIdentity,
  exportApp,
  exportPage,
  type Fixture,
  importApp,
  importPage,
  type LocalApi,
  readFixture,
} from "./local";

const HELP = `Usage: bun run ui:dev (--app <id> | --page <id|slug> | --route <path>) [options]
       bun run ui:dev --api local --fixture <bundle.json> [options]
       bun run app:dev <appId> [options]

Starts the dashboard dev server on 127.0.0.1, connected to the swarm API as a fixed user,
and prints UI_DEV_READY {json} with the URL to open. Runs until SIGINT/SIGTERM.

Options:
  --app <id>          Open /apps/<id>
  --page <id|slug>    Open /pages/<id> (a slug resolves to the newest matching page)
  --route <path>      Open any dashboard path, e.g. /apps/<id>/p/<page>?mode=chromeless
  --api prod|local    prod (default): the UI talks to --api-url. local: a throwaway API on
                      --state-dir with the app or page copied in from --api-url (or --fixture)
  --fixture <file>    Local mode: copy this app bundle or page bundle instead of a source API.
                      The fixture names the target, so pass no --app/--page/--route
  --state-dir <dir>   Local mode: where the API keeps its database, log and api-key file
                      (default .ui-dev/<kind>-<id> in the repo; wiped at each start)
  --api-url <url>     Swarm API (default $MCP_BASE_URL). Another URL must be loopback.
  --as-email <email>  Dashboard user to view as (default: the first user with an email)
  --port <n>          Dev server port (default 5274)
  --json              Print only the ready JSON line
  -h, --help          Show this help

Prod writes: the UI acts with your swarm key. Clicking an app action or submitting a page
form writes to that API. Local mode writes only to its own copy.`;

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

const LOCAL_FLAGS = new Set(["--api", "--fixture", "--state-dir"]);
const DEFAULT_LOCAL_EMAIL = "ui-dev@example.com";

type LocalArgs = { api: "prod" | "local"; fixture?: string; stateDir?: string; rest: string[] };

/** Take the local-mode flags out; the rest are the options `agent-swarm ui-dev` shares. */
function splitLocalArgs(argv: string[]): LocalArgs {
  const rest: string[] = [];
  const values: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const eq = arg.indexOf("=");
    const name = eq > 0 ? arg.slice(0, eq) : arg;
    if (!LOCAL_FLAGS.has(name)) {
      rest.push(arg);
      continue;
    }
    const value = eq > 0 ? arg.slice(eq + 1) : argv[++i];
    if (!value || value.startsWith("--")) throw new UsageError(`${name} needs a value`);
    values[name] = value;
  }
  const api = values["--api"] ?? "prod";
  if (api !== "prod" && api !== "local") {
    throw new UsageError(`--api must be prod or local, got ${api}`);
  }
  if (api === "prod" && (values["--fixture"] || values["--state-dir"])) {
    throw new UsageError("--fixture and --state-dir need --api local");
  }
  return { api, fixture: values["--fixture"], stateDir: values["--state-dir"], rest };
}

type LocalRun = {
  session: UiDevSession;
  api: LocalApi;
  source: string;
  stateDir: string;
  warnings: string[];
};

/**
 * Local mode: read the target from the source API (or the fixture), boot a throwaway API,
 * copy the target and a dashboard user into it, then check it like prod mode does.
 */
async function prepareLocal(local: LocalArgs): Promise<LocalRun> {
  let fixture: Fixture | undefined;
  let rest = local.rest;
  if (local.fixture) {
    if (rest.some((arg) => /^--(app|page|route)(=|$)/.test(arg))) {
      throw new UsageError("--fixture names the target: drop --app, --page and --route");
    }
    try {
      fixture = await readFixture(resolve(local.fixture));
    } catch (error) {
      if (error instanceof CopyError) throw new UsageError(error.message);
      throw error;
    }
    rest = [...rest, `--${fixture.kind}`, fixture.id];
  }
  // With a fixture or a bare route nothing is read from a source API, so none is required.
  const offline = { ...process.env, MCP_BASE_URL: process.env.MCP_BASE_URL || "http://127.0.0.1" };
  const options = parseUiDevArgs(rest, offline);
  const needsSource = !fixture && options.target.kind !== "route";
  const source = needsSource ? await prepareUiDev(rest) : undefined;
  const email = source?.user.email ?? options.asEmail ?? DEFAULT_LOCAL_EMAIL;
  const sourceKey = { apiUrl: source?.options.apiUrl ?? "", apiKey: source?.apiKey ?? "" };

  const kind = options.target.kind;
  const sourceId = source?.target.kind === "route" ? undefined : source?.target.id;
  const id = fixture?.id ?? sourceId ?? "route";
  const stateDir = resolve(
    local.stateDir ?? resolve(repoRoot, ".ui-dev", `${kind}-${id.replace(/[^\w.-]/g, "_")}`),
  );
  const api = await bootLocalApi(stateDir, repoRoot);
  try {
    const owner = await createLocalIdentity(api, { email });
    const warnings: string[] = [];
    let target: string[];
    if (kind === "app") {
      const bundle =
        fixture?.kind === "app" ? fixture.bundle : await exportApp(sourceKey, sourceId!);
      warnings.push(...(await importApp(api, bundle, owner.agentId)));
      target = ["--app", id];
    } else if (kind === "page") {
      const bundle =
        fixture?.kind === "page" ? fixture.bundle : await exportPage(sourceKey, sourceId!);
      const copied = await importPage(api, bundle, owner);
      warnings.push(...copied.warnings);
      target = ["--page", copied.id];
    } else {
      target = ["--route", options.target.value];
    }
    const session = await prepareUiDev(
      [
        ...target,
        "--api-url",
        api.baseUrl,
        "--as-email",
        email,
        "--port",
        String(options.port),
        ...(options.json ? ["--json"] : []),
      ],
      { ...process.env, AGENT_SWARM_API_KEY: api.apiKey, MCP_BASE_URL: api.baseUrl },
    );
    return {
      session,
      api,
      source: fixture ? `fixture:${resolve(local.fixture!)}` : (source?.options.apiUrl ?? "none"),
      stateDir,
      warnings,
    };
  } catch (error) {
    await api.stop();
    throw error;
  }
}

export async function main(argv: string[]): Promise<number> {
  if (argv.includes("-h") || argv.includes("--help")) {
    console.log(HELP);
    return 0;
  }
  let session: UiDevSession;
  let local: LocalRun | undefined;
  try {
    const split = splitLocalArgs(argv);
    if (split.api === "local") {
      local = await prepareLocal(split);
      session = local.session;
    } else {
      session = await prepareUiDev(split.rest);
    }
  } catch (error) {
    if (error instanceof CopyError) {
      console.error(`ui:dev: ${error.message}`);
      return 1;
    }
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
  const stopLocal = async () => {
    await child.exited;
    await local?.api.stop();
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  const url = `${origin}${session.path}`;
  try {
    await waitForHttp(url, child, READY_TIMEOUT_MS);
  } catch (error) {
    console.error(`ui:dev: ${error instanceof Error ? error.message : String(error)}`);
    stop();
    await stopLocal();
    return 1;
  }

  printReady(
    session,
    origin,
    local && {
      source: local.source,
      stateDir: local.stateDir,
      apiKeyFile: local.api.apiKeyFile,
      warnings: local.warnings,
    },
  );

  const code = await child.exited;
  await stopLocal();
  return stopping ? 0 : code === 0 ? 1 : code;
}

if (import.meta.main) {
  process.exit(await main(Bun.argv.slice(2)));
}
