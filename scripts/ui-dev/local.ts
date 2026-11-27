/**
 * `bun run ui:dev --api local`: a throwaway swarm API on a state directory, with the target app
 * or page copied in from a source API or a fixture file. scripts/ui-dev/index.ts then points the
 * dashboard dev server at it. Runbook: runbooks/app-and-page-dev.md § Local mode.
 */
import { randomBytes } from "node:crypto";
import { chmod, mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { minimalEnv, reservedPort, tailLog } from "../e2e/sut";

export const PAGE_BUNDLE_FORMAT = "swarm-page-bundle/v1";
const APP_BUNDLE_FORMAT = "swarm-app-bundle/v1";
const KV_PAGE = 1000;

export class CopyError extends Error {}

export type LocalApi = {
  baseUrl: string;
  apiKey: string;
  apiKeyFile: string;
  logPath: string;
  stop: () => Promise<void>;
};

type Json = Record<string, unknown>;

/** A page and its KV namespace: the `--fixture` format for `--page`, and the prod copy shape. */
export type PageBundle = {
  format: typeof PAGE_BUNDLE_FORMAT;
  page: {
    id?: string;
    slug?: string;
    title: string;
    description?: string;
    contentType: string;
    authMode?: string;
    body: string;
    theme?: string | null;
    themeTokens?: unknown;
    designVersion?: number;
  };
  kv: { key: string; value: unknown; valueType?: string; expiresAt?: number | null }[];
};

export type Fixture =
  | { kind: "app"; id: string; bundle: Json }
  | { kind: "page"; id: string; bundle: PageBundle };

/** Read a `--fixture` file: an app bundle (`GET /api/apps/{id}/export`) or a page bundle. */
export async function readFixture(path: string): Promise<Fixture> {
  let bundle: Json;
  try {
    bundle = (await Bun.file(path).json()) as Json;
  } catch (error) {
    throw new CopyError(`cannot read fixture ${path}: ${(error as Error).message}`);
  }
  if (bundle.format === APP_BUNDLE_FORMAT) {
    const id = (bundle.app as Json | undefined)?.id;
    if (typeof id !== "string") throw new CopyError(`fixture ${path}: app.id is missing`);
    return { kind: "app", id, bundle };
  }
  if (bundle.format === PAGE_BUNDLE_FORMAT) {
    const page = bundle.page as PageBundle["page"] | undefined;
    if (!page?.title || !page.contentType || typeof page.body !== "string") {
      throw new CopyError(`fixture ${path}: page needs title, contentType and body`);
    }
    const id = page.id ?? page.slug ?? "fixture";
    return {
      kind: "page",
      id,
      bundle: { ...(bundle as PageBundle), kv: bundle.kv ?? [] } as PageBundle,
    };
  }
  throw new CopyError(
    `fixture ${path}: format must be ${APP_BUNDLE_FORMAT} or ${PAGE_BUNDLE_FORMAT}`,
  );
}

/**
 * Boot `src/http.ts` on a fresh SQLite file in `stateDir`, on a free loopback port, with a new
 * random key. NODE_ENV=development: page cookies are SameSite=Lax on loopback. Integrations,
 * heartbeat and telemetry are off. The previous run's database in `stateDir` is deleted first.
 * shortcut: own spawn, not scripts/e2e/sut.ts startSut (that one carries coverage, Postgres and
 * fixture restores, and keeps state under /tmp); merge them if a third caller appears.
 */
export async function bootLocalApi(stateDir: string, repoRoot: string): Promise<LocalApi> {
  const dbPath = resolve(stateDir, "api.sqlite");
  const homeDir = resolve(stateDir, "home");
  const fsDir = resolve(stateDir, "fs");
  const logPath = resolve(stateDir, "api.log");
  const keyPath = resolve(stateDir, "secrets.key");
  const apiKeyFile = resolve(stateDir, "api-key");
  for (const path of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`, fsDir, homeDir]) {
    await rm(path, { recursive: true, force: true });
  }
  await mkdir(homeDir, { recursive: true });
  await mkdir(fsDir, { recursive: true });
  const apiKey = randomBytes(16).toString("hex");
  await Bun.write(keyPath, randomBytes(32).toString("base64"));
  // The key file lets the caller drive the local API (PUT a page body, run an action).
  await Bun.write(apiKeyFile, `${apiKey}\n`);
  await chmod(apiKeyFile, 0o600);
  await chmod(keyPath, 0o600);

  const port = await reservedPort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const log = Bun.file(logPath).writer();
  const child = Bun.spawn(["bun", "--no-orphans", "run", "src/http.ts"], {
    cwd: repoRoot,
    env: {
      ...minimalEnv(),
      HOME: homeDir,
      PORT: String(port),
      API_KEY: apiKey,
      AGENT_SWARM_API_KEY: apiKey,
      MCP_BASE_URL: baseUrl,
      DATABASE_PATH: dbPath,
      AGENT_FS_LOCAL_DIR: fsDir,
      SECRETS_ENCRYPTION_KEY_FILE: keyPath,
      NODE_ENV: "development",
      // Bypasses the dashboard's version gates, as the UI e2e harness does.
      SWARM_DEV_MODE: "true",
      // The copy registers a plain owner agent for pages, with no runtime instance.
      MULTI_RUNTIME_ENABLED: "false",
      SLACK_DISABLE: "true",
      GITHUB_DISABLE: "true",
      LINEAR_DISABLE: "true",
      JIRA_DISABLE: "true",
      AGENTMAIL_DISABLE: "true",
      HEARTBEAT_DISABLE: "true",
      HEARTBEAT_CHECKLIST_DISABLE: "true",
      OAUTH_KEEPALIVE_DISABLE: "true",
      ANONYMIZED_TELEMETRY: "false",
      DESPLEGA_TELEMETRY_ENV: "test",
    },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const drain = async (stream: ReadableStream<Uint8Array>) => {
    for await (const chunk of stream) log.write(chunk);
  };
  const drains = Promise.all([drain(child.stdout), drain(child.stderr)]).finally(() => log.end());

  const stop = async () => {
    if (child.exitCode === null) {
      child.kill("SIGTERM");
      const timer = setTimeout(() => child.kill("SIGKILL"), 5_000);
      await child.exited;
      clearTimeout(timer);
    }
    await drains.catch(() => {});
  };

  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline && child.exitCode === null) {
    const ok = await fetch(`${baseUrl}/health`).then(
      (res) => res.status === 200,
      () => false,
    );
    if (ok) return { baseUrl, apiKey, apiKeyFile, logPath, stop };
    await Bun.sleep(250);
  }
  log.flush();
  await stop();
  throw new CopyError(
    `local API did not become healthy within 60 s (log ${logPath})\n${await tailLog(logPath, 30)}`,
  );
}

async function call(
  base: string,
  key: string,
  method: string,
  path: string,
  options: { body?: unknown; headers?: Record<string, string>; ok?: number[] } = {},
): Promise<{ status: number; json: Json; headers: Headers }> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${key}`,
      ...(options.body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...options.headers,
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await res.text();
  let json: Json = {};
  try {
    json = text ? (JSON.parse(text) as Json) : {};
  } catch {}
  if (!(options.ok ?? [200]).includes(res.status)) {
    throw new CopyError(`${method} ${base}${path}: HTTP ${res.status} ${text.slice(0, 400)}`);
  }
  return { status: res.status, json, headers: res.headers };
}

export type Source = { apiUrl: string; apiKey: string };

/** Export the app from the source API: every row, and the scripts its actions use. */
export async function exportApp(source: Source, appId: string): Promise<Json> {
  const { json } = await call(
    source.apiUrl,
    source.apiKey,
    "GET",
    `/api/apps/${encodeURIComponent(appId)}/export`,
  );
  return json;
}

/** The page record and its KV namespace (`task:page:<id>`) from the source API. */
export async function exportPage(source: Source, pageId: string): Promise<PageBundle> {
  const { json: page } = await call(
    source.apiUrl,
    source.apiKey,
    "GET",
    `/api/pages/${encodeURIComponent(pageId)}`,
  );
  const kv: PageBundle["kv"] = [];
  const ns = encodeURIComponent(`task:page:${pageId}`);
  for (let offset = 0; ; offset += KV_PAGE) {
    const { json } = await call(
      source.apiUrl,
      source.apiKey,
      "GET",
      `/api/kv/_/${ns}?limit=${KV_PAGE}&offset=${offset}`,
    );
    const entries = (json.entries ?? []) as PageBundle["kv"];
    kv.push(...entries);
    if (entries.length < KV_PAGE) break;
  }
  return {
    format: PAGE_BUNDLE_FORMAT,
    page: page as unknown as PageBundle["page"],
    kv,
  };
}

/** The dashboard user and the agent that owns copied pages, on the local API. */
export async function createLocalIdentity(
  api: LocalApi,
  user: { email: string; name?: string },
): Promise<{ agentId: string; userId: string }> {
  const created = await call(api.baseUrl, api.apiKey, "POST", "/api/users", {
    body: { name: user.name ?? user.email.split("@")[0], email: user.email, status: "active" },
    ok: [200, 201],
  });
  const agent = await call(api.baseUrl, api.apiKey, "POST", "/api/agents", {
    body: { name: "ui-dev", role: "worker", status: "online" },
    ok: [200, 201],
  });
  const userId = String((created.json.user as Json | undefined)?.id);
  return { agentId: String(agent.json.id), userId };
}

/** Import an app bundle under its own id. Returns the import's warnings. */
export async function importApp(api: LocalApi, bundle: Json, agentId: string): Promise<string[]> {
  // As the local agent: its action scripts land in that agent's scope, and a script action
  // runs as its owning agent (a global script has none).
  const { json } = await call(api.baseUrl, api.apiKey, "POST", "/api/apps/import?keepId=1", {
    headers: { "X-Agent-ID": agentId },
    body: bundle,
    ok: [201],
  });
  return ((json.warnings ?? []) as unknown[]).map(String);
}

/**
 * Create the page on the local API and write its KV entries. A page's namespace takes writes
 * only through the page proxy, so the copy launches a page session and writes as the page.
 */
export async function importPage(
  api: LocalApi,
  bundle: PageBundle,
  owner: { agentId: string; userId: string },
): Promise<{ id: string; warnings: string[] }> {
  const { page } = bundle;
  const warnings: string[] = [];
  let authMode = page.authMode ?? "authed";
  if (authMode === "password") {
    warnings.push("the page password is not readable through the API: the local copy is authed");
    authMode = "authed";
  }
  // A page that calls swarm APIs other than its own KV sees an empty local swarm.
  if (/@swarm\/api\/(?!kv\b)|swarmSdk\.(?!kv\b)\w/.test(page.body)) {
    warnings.push("page reads swarm APIs; local data is empty");
  }
  const created = await call(api.baseUrl, api.apiKey, "POST", "/api/pages", {
    headers: { "X-Agent-ID": owner.agentId },
    body: {
      ...(page.slug ? { slug: page.slug } : {}),
      title: page.title,
      ...(page.description ? { description: page.description } : {}),
      contentType: page.contentType,
      authMode,
      body: page.body,
      ...(page.theme ? { theme: page.theme } : {}),
      ...(page.themeTokens ? { themeTokens: page.themeTokens } : {}),
      ...(page.designVersion ? { designVersion: page.designVersion } : {}),
    },
    ok: [201],
  });
  const id = String(created.json.id);

  const now = Date.now();
  const live = bundle.kv.filter((entry) => !entry.expiresAt || entry.expiresAt > now);
  if (live.length === 0) return { id, warnings };
  const launch = await call(api.baseUrl, api.apiKey, "POST", `/api/pages/${id}/launch`, {
    headers: { "X-Swarm-User-Id": owner.userId },
    ok: [204],
  });
  const cookie = launch.headers
    .getSetCookie()
    .map((line) => line.split(";")[0])
    .join("; ");
  for (const entry of live) {
    // The page proxy refuses an encoded `/` in a path segment.
    if (entry.key.includes("/")) {
      warnings.push(`KV key ${entry.key} has a "/": not copied`);
      continue;
    }
    await call(api.baseUrl, api.apiKey, "PUT", `/@swarm/api/kv/${encodeURIComponent(entry.key)}`, {
      headers: { Cookie: cookie, "X-Swarm-Page-Id": id },
      body: {
        value: entry.value,
        ...(entry.valueType ? { valueType: entry.valueType } : {}),
        ...(entry.expiresAt
          ? { expiresInSec: Math.max(1, Math.ceil((entry.expiresAt - now) / 1000)) }
          : {}),
      },
    });
  }
  return { id, warnings };
}
