/**
 * Canary sweep: the end-to-end proof for the secret-leak hardening.
 *
 * Three canaries with no recognisable token shape are registered the three
 * ways the API learns a secret: a sensitive env var, a runtime
 * `registerVolatileSecret`, and an encrypted swarm_config row that the secret
 * registry decrypts. No structural rule can match them (the first control
 * proves it), so a clean sweep proves the scrubber's known-value matcher
 * reaches every writer. A fourth, `ghp_`-shaped canary covers the structural
 * rules.
 *
 * The canaries go through real write paths in-process. Then the sweep scans
 * every column of every table, the captured console and stdout/stderr, the
 * captured Slack API payloads, and the HTTP error bodies. It looks for each
 * canary raw, JSON-escaped, shell-escaped, base64 and URL-encoded.
 *
 * Verdicts come from `.text-columns.json`. A hit in an `exempt` column is
 * skipped. A hit in any other column fails (`scrubbed`, `sealed`, `pending`,
 * unclassified or non-TEXT). There are no known open leaks.
 *
 * Executable source is exempt because its writers refuse a secret-bearing
 * source outright, so canaries reach scripts through args only, and a
 * dedicated case proves a canary in source is refused and nothing persists.
 *
 * Every secret is built at runtime from random bytes. Never a literal.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { format } from "node:util";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { webApi } from "@slack/bolt";
import { listTextColumns, type TextColumnClassification } from "../../scripts/check-text-columns";
import {
  cancelTask,
  closeDb,
  createAgent,
  createApprovalRequest,
  createChannel,
  createTaskExtended,
  createWorkflow,
  getDb,
  getResolvedConfig,
  getTaskById,
  getWorkflowRun,
  initDb,
  resolveApprovalRequest,
  startTask,
  upsertSwarmConfig,
} from "../be/db";
import { createTrackerSync } from "../be/db-queries/tracker";
import { getEmbeddingProvider } from "../be/memory";
import { setScriptEmbeddingProviderForTests } from "../be/scripts/embeddings";
import { loadSecretRegistry } from "../be/secret-registry";
import { handleAssets } from "../http/assets";
import { handleCore } from "../http/core";
import { handleEvents } from "../http/events";
import { handleScriptRuns } from "../http/script-runs";
import { handleScripts } from "../http/scripts";
import { getPathSegments, parseQueryParams, writeUnhandledError } from "../http/utils";
import { initJiraOutboundSync, teardownJiraOutboundSync } from "../jira/outbound";
import { initLinearOutboundSync, teardownLinearOutboundSync } from "../linear/outbound";
import { installSlackEgressScrub } from "../slack/egress-scrub";
import { slackContextKey } from "../tasks/context-key";
import { registerMemoryStoreTool } from "../tools/memory-store";
import { registerSlackPostTool } from "../tools/slack-post";
import { registerSlackReplyTool } from "../tools/slack-reply";
import { registerStoreProgressTool } from "../tools/store-progress";
import { installConsoleScrub, uninstallConsoleScrub } from "../utils/console-scrub";
import {
  clearVolatileSecretsForTesting,
  refreshSecretScrubberCache,
  registerVolatileSecret,
  scrubSecrets,
} from "../utils/secret-scrubber";
import { getExecutorRegistry, startWorkflowExecution } from "../workflows";
import { SKIP_SANDBOX_SPAWN_TESTS } from "./sandbox-spawn-test-helpers";
import { randomToken } from "./synthetic-secret-helpers";
import { listenOnFreePort } from "./test-net";

// ─── Slack: tools and the notify executor read the app via getSlackApp ──────
// Point it at a real WebClient aimed at a local fake Slack API, so the
// client-level egress scrub is on the path. Falls back to the real getter
// once this file is done.
const realSlackAppModule = { ...(await import("../slack/app")) };
const realGetSlackApp = realSlackAppModule.getSlackApp;
let fakeSlackApp: { client: InstanceType<typeof webApi.WebClient> } | null = null;
mock.module("../slack/app", () => ({
  ...realSlackAppModule,
  getSlackApp: () => fakeSlackApp ?? realGetSlackApp(),
}));

// ─── Linear and Jira: capture what the outbound sync would send ─────────────
// Captured at the transport client, after every scrub in the outbound path.
const trackerCapture: { sink: string; body: string }[] = [];
const realLinearClientModule = { ...(await import("../linear/client")) };
mock.module("../linear/client", () => ({
  ...realLinearClientModule,
  getLinearClient: async () => ({
    createComment: async (input: unknown) => {
      trackerCapture.push({ sink: "linear createComment", body: JSON.stringify(input) });
      return { success: true };
    },
  }),
  resetLinearClient: () => {},
}));
const realJiraClientModule = { ...(await import("../jira/client")) };
mock.module("../jira/client", () => ({
  ...realJiraClientModule,
  jiraFetch: async (path: string, init?: RequestInit) => {
    trackerCapture.push({ sink: `jira ${path}`, body: String(init?.body ?? "") });
    return Response.json({});
  },
}));

// ─── Canaries ────────────────────────────────────────────────────────────────

/**
 * Random alphanumerics joined by `/`, `+`, `"` and `=`, so the JSON, shell,
 * base64 and URL-encoded forms all differ from the raw value. No vendor
 * prefix and no keyword: nothing but an exact-value match can catch it.
 */
