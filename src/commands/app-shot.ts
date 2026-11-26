/**
 * `agent-swarm app-shot <appId>`: open `$APP_URL/apps/<appId>` in headless Chromium as the
 * calling agent, wait for the app data to settle, and report screenshots, console errors,
 * failed requests and a render verdict. Worker-side: it reaches the API over HTTP only.
 *
 * The page never sees the swarm key. Its connection points at a fake origin that a Playwright
 * route forwards to MCP_BASE_URL with the key and X-Agent-ID added. That also avoids mixed
 * content (an https dashboard calling an http in-cluster API) and needs no CORS on the API.
 */
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { getApiKey } from "../utils/api-key";
import { scrubSecrets } from "../utils/secret-scrubber";

const PROXY_ORIGIN = "https://app-shot-api.invalid";
const QUIET_MS = 1_000;

/** Playwright is not a package dependency: the worker-full image ships it globally. */
const PLAYWRIGHT_CANDIDATES = [
  "/opt/global-deps-full/node_modules/playwright/index.mjs",
  "playwright",
  "@playwright/test",
];

export type AppShotOptions = {
  appId: string;
  page?: string;
  viewport: { width: number; height: number };
  clicks: string[];
  waitFor?: string;
  asEmail?: string;
  timeoutMs: number;
  outDir: string;
  uploadDir?: string;
  json: boolean;
};

export type Shot = {
  label: string;
  file: string;
  settled: boolean;
  agentFsPath?: string;
  url?: string;
};

export type AppShotResult = {
  ok: boolean;
  url: string;
  viewingAs: string | null;
  shots: Shot[];
  consoleErrors: string[];
  failedRequests: string[];
  problems: string[];
  warnings: string[];
};

class UsageError extends Error {}

export const APP_SHOT_HELP = {
  usage: "agent-swarm app-shot <appId> [options]",
  description:
    "Render a swarm app in headless Chromium as the calling agent and report screenshots,\nconsole errors, failed requests and render ok/fail. Needs APP_URL, MCP_BASE_URL, the swarm\nAPI key and Playwright (worker-full image). Screenshots upload to agent-fs.",
  options: [
    "  --page <name>          App page to open (/apps/<id>/p/<name>)",
    "  --viewport <WxH>       Viewport size (default 1440x900)",
    "  --click <selector>     Click a Playwright selector, settle, shoot again (repeatable)",
    "  --wait-for <selector>  Wait for a selector before the first shot",
    "  --as-email <email>     Dashboard user to view as (default: the first user with an email)",
    "  --timeout <ms>         Settle cap per shot (default 30000)",
    "  --out <dir>            Local screenshot dir (default ./app-shots/<appId>-<stamp>)",
    "  --upload-dir <path>    agent-fs dir (default shared/app-shots/<appId>/<stamp>)",
    "  --no-upload            Keep screenshots local",
    "  --json                 Print the result as JSON",
    "  -h, --help             Show this help",
  ].join("\n"),
  examples: [
    "  agent-swarm app-shot 3a1f6d0f-e7b5-4556-80fc-210642a9f184",
    "  agent-swarm app-shot <appId> --page runs --click 'role=tab[name=\"Errors\"]' --json",
  ].join("\n"),
};

export function parseAppShotArgs(argv: string[], now = new Date()): AppShotOptions {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      page: { type: "string" },
      viewport: { type: "string" },
      click: { type: "string", multiple: true },
      "wait-for": { type: "string" },
      "as-email": { type: "string" },
      timeout: { type: "string" },
      out: { type: "string" },
      "upload-dir": { type: "string" },
      "no-upload": { type: "boolean" },
      json: { type: "boolean" },
    },
  });
  const appId = positionals[0];
  if (!appId) throw new UsageError("missing <appId>");
  if (positionals.length > 1) throw new UsageError(`unexpected argument: ${positionals[1]}`);
  const vp = /^(\d{2,5})x(\d{2,5})$/.exec(values.viewport ?? "1440x900");
  if (!vp) throw new UsageError(`--viewport must look like 1440x900, got ${values.viewport}`);
  const timeoutMs = Number(values.timeout ?? 30_000);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1_000) {
    throw new UsageError("--timeout must be an integer of at least 1000 ms");
  }
  const stamp = now.toISOString().replace(/[:.]/g, "-");
  return {
    appId,
    page: values.page,
    viewport: { width: Number(vp[1]), height: Number(vp[2]) },
    clicks: values.click ?? [],
    waitFor: values["wait-for"],
    asEmail: values["as-email"],
    timeoutMs,
    outDir: resolve(values.out ?? `app-shots/${appId}-${stamp}`),
    uploadDir: values["no-upload"]
      ? undefined
      : (values["upload-dir"] ?? `shared/app-shots/${appId}/${stamp}`).replace(/^\/+|\/+$/g, ""),
    json: values.json ?? false,
  };
}