function shapelessCanary(): string {
  return `${randomToken(10)}/${randomToken(10)}+${randomToken(6)}"${randomToken(6)}=`;
}

const CANARY = {
  env: shapelessCanary(),
  volatile: shapelessCanary(),
  config: shapelessCanary(),
  pattern: ["ghp", randomToken(36)].join("_"),
} as const;
type CanaryName = keyof typeof CANARY;

const ENV_KEY = "CANARY_SWEEP_PROBE_TOKEN";
const VOLATILE_NAME = "CANARY_SWEEP_VOLATILE";
const CONFIG_KEY = "CANARY_SWEEP_PROBE";
const MARKERS: Record<Exclude<CanaryName, "pattern">, string> = {
  env: `[REDACTED:${ENV_KEY}]`,
  volatile: `[REDACTED:${VOLATILE_NAME}]`,
  config: `[REDACTED:config:${CONFIG_KEY}]`,
};

/** Free text carrying every canary, plus the config canary's encoded forms. */
function payload(label: string): string {
  return [
    label,
    `alpha ${CANARY.env}`,
    `bravo ${CANARY.volatile}`,
    `charlie ${CANARY.config}`,
    `delta ${Buffer.from(CANARY.config).toString("base64")}`,
    `echo ${encodeURIComponent(CANARY.config)}`,
    `foxtrot ${CANARY.pattern}`,
    "end",
  ].join(" ");
}

// ─── Scanner ─────────────────────────────────────────────────────────────────
// Computed here, independently of the production registry, so a bug in
// `encodedForms` cannot hide a leak from the instrument that checks it.

function jsonEscaped(value: string): string {
  return JSON.stringify(value).slice(1, -1);
}

/** Base64 text that encodes `value` at each byte offset mod 3 inside a larger blob. */
function base64Forms(value: string): Record<string, string> {
  const bytes = Buffer.from(value, "utf8");
  const forms: Record<string, string> = { base64: bytes.toString("base64") };
  for (const offset of [0, 1, 2]) {
    const shifted = Buffer.concat([Buffer.alloc(offset), bytes]);
    const skip = offset === 0 ? 0 : offset + 1;
    const end = Math.floor(shifted.length / 3) * 4;
    forms[`base64@${offset}`] = shifted.toString("base64").slice(skip, end);
  }
  for (const [name, form] of Object.entries({ ...forms })) {
    forms[`${name}url`] = form.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }
  return forms;
}