type Env = Record<string, string | undefined>;

// Structural slices of the Playwright API: it is resolved at runtime, not a package dependency.
type PwResponse = { status(): number; headers(): Record<string, string> };
type PwRequest = {
  url(): string;
  method(): string;
  resourceType(): string;
  allHeaders(): Promise<Record<string, string>>;
  response(): Promise<PwResponse | null>;
  failure(): { errorText: string } | null;
};
type PwRoute = {
  request(): PwRequest;
  fetch(options: {
    url: string;
    headers: Record<string, string>;
    maxRedirects: number;
  }): Promise<PwResponse>;
  fulfill(options: {
    status?: number;
    headers?: Record<string, string>;
    response?: PwResponse;
  }): Promise<void>;
  abort(code: string): Promise<void>;
};
type PwLocator = {
  first(): PwLocator;
  waitFor(options: { timeout: number }): Promise<void>;
  click(options: { timeout: number }): Promise<void>;
  isVisible(): Promise<boolean>;
};
type PwPage = {
  route(url: string, handler: (route: PwRoute) => Promise<void>): Promise<void>;
  routeWebSocket(url: RegExp, handler: () => void): Promise<void>;
  on(
    event: "request" | "requestfinished" | "requestfailed",
    handler: (req: PwRequest) => void,
  ): void;
  on(event: "console", handler: (msg: { type(): string; text(): string }) => void): void;
  on(event: "pageerror", handler: (err: Error) => void): void;
  goto(url: string, options: { waitUntil: "domcontentloaded"; timeout: number }): Promise<unknown>;
  locator(selector: string): PwLocator;
  getByText(text: string, options: { exact: boolean }): PwLocator;
  screenshot(options: { path: string }): Promise<unknown>;
  url(): string;
};
type PwBrowser = {
  newContext(options: {
    viewport: { width: number; height: number };
    reducedMotion: "reduce";
    storageState: {
      cookies: never[];
      origins: { origin: string; localStorage: { name: string; value: string }[] }[];
    };
  }): Promise<{ newPage(): Promise<PwPage> }>;
  close(): Promise<void>;
};
type PwChromium = { launch(options: { headless: boolean }): Promise<PwBrowser> };

async function loadChromium(): Promise<PwChromium> {
  for (const spec of PLAYWRIGHT_CANDIDATES) {
    try {
      // A variable specifier keeps `bun build --compile` from bundling Playwright.
      const mod = await import(spec);
      if (mod?.chromium) return mod.chromium;
    } catch {}
  }
  throw new UsageError(
    "Playwright not found (looked in /opt/global-deps-full and node_modules). Run this on the worker-full image.",
  );
}

async function pickUser(apiBase: string, headers: Record<string, string>, asEmail?: string) {
  const res = await fetch(`${apiBase}/api/users`, { headers });
  if (res.status === 401) throw new UsageError(`${apiBase} rejected the swarm API key (HTTP 401)`);
  if (!res.ok) return null;
  const { users } = (await res.json()) as {
    users: ({ id: string; email?: string | null; emailAliases?: string[] } | null)[];
  };
  const withEmail = users.filter((u): u is NonNullable<typeof u> => Boolean(u?.email));
  if (!asEmail) return withEmail[0] ?? null;
  const want = asEmail.toLowerCase();
  const match = withEmail.find(
    (u) => u.email?.toLowerCase() === want || u.emailAliases?.some((a) => a.toLowerCase() === want),
  );
  if (!match) throw new UsageError(`no swarm user with email ${asEmail}`);
  return match;
}

async function upload(
  shots: Shot[],
  dir: string,
  appUrl: string,
  env: Env,
  warnings: string[],
): Promise<void> {
  if (!Bun.which("agent-fs")) {
    warnings.push("agent-fs CLI not on PATH: screenshots kept local only");
    return;
  }
  let org = env.AGENT_FS_DEFAULT_ORG_ID;
  let drive = env.AGENT_FS_DEFAULT_DRIVE_ID;
  if (!org || !drive) {
    const current = await Bun.$`agent-fs drive current --json`.quiet().nothrow();
    try {
      const parsed = JSON.parse(current.stdout.toString()) as {
        orgId?: string;
        drive?: { id?: string };
      };
      org = parsed.orgId;
      drive = parsed.drive?.id;
    } catch {}
  }
  for (const shot of shots) {
    const path = `${dir}/${shot.file.split("/").pop()}`;
    const out = await Bun.$`agent-fs write ${path} --file ${shot.file} --json`.quiet().nothrow();
    if (out.exitCode !== 0) {
      warnings.push(`agent-fs write ${path} failed: ${scrubSecrets(out.stderr.toString().trim())}`);
      continue;
    }
    shot.agentFsPath = path;
    if (org && drive) shot.url = `${appUrl}/file/~/${org}/${drive}/${path}`;
  }
}