function formsOf(value: string): Record<string, string> {
  const shellDouble = value.replace(/[\\$"`]/g, "\\$&");
  const shellSingle = value.replaceAll("'", "'\\''");
  const all: Record<string, string> = {
    raw: value,
    json: jsonEscaped(value),
    jsonTwice: jsonEscaped(jsonEscaped(value)),
    shellDouble,
    shellSingle,
    jsonShellDouble: jsonEscaped(shellDouble),
    ...base64Forms(value),
    url: encodeURIComponent(value),
    form: new URLSearchParams({ v: value }).toString().slice(2),
  };
  // Keep one name per distinct string.
  const seen = new Set<string>();
  return Object.fromEntries(
    Object.entries(all).filter(([, form]) => {
      if (seen.has(form)) return false;
      seen.add(form);
      return true;
    }),
  );
}

type Needle = { canary: CanaryName; form: string; value: string };
const NEEDLES: Needle[] = (Object.entries(CANARY) as [CanaryName, string][]).flatMap(
  ([canary, value]) =>
    Object.entries(formsOf(value)).map(([form, encoded]) => ({ canary, form, value: encoded })),
);

function needlesIn(text: string): Needle[] {
  return NEEDLES.filter((needle) => text.includes(needle.value));
}

const CONTROL_TABLE = "canary_sweep_scanner_control";

type ColumnClass = "scrubbed" | "sealed" | "exempt" | "pending" | "unclassified" | "untyped";

interface DbScan {
  /** `table.column` → canary/form hits. */
  hits: Map<string, Set<string>>;
  /** Marker strings seen anywhere in the DB. */
  text: string[];
}

/**
 * Scan every column of every table, not only TEXT-affinity ones: an untyped
 * or BLOB column holding a canary is as much a leak. Virtual tables that
 * cannot be read directly are skipped; their shadow tables are real tables
 * and are scanned.
 */
function scanDb(): DbScan {
  const db = getDb();
  const tables = db
    .query<{ name: string; sql: string | null }, []>(
      "SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .all();
  const hits = new Map<string, Set<string>>();
  const text: string[] = [];
  for (const { name, sql } of tables) {
    let rows: Record<string, unknown>[];
    try {
      rows = db.query<Record<string, unknown>, []>(`SELECT * FROM "${name}"`).all();
    } catch (error) {
      if (sql?.toUpperCase().startsWith("CREATE VIRTUAL TABLE")) continue;
      throw error;
    }
    for (const row of rows) {
      for (const [column, value] of Object.entries(row)) {
        const asText =
          typeof value === "string"
            ? value
            : value instanceof Uint8Array
              ? Buffer.from(value).toString("utf8")
              : null;
        if (!asText) continue;
        if (asText.includes("[REDACTED:")) text.push(asText);
        for (const needle of needlesIn(asText)) {
          const id = `${name}.${column}`;
          const set = hits.get(id) ?? new Set<string>();
          set.add(`${needle.canary}/${needle.form}`);
          hits.set(id, set);
        }
      }
    }
  }
  return { hits, text };
}

const classification = (await Bun.file(
  join(import.meta.dir, "..", "..", ".text-columns.json"),
).json()) as TextColumnClassification;

function classOf(id: string, textColumns: Set<string>): ColumnClass {
  if (!textColumns.has(id)) return "untyped";
  const [table, column] = id.split(".", 2) as [string, string];
  const entry = classification[table]?.[column];
  if (entry === undefined) return "unclassified";
  if (entry === "scrubbed") return "scrubbed";
  if ("sealed" in entry) return "sealed";
  return "exempt" in entry ? "exempt" : "pending";
}

// ─── Captured egress ─────────────────────────────────────────────────────────

type StreamEntry = { stream: string; text: string };
const streamCapture: StreamEntry[] = [];
const slackCapture: { method: string; body: string }[] = [];
const httpErrorBodies: { path: string; status: number; body: string }[] = [];

const CONSOLE_METHODS = ["log", "info", "warn", "error", "debug"] as const;
type ConsoleMethod = (typeof CONSOLE_METHODS)[number];
const savedConsole = Object.fromEntries(
  CONSOLE_METHODS.map((method) => [method, console[method]]),
) as Record<ConsoleMethod, (...args: unknown[]) => void>;
const savedStdoutWrite = process.stdout.write;
const savedStderrWrite = process.stderr.write;

function captureStream(stream: "stdout" | "stderr"): typeof process.stdout.write {
  return ((chunk: string | Uint8Array, ...rest: unknown[]) => {
    streamCapture.push({
      stream,
      text: typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"),
    });
    const callback = rest.find((arg) => typeof arg === "function") as (() => void) | undefined;
    callback?.();
    return true;
  }) as typeof process.stdout.write;
}

/**
 * Stand-ins for the underlying writers. The console scrub, once installed,
 * wraps these exactly as it wraps the native methods at API boot.
 */
function installStreamCapture(): void {
  for (const method of CONSOLE_METHODS) {
    console[method] = (...args: unknown[]) => {
      streamCapture.push({ stream: `console.${method}`, text: format(...args) });
    };
  }
  process.stdout.write = captureStream("stdout");
  process.stderr.write = captureStream("stderr");
}

function restoreStreams(): void {
  uninstallConsoleScrub();
  for (const method of CONSOLE_METHODS) console[method] = savedConsole[method];
  process.stdout.write = savedStdoutWrite;
  process.stderr.write = savedStderrWrite;
}

// ─── Fixture ─────────────────────────────────────────────────────────────────

const API_KEY = `canary-sweep-api-key-${randomToken(24)}`;
let tempDir: string;
let savedEnv: NodeJS.ProcessEnv;
let slackServer: ReturnType<typeof Bun.serve>;
let httpServer: Server;
let baseUrl = "";
let leadId: string;
let workerId: string;

async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const agentId = req.headers["x-agent-id"] as string | undefined;
  if (await handleCore(req, res, agentId, API_KEY)) return;
  const pathSegments = getPathSegments(req.url || "");
  const queryParams = parseQueryParams(req.url || "");
  for (const handler of [handleEvents, handleScriptRuns, handleScripts, handleAssets]) {
    if (await handler(req, res, pathSegments, queryParams, agentId)) return;
  }
  res.writeHead(404);
  res.end("Not Found");
}

async function api(
  path: string,
  init: RequestInit = {},
): Promise<{ status: number; body: string }> {
  const res = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      "X-Agent-ID": workerId,
      "Content-Type": "application/json",
      ...((init.headers as Record<string, string>) ?? {}),
    },
  });
  const body = await res.text();
  if (res.status >= 400) httpErrorBodies.push({ path, status: res.status, body });
  return { status: res.status, body };
}