export async function runAppShot(
  opts: AppShotOptions,
  env: Env = process.env,
): Promise<AppShotResult> {
  const appUrl = env.APP_URL?.replace(/\/+$/, "");
  if (!appUrl) {
    throw new UsageError(
      "APP_URL is not set: point it at the swarm dashboard (e.g. https://app.agent-swarm.dev)",
    );
  }
  const apiBase = (env.MCP_BASE_URL ?? "http://localhost:3013").replace(/\/+$/, "");
  const apiKey = getApiKey(env);
  if (!apiKey) throw new UsageError("no swarm API key: set AGENT_SWARM_API_KEY or API_KEY");
  const auth: Record<string, string> = { Authorization: `Bearer ${apiKey}` };
  if (env.AGENT_ID) auth["X-Agent-ID"] = env.AGENT_ID;

  const user = await pickUser(apiBase, auth, opts.asEmail);
  const chromium = await loadChromium();
  const result: AppShotResult = {
    ok: false,
    url: `${appUrl}/apps/${encodeURIComponent(opts.appId)}${opts.page ? `/p/${encodeURIComponent(opts.page)}` : ""}`,
    viewingAs: user?.email ?? null,
    shots: [],
    consoleErrors: [],
    failedRequests: [],
    problems: [],
    warnings: [],
  };
  if (!user)
    result.warnings.push("no swarm user with an email: the identity dialog may cover the app");
  await mkdir(opts.outDir, { recursive: true });

  // The same keys the ui-e2e storageState fixture writes, so no dialog covers the app.
  const storage: Record<string, string> = {
    "agent-swarm-connections": JSON.stringify({
      connections: [
        { id: "conn_app_shot", name: "app-shot", apiUrl: PROXY_ORIGIN, apiKey: "app-shot-proxy" },
      ],
      activeId: "conn_app_shot",
    }),
    "agent-swarm-sessions-v2-guide": "off",
  };
  if (user) {
    storage[`swarm:v1:${PROXY_ORIGIN}:current-user`] = user.id;
    storage[`swarm:feedback-popup:v1:${PROXY_ORIGIN}:${user.id}`] = JSON.stringify({
      version: 1,
      lastSubmittedAt: null,
      lastDismissedAt: new Date().toISOString(),
      submissionCount: 0,
    });
    storage[`swarm:v1:${PROXY_ORIGIN}:github-star-nudge:${user.id}:done`] = "1";
  }

  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({
      viewport: opts.viewport,
      reducedMotion: "reduce",
      storageState: {
        cookies: [],
        origins: [
          {
            origin: new URL(appUrl).origin,
            localStorage: Object.entries(storage).map(([name, value]) => ({ name, value })),
          },
        ],
      },
    });
    const page = await context.newPage();
    const pageOrigin = new URL(appUrl).origin;
    const cors = {
      "access-control-allow-origin": pageOrigin,
      "access-control-allow-credentials": "true",
      "access-control-allow-headers": "*",
      "access-control-allow-methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
    };
    let inflight = 0;
    let closing = false;
    let lastActivity = Date.now();
    let appStatus: number | null = null;
    const appPath = `/api/apps/${encodeURIComponent(opts.appId)}`;

    await page.route(`${PROXY_ORIGIN}/**`, async (route) => {
      const req = route.request();
      if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: cors });
      const target = apiBase + req.url().slice(PROXY_ORIGIN.length);
      const {
        authorization: _a,
        host: _h,
        origin: _o,
        referer: _r,
        ...headers
      } = await req.allHeaders();
      try {
        const response = await route.fetch({
          url: target,
          headers: { ...headers, ...auth },
          maxRedirects: 0,
        });
        if (new URL(target).pathname === appPath && req.method() === "GET")
          appStatus = response.status();
        await route.fulfill({ response, headers: { ...response.headers(), ...cors } });
      } catch (err) {
        // Recorded before the abort, so the requestfailed handler sees it and skips a duplicate.
        if (!closing) {
          const reason = scrubSecrets(String(err).split("\n")[0] ?? "");
          result.failedRequests.push(
            `${req.method()} ${req.url().replace(PROXY_ORIGIN, "")}: ${reason}`,
          );
        }
        await route.abort("connectionfailed").catch(() => {});
      }
    });
    // shortcut: the realtime socket is held open and silent (Playwright cannot re-point a
    // WebSocket at another URL), so live row pushes are not shown; polling still runs.
    await page.routeWebSocket(new RegExp(`^wss?://${new URL(PROXY_ORIGIN).host}/`), () => {});

    // shortcut: settle tracks /api/apps/* only (definition, queries, rows, actions); slow
    // dashboard-shell reads (users, agents) do not hold the shot. Widen if apps read elsewhere.
    const tracked = (req: PwRequest) =>
      req.url().startsWith(`${PROXY_ORIGIN}/api/apps/`) && req.resourceType() !== "eventsource";
    page.on("request", (req: PwRequest) => {
      if (!tracked(req)) return;
      inflight++;
      lastActivity = Date.now();
    });
    const done = (req: PwRequest) => {
      if (!tracked(req)) return;
      inflight = Math.max(0, inflight - 1);
      lastActivity = Date.now();
    };
    page.on("requestfinished", (req: PwRequest) => {
      done(req);
      void req.response().then((res) => {
        if (res && res.status() >= 400) {
          result.failedRequests.push(
            `${req.method()} ${req.url().replace(PROXY_ORIGIN, "")}: HTTP ${res.status()}`,
          );
        }
      });
    });
    page.on("requestfailed", (req: PwRequest) => {
      done(req);
      if (closing) return;
      const url = req.url().replace(PROXY_ORIGIN, "");
      if (!result.failedRequests.some((f) => f.includes(url))) {
        result.failedRequests.push(
          `${req.method()} ${url}: ${req.failure()?.errorText ?? "failed"}`,
        );
      }
    });
    page.on("console", (msg) => {
      if (msg.type() === "error") result.consoleErrors.push(scrubSecrets(msg.text()).slice(0, 500));
    });
    page.on("pageerror", (err: Error) =>
      result.consoleErrors.push(`uncaught: ${scrubSecrets(err.message).slice(0, 500)}`),
    );

    // Settled = the app definition answered and no API request ran for QUIET_MS, capped.
    const settle = async (): Promise<boolean> => {
      const deadline = Date.now() + opts.timeoutMs;
      while (Date.now() < deadline) {
        if (appStatus !== null && inflight === 0 && Date.now() - lastActivity >= QUIET_MS)
          return true;
        await Bun.sleep(100);
      }
      return false;
    };
    const shoot = async (label: string) => {
      // A click that fetches nothing still re-renders: hold at least one quiet window.
      lastActivity = Date.now();
      const settled = await settle();
      const file = join(
        opts.outDir,
        `${String(result.shots.length + 1).padStart(2, "0")}-${label}.png`,
      );
      await page.screenshot({ path: file });
      result.shots.push({ label, file, settled });
      if (!settled)
        result.warnings.push(`${label}: requests still running after ${opts.timeoutMs} ms`);
    };

    await page.goto(result.url, { waitUntil: "domcontentloaded", timeout: opts.timeoutMs });
    if (opts.waitFor) {
      await page
        .locator(opts.waitFor)
        .first()
        .waitFor({ timeout: opts.timeoutMs })
        .catch(() => result.problems.push(`--wait-for ${opts.waitFor} never appeared`));
    }
    await shoot("initial");
    for (const [index, selector] of opts.clicks.entries()) {
      const clicked = await page
        .locator(selector)
        .first()
        .click({ timeout: opts.timeoutMs })
        .then(() => true)
        .catch((err: Error) => {
          result.problems.push(`--click ${selector}: ${err.message.split("\n")[0]}`);
          return false;
        });
      if (!clicked) break;
      await shoot(`click-${index + 1}`);
    }

    const finalPath = new URL(page.url()).pathname;
    if (!finalPath.startsWith("/apps/"))
      result.problems.push(`dashboard redirected to ${finalPath}`);
    if (appStatus === null) result.problems.push(`app definition ${appPath} was never loaded`);
    else if (appStatus >= 400)
      result.problems.push(`app definition ${appPath} answered HTTP ${appStatus}`);
    for (const text of ["Failed to load app", "Something went wrong", "Who are you?"]) {
      if (
        await page
          .getByText(text, { exact: false })
          .first()
          .isVisible()
          .catch(() => false)
      ) {
        result.problems.push(`page shows "${text}"`);
      }
    }
    if (result.consoleErrors.some((e) => e.startsWith("uncaught:")))
      result.problems.push("uncaught page error");
    result.ok = result.problems.length === 0;
    closing = true;
  } finally {
    await browser.close();
  }
  if (opts.uploadDir) await upload(result.shots, opts.uploadDir, appUrl, env, result.warnings);
  return result;
}