type ToolResult = { isError?: boolean; structuredContent?: Record<string, unknown> };
type RegisteredTool = {
  inputSchema: { parse: (args: unknown) => unknown };
  handler: (args: unknown, extra: unknown) => Promise<ToolResult>;
};

function mcpTool(register: (server: McpServer) => void, name: string) {
  const server = new McpServer({ name: "canary-sweep", version: "1.0.0" });
  register(server);
  const tool = (server as unknown as { _registeredTools: Record<string, RegisteredTool> })
    ._registeredTools[name];
  if (!tool) throw new Error(`${name} not registered`);
  return (args: unknown, agentId: string, sourceTaskId?: string) =>
    tool.handler(tool.inputSchema.parse(args), {
      sessionId: "canary-sweep-session",
      requestInfo: {
        headers: {
          "x-agent-id": agentId,
          ...(sourceTaskId ? { "x-source-task-id": sourceTaskId } : {}),
        },
      },
    });
}

/** The test preload clears volatile secrets after every test: re-arm both runtime channels. */
async function armCanaries(): Promise<void> {
  registerVolatileSecret(CANARY.volatile, VOLATILE_NAME);
  const loaded = await loadSecretRegistry();
  expect(loaded.failed).toBe(0);
  expect(loaded.config).toBeGreaterThanOrEqual(1);
}

async function waitForRun(id: string): Promise<{ status: string; error?: string }> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const { body } = await api(`/api/script-runs/${id}`);
    const run = (JSON.parse(body) as { run: { status: string; error?: string } }).run;
    if (["completed", "failed", "cancelled", "aborted_limit"].includes(run.status)) return run;
    await Bun.sleep(200);
  }
  throw new Error(`script run ${id} did not finish`);
}