function printHuman(r: AppShotResult, log: (s: string) => void): void {
  log(
    `${r.ok ? "render ok" : "render FAILED"}: ${r.url}${r.viewingAs ? ` (as ${r.viewingAs})` : ""}`,
  );
  for (const s of r.shots)
    log(
      `  shot ${s.label}${s.settled ? "" : " (not settled)"}: ${s.url ?? s.agentFsPath ?? s.file}`,
    );
  for (const p of r.problems) log(`  problem: ${p}`);
  log(`  console errors: ${r.consoleErrors.length}`);
  for (const e of r.consoleErrors.slice(0, 20)) log(`    ${e}`);
  log(`  failed requests: ${r.failedRequests.length}`);
  for (const f of r.failedRequests.slice(0, 20)) log(`    ${f}`);
  for (const w of r.warnings) log(`  warning: ${w}`);
}

/** CLI entry. Exit 0 = render ok, 1 = render failed, 2 = usage or environment error. */
export async function runAppShotCommand(argv: string[]): Promise<number> {
  let opts: AppShotOptions;
  try {
    opts = parseAppShotArgs(argv);
    const result = await runAppShot(opts);
    if (opts.json) console.log(JSON.stringify(result, null, 2));
    else printHuman(result, console.log);
    return result.ok ? 0 : 1;
  } catch (err) {
    const message = scrubSecrets(err instanceof Error ? err.message : String(err));
    console.error(`app-shot: ${message}`);
    if (err instanceof UsageError || (err as { code?: string })?.code?.startsWith("ERR_PARSE_ARGS"))
      return 2;
    return 1;
  }
}