beforeAll(async () => {
  savedEnv = { ...process.env };
  tempDir = mkdtempSync(join(tmpdir(), "secret-canary-sweep-"));
  initDb(join(tempDir, "sweep.sqlite"));

  process.env.EMBEDDING_API_KEY = "";
  process.env.OPENAI_API_KEY = "";
  process.env.AGENT_SWARM_API_KEY = API_KEY;
  process.env.API_KEY = API_KEY;
  process.env.APP_URL = "https://app.example.test";
  process.env[ENV_KEY] = CANARY.env;
  refreshSecretScrubberCache();
  spyOn(getEmbeddingProvider(), "embed").mockImplementation(async () => null);
  setScriptEmbeddingProviderForTests({
    name: "test/canary-sweep",
    dimensions: 4,
    embed: async () => new Float32Array([1, 0, 0, 0]),
    embedBatch: async (texts: string[]) => texts.map(() => new Float32Array([1, 0, 0, 0])),
  });

  leadId = (await createAgent({ name: "canary-lead", isLead: true, status: "idle" })).id;
  workerId = (await createAgent({ name: "canary-worker", isLead: false, status: "idle" })).id;

  // The config canary goes in through the real encrypted write path.
  await upsertSwarmConfig({
    scope: "agent",
    scopeId: workerId,
    key: CONFIG_KEY,
    value: CANARY.config,
    isSecret: true,
  });

  // Fake Slack API. The egress scrub patches the WebClient prototype, so it
  // must be installed before the client is built.
  installSlackEgressScrub();
  slackServer = Bun.serve({
    port: 0,
    async fetch(req) {
      const { pathname } = new URL(req.url);
      const body = await req.text();
      const method = pathname.replace(/^\/api\//, "");
      slackCapture.push({ method, body });
      return Response.json({ ok: true, ts: `${Date.now() / 1000}`, channel: "C_CANARY" });
    },
  });
  fakeSlackApp = {
    client: new webApi.WebClient("xoxb-canary-sweep", {
      slackApiUrl: `http://localhost:${slackServer.port}/api/`,
      retryConfig: { retries: 0 },
    }),
  };

  // In-process API for the HTTP paths and the durable script harness.
  if (!SKIP_SANDBOX_SPAWN_TESTS) {
    const runtimeDir = join(tempDir, "script-workflow-runtime");
    await Bun.$`bun build ./src/script-workflows/harness.ts --target bun --no-splitting --outfile ${runtimeDir}/harness.bundle.js`
      .cwd(join(import.meta.dir, "..", ".."))
      .quiet();
    process.env.SCRIPT_WORKFLOW_RUNTIME_DIR = runtimeDir;
  }
  delete process.env.SCRIPT_RUN_SUPERVISOR_DISABLE;
  delete process.env.PUBLIC_MCP_BASE_URL;
  httpServer = createServer((req, res) => {
    // The API's own top-level 500 writer, so a throwing route's body is swept too.
    route(req, res).catch((err) => writeUnhandledError(res, err, req));
  });
  baseUrl = `http://127.0.0.1:${await listenOnFreePort(httpServer, "127.0.0.1")}`;
  process.env.MCP_BASE_URL = baseUrl;
  refreshSecretScrubberCache();

  installStreamCapture();
}, 60_000);

beforeEach(armCanaries);

afterAll(async () => {
  restoreStreams();
  fakeSlackApp = null;
  setScriptEmbeddingProviderForTests(null);
  await new Promise<void>((resolve) => httpServer?.close(() => resolve()) ?? resolve());
  slackServer?.stop(true);
  closeDb();
  for (const key of Object.keys(process.env)) {
    if (!(key in savedEnv)) delete process.env[key];
  }
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  clearVolatileSecretsForTesting();
  refreshSecretScrubberCache();
  rmSync(tempDir, { recursive: true, force: true });
});

// ─── Positive controls first ─────────────────────────────────────────────────

describe("positive controls", () => {
  test("the config canary reads back decrypted, is stored encrypted, and only the registry redacts it", async () => {
    const resolved = await getResolvedConfig(workerId);
    expect(resolved.find((row) => row.key === CONFIG_KEY)?.value).toBe(CANARY.config);
    const stored = getDb()
      .query<{ value: string }, [string]>("SELECT value FROM swarm_config WHERE key = ?")
      .get(CONFIG_KEY);
    expect(stored?.value).toBeString();
    expect(needlesIn(stored?.value ?? "")).toEqual([]);

    const wrap = (value: string) => `alpha ${value} omega`;
    // No channel registered: no structural rule matches a shapeless canary.
    delete process.env[ENV_KEY];
    clearVolatileSecretsForTesting();
    try {
      for (const value of [CANARY.env, CANARY.volatile, CANARY.config]) {
        expect(scrubSecrets(wrap(value))).toBe(wrap(value));
      }
    } finally {
      process.env[ENV_KEY] = CANARY.env;
      refreshSecretScrubberCache();
    }
    // Each channel alone redacts its own canary, under its own marker.
    expect(scrubSecrets(wrap(CANARY.env))).toBe(wrap(MARKERS.env));
    registerVolatileSecret(CANARY.volatile, VOLATILE_NAME);
    expect(scrubSecrets(wrap(CANARY.volatile))).toBe(wrap(MARKERS.volatile));
    expect(scrubSecrets(wrap(CANARY.config))).toBe(wrap(CANARY.config));
    await loadSecretRegistry();
    expect(scrubSecrets(wrap(CANARY.config))).toBe(wrap(MARKERS.config));
    const base64 = Buffer.from(CANARY.config).toString("base64");
    expect(scrubSecrets(wrap(base64))).toBe(wrap(MARKERS.config));
  });

  test("the scanner finds every encoded form in an unscrubbed scratch table", () => {
    const db = getDb();
    db.run(`CREATE TABLE IF NOT EXISTS ${CONTROL_TABLE} (id INTEGER PRIMARY KEY, body TEXT)`);
    db.run(`DELETE FROM ${CONTROL_TABLE}`);
    const insert = db.prepare(`INSERT INTO ${CONTROL_TABLE} (body) VALUES (?)`);
    for (const needle of NEEDLES) insert.run(`seeded ${needle.value} by the control`);

    const scan = scanDb();
    const found = scan.hits.get(`${CONTROL_TABLE}.body`) ?? new Set<string>();
    expect([...found].sort()).toEqual(NEEDLES.map((n) => `${n.canary}/${n.form}`).sort());
    // Every canary has more than a raw form, so the encoded checks are live.
    for (const canary of Object.keys(CANARY)) {
      expect(NEEDLES.filter((n) => n.canary === canary).length).toBeGreaterThan(5);
    }
  });

  test("the scanner sees the canary in captured stdout before the console scrub and via a raw stream write", () => {
    streamCapture.length = 0;
    console.log("pre-scrub line", CANARY.volatile);
    expect(streamCapture.flatMap((e) => needlesIn(e.text)).map((n) => n.canary)).toContain(
      "volatile",
    );

    installConsoleScrub();
    streamCapture.length = 0;
    console.log("post-scrub line", CANARY.volatile);
    expect(streamCapture.flatMap((e) => needlesIn(e.text))).toEqual([]);
    expect(streamCapture.at(-1)?.text).toContain(MARKERS.volatile);

    process.stderr.write(`raw write ${CANARY.env}\n`);
    expect(streamCapture.at(-1)?.stream).toBe("stderr");
    expect(needlesIn(streamCapture.at(-1)?.text ?? "").map((n) => n.canary)).toContain("env");
    streamCapture.length = 0;
  });
});

// ─── Drive ───────────────────────────────────────────────────────────────────

const driven: string[] = [];

describe("drive every write path", () => {
  test("store-progress (progress, complete, fail) and cancelTask", async () => {
    installConsoleScrub();
    const storeProgress = mcpTool(registerStoreProgressTool, "store-progress");

    const done = await createTaskExtended(payload("task brief"), {
      agentId: workerId,
      source: "mcp",
    });
    await startTask(done.id);
    const progress = await storeProgress(
      { taskId: done.id, progress: payload("progress") },
      workerId,
    );
    expect(progress.isError).toBeFalsy();
    const completed = await storeProgress(
      { taskId: done.id, status: "completed", output: payload("output") },
      workerId,
    );
    expect(completed.isError).toBeFalsy();
    expect((await getTaskById(done.id))?.status).toBe("completed");

    const failed = await createTaskExtended("canary failing task", {
      agentId: workerId,
      source: "mcp",
    });
    await startTask(failed.id);
    const failResult = await storeProgress(
      { taskId: failed.id, status: "failed", failureReason: payload("failure") },
      workerId,
    );
    expect(failResult.isError).toBeFalsy();
    expect((await getTaskById(failed.id))?.status).toBe("failed");

    const cancelled = await createTaskExtended("canary cancelled task", {
      agentId: workerId,
      source: "mcp",
    });
    expect(await cancelTask(cancelled.id, payload("cancel reason"))).not.toBeNull();
    driven.push("store-progress", "cancelTask");
  });

  test("memory-store", async () => {
    const memoryStore = mcpTool(registerMemoryStoreTool, "memory-store");
    const result = await memoryStore(
      {
        content: payload("memory content"),
        name: `memory alpha ${CANARY.env} bravo ${CANARY.volatile} charlie ${CANARY.config} foxtrot ${CANARY.pattern}`,
        scope: "agent",
        tags: [payload("tag")],
        intent: "canary sweep",
      },
      workerId,
    );
    expect(result.structuredContent?.success).toBe(true);
    driven.push("memory-store");
  });

  test("POST /api/events/batch", async () => {
    const sessionId = crypto.randomUUID();
    const { status } = await api("/api/events/batch", {
      method: "POST",
      body: JSON.stringify({
        events: [
          {
            category: "tool",
            event: "tool.start",
            source: "worker",
            sessionId,
            data: { input: payload("event input"), nested: { lines: [payload("event line")] } },
          },
        ],
      }),
    });
    expect(status).toBe(201);
    driven.push("events/batch");
  });

  test("jsonError path echoes request text (GET /api/assets?types=...)", async () => {
    const { status, body } = await api(
      `/api/assets?types=${encodeURIComponent(payload("asset type"))}`,
    );
    expect(status).toBe(400);
    expect(body).toContain("Invalid asset entity type");
    expect(body).toContain("[REDACTED:");
    driven.push("jsonError");
  });

  test.skipIf(SKIP_SANDBOX_SPAWN_TESTS)(
    "inline script run (success and failure, real sandbox subprocess)",
    async () => {
      const ok = await api("/api/scripts/run", {
        method: "POST",
        body: JSON.stringify({
          source: `export default async (args) => { console.log("inline saw", args.note); return { note: args.note }; };`,
          args: { note: payload("inline args") },
          intent: "canary sweep inline ok",
        }),
      });
      expect(ok.status).toBe(200);
      const failed = await api("/api/scripts/run", {
        method: "POST",
        body: JSON.stringify({
          source: `export default async (args) => { throw new Error("inline failed " + args.note); };`,
          args: { note: payload("inline failing args") },
          intent: "canary sweep inline failure",
        }),
      });
      expect(failed.status).toBe(200);
      driven.push("inline script run");
    },
    60_000,
  );

  test.skipIf(SKIP_SANDBOX_SPAWN_TESTS)(
    "durable script run with a journaled step (real harness subprocess)",
    async () => {
      const source = `
        export default async function main(args, ctx) {
          const echoed = await ctx.step.swarmScript("echo", {
            source: "export default async (a) => ({ seen: a.note });",
            args: { note: args.note },
            intent: "canary-sweep-durable-step",
          });
          console.log("durable saw", args.note);
          return { note: args.note, echoed };
        }
      `;
      const created = await api("/api/script-runs", {
        method: "POST",
        body: JSON.stringify({ source, args: { note: payload("durable args") }, background: true }),
      });
      expect(created.status).toBe(201);
      const { id } = JSON.parse(created.body) as { id: string };
      const run = await waitForRun(id);
      expect(run.status).toBe("completed");
      driven.push("durable script run");
    },
    60_000,
  );

  test("a canary in script source is refused at upsert and inline run, and nothing persists", async () => {
    const db = getDb();
    const countRows = () =>
      ["scripts", "script_versions", "script_runs"].map(
        (table) => (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n,
      );
    const before = countRows();
    const expectedFinding: Record<CanaryName, string> = {
      env: ENV_KEY,
      volatile: VOLATILE_NAME,
      config: `config:${CONFIG_KEY}`,
      pattern: "github-pat",
    };
    for (const name of Object.keys(CANARY) as CanaryName[]) {
      const source = `const pasted = ${JSON.stringify(CANARY[name])};\nexport default async () => pasted.length;`;
      const attempts = [
        await api("/api/scripts/upsert", {
          method: "POST",
          body: JSON.stringify({
            name: `canary-source-${name}`,
            source,
            intent: "canary in source",
          }),
        }),
        await api("/api/scripts/run", {
          method: "POST",
          body: JSON.stringify({ source, args: {}, intent: "canary in inline source" }),
        }),
      ];
      for (const { status, body } of attempts) {
        expect(status).toBe(400);
        const refusal = JSON.parse(body) as { error: string; findings: { id: string }[] };
        expect(refusal.error).toBe("source_contains_secret");
        expect(refusal.findings.map((f) => f.id)).toContain(expectedFinding[name]);
        expect(needlesIn(body)).toEqual([]);
      }
    }
    expect(countRows()).toEqual(before);
    driven.push("refused source");
  });

  test("approval request (questions, votes and responses)", async () => {
    const id = crypto.randomUUID();
    await createApprovalRequest({
      id,
      title: payload("approval title"),
      questions: [{ id: "q1", type: "text", label: payload("approval question") }],
      approvers: { users: [], policy: "any" },
    });
    const responses = { q1: payload("approval response") };
    const resolved = await resolveApprovalRequest(id, {
      status: "approved",
      responses,
      approvals: [
        {
          responder: "operator",
          approved: true,
          responses,
          respondedAt: new Date().toISOString(),
        },
      ],
      resolutionReason: payload("approval reason"),
    });
    // The workflow resumes from the exact answer.
    expect(resolved?.responses).toEqual(responses);
    driven.push("approval");
  });

  test("Linear and Jira outbound comments for a completed task", async () => {
    const storeProgress = mcpTool(registerStoreProgressTool, "store-progress");
    initLinearOutboundSync();
    initJiraOutboundSync();
    try {
      for (const provider of ["linear", "jira"] as const) {
        const task = await createTaskExtended(payload(`${provider} task brief`), {
          agentId: workerId,
          source: "mcp",
        });
        await createTrackerSync({
          provider,
          entityType: "task",
          swarmId: task.id,
          externalId: provider === "linear" ? `LIN-${randomToken(6)}` : "10042",
          externalIdentifier: provider === "linear" ? "ENG-42" : "KAN-42",
          syncDirection: "bidirectional",
        });
        await startTask(task.id);
        const done = await storeProgress(
          { taskId: task.id, status: "completed", output: payload(`${provider} output`) },
          workerId,
        );
        expect(done.isError).toBeFalsy();
      }
      await Bun.sleep(100);
    } finally {
      teardownLinearOutboundSync();
      teardownJiraOutboundSync();
    }
    // Independent capture: both transports really received a comment.
    expect(trackerCapture.some((e) => e.sink === "linear createComment")).toBe(true);
    expect(trackerCapture.some((e) => e.sink.startsWith("jira /rest/api/2/issue/KAN-42"))).toBe(
      true,
    );
    driven.push("linear", "jira");
  });

  test("workflow run (notify to a swarm channel and to Slack)", async () => {
    const channel = await createChannel(`canary-sweep-${randomToken(8).toLowerCase()}`);
    const workflow = await createWorkflow({
      name: `canary-sweep-${crypto.randomUUID()}`,
      definition: {
        nodes: [
          {
            id: "announce",
            type: "notify",
            inputs: { note: "trigger.note" },
            config: { channel: "swarm", target: channel.id, template: "announce {{note}}" },
            next: "page",
          },
          {
            id: "page",
            type: "notify",
            inputs: { note: "trigger.note" },
            config: { channel: "slack", target: "C_CANARY", template: "page {{note}}" },
          },
        ],
      },
    });
    const runId = await startWorkflowExecution(
      workflow,
      { note: payload("workflow trigger") },
      getExecutorRegistry(),
    );
    const run = await getWorkflowRun(runId);
    expect(run?.status).toBe("completed");
    driven.push("workflow");
  });

  test("Slack tools (slack-post as lead, slack-reply on a Slack task)", async () => {
    const post = mcpTool(registerSlackPostTool, "slack-post");
    const posted = await post({ channelId: "C_CANARY", message: payload("slack post") }, leadId);
    expect(posted.isError).toBeFalsy();

    const contextKey = slackContextKey({ channelId: "C_CANARY", threadTs: "100.1" });
    const slackTask = await createTaskExtended("canary slack task", {
      agentId: workerId,
      source: "slack",
      slackChannelId: "C_CANARY",
      slackThreadTs: "100.1",
      contextKey,
    });
    const reply = mcpTool(registerSlackReplyTool, "slack-reply");
    const replied = await reply(
      { taskId: slackTask.id, message: payload("slack reply") },
      workerId,
      slackTask.id,
    );
    expect(replied.isError).toBeFalsy();
    expect(slackCapture.some((c) => c.method === "chat.postMessage")).toBe(true);
    driven.push("slack-post", "slack-reply");
  });

  test("console log of strings, objects and errors", () => {
    installConsoleScrub();
    console.log("plain", payload("console log"));
    console.warn({ nested: { value: payload("console object") } });
    console.error("failure:", new Error(payload("console error")));
    driven.push("console");
  });
});

// ─── Sweep ───────────────────────────────────────────────────────────────────

describe("sweep", () => {
  test("no canary in a scrubbed or unclassified column, the streams, Slack payloads or HTTP errors", async () => {
    // Let fire-and-forget follow-ups (terminal effects, event bus) land.
    await Bun.sleep(300);
    expect(driven.length).toBeGreaterThan(0);

    const scan = scanDb();
    const textColumns = new Set(listTextColumns(getDb()));

    // Intrinsic control: the same scan pass still sees the scratch table.
    expect(scan.hits.get(`${CONTROL_TABLE}.body`)?.size).toBe(NEEDLES.length);

    const failures: string[] = [];
    for (const [id, found] of scan.hits) {
      if (id.startsWith(`${CONTROL_TABLE}.`)) continue;
      const cls = classOf(id, textColumns);
      if (cls === "exempt") continue;
      failures.push(`${id} [${cls}] <- ${[...found].sort().join(", ")}`);
    }

    const egress: [string, string][] = [
      ...streamCapture.map((e): [string, string] => [e.stream, e.text]),
      ...slackCapture.flatMap(({ method, body }): [string, string][] => [
        [`slack ${method} body`, body],
        ...[...new URLSearchParams(body).entries()].map(([key, value]): [string, string] => [
          `slack ${method} ${key}`,
          value,
        ]),
      ]),
      ...httpErrorBodies.map((e): [string, string] => [`http ${e.status} ${e.path}`, e.body]),
      ...trackerCapture.map((e): [string, string] => [e.sink, e.body]),
    ];
    for (const [sink, text] of egress) {
      const found = needlesIn(text);
      if (found.length > 0) {
        failures.push(`${sink} <- ${found.map((n) => `${n.canary}/${n.form}`).join(", ")}`);
      }
    }

    expect(failures).toEqual([]);

    // The canaries really reached the sinks: each registration channel's
    // marker shows up at rest and in the Slack payloads.
    const atRest = scan.text.join("\n");
    const slackText = egress
      .filter(([sink]) => sink.startsWith("slack"))
      .map(([, t]) => t)
      .join("\n");
    for (const marker of Object.values(MARKERS)) {
      expect(atRest).toContain(marker);
      expect(slackText).toContain(marker);
    }
    expect(streamCapture.some((e) => e.text.includes(MARKERS.config))).toBe(true);
  });
});
