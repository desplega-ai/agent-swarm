import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  spyOn,
  test,
} from "bun:test";
import { unlink } from "node:fs/promises";
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { type ModelDef, parseAppDefinition } from "../apps/definition";
import * as rowStore from "../apps/row-store";
import {
  type AppRow,
  createAppRow,
  listAppRows,
  patchAppRow,
  withMutationLock,
} from "../apps/row-store";
import { createApp, getApp, updateApp } from "../apps/store";
import { getAppSyncStatus, runAppSync, type SyncPassResult } from "../apps/sync";
import {
  closeDb,
  createAgent,
  createTaskExtended,
  createUser,
  getDb,
  getKv,
  initDb,
} from "../be/db";
import { upsertScriptConnection } from "../be/script-connections";
import { buildScriptCredentialBindingsWithFailures } from "../be/script-credential-broker";
import { upsertScriptByName } from "../be/scripts/db";
import { typecheckScript } from "../be/scripts/typecheck";
import { SEED_SCRIPTS } from "../be/seed-scripts";
import appSyncRun from "../be/seed-scripts/catalog/app-sync-run";
import githubIssuesPull from "../be/seed-scripts/catalog/github-issues-pull";
import { handleApps } from "../http/apps";
import { resolveHttpRequestAuth } from "../http/auth";
import { handleScripts } from "../http/scripts";
import { getPathSegments, parseQueryParams } from "../http/utils";
import { LEGACY_POLICY, type LegacyRule } from "../rbac";
import { validateScriptImports } from "../scripts-runtime/import-allowlist";
import { runtimeFetchJson } from "../scripts-runtime/stdlib/fetch";
import { registerAppGetTool } from "../tools/app-get";
import { registerAppSyncTool } from "../tools/app-sync";
import { registerScriptDeleteTool } from "../tools/script-delete";
import { setRequestAuth } from "../utils/request-auth-context";
import { refreshSecretScrubberCache } from "../utils/secret-scrubber";

const TEST_DB_PATH = `/private/tmp/test-apps-sync-engine-${process.pid}.sqlite`;
const API_KEY = "apps-sync-engine-test-key-0123456789";
const OWNER_AGENT_ID = crypto.randomUUID();
const LEAD_AGENT_ID = crypto.randomUUID();
const savedEnv = { ...process.env };

type RegisteredTool = { handler: (args: unknown, extra: unknown) => Promise<unknown> };
type StructuredResult<T> = { isError?: boolean; structuredContent: T; content: unknown };

let server: Server;
let base = "";
let syncTool: RegisteredTool;
let scriptDeleteTool: RegisteredTool;

const PAGE = { main: { root: "root", elements: { root: { type: "Container", props: {} } } } };

type Definition = Record<string, unknown>;

const ISSUE_COLUMNS: Record<string, unknown> = {
  issueKey: { kind: "string" },
  title: { kind: "string", source: { of: "gh", field: "title" } },
  handle: { kind: "string", source: { of: "gh", field: "user.login", transform: "slug" } },
  amountCents: { kind: "number", source: { of: "gh", field: "price", transform: "cents" } },
  openedAt: { kind: "date", source: { of: "gh", field: "created_at", transform: "date-parse" } },
  note: { kind: "string" },
  priority: { kind: "string", required: true, default: "normal" },
};

/** The same model with every source binding stripped — a plain, owned model. */
function ownedIssueColumns(): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(ISSUE_COLUMNS).map(([name, column]) => {
      const copy = { ...(column as Record<string, unknown>) };
      delete copy.source;
      return [name, copy];
    }),
  );
}

function appWith(models: Record<string, unknown>): Definition {
  return { models, pages: PAGE, defaultPage: "main" };
}

function ghSource(scriptId: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    connector: "script",
    scriptId,
    joinKey: "issueKey",
    args: { repo: "owner/name" },
    ...extra,
  };
}

function issueDefinition(scriptId: string, extra: Record<string, unknown> = {}): Definition {
  return appWith({ issue: { columns: ISSUE_COLUMNS, sources: { gh: ghSource(scriptId, extra) } } });
}

function parsed(definition: Definition) {
  const result = parseAppDefinition(definition);
  if (!result.success) throw new Error(JSON.stringify(result.issues));
  return result.definition;
}

function createSyncApp(definition: Definition, name = "Engine app"): string {
  return createApp({ name, definition: parsed(definition) }).id;
}

function modelOf(appId: string, model: string): ModelDef {
  const app = getApp(appId);
  const resolved = app?.definition.models[model];
  if (!resolved) throw new Error(`unknown model ${model}`);
  return resolved;
}

function rowsOf(appId: string, model = "issue", joinKey = "issueKey"): AppRow[] {
  return listAppRows(appId, model).sort((a, b) =>
    String(a[joinKey] ?? a.id).localeCompare(String(b[joinKey] ?? b.id)),
  );
}

function rowSnapshot(appId: string, model = "issue"): string {
  return JSON.stringify(listAppRows(appId, model).sort((a, b) => a.id.localeCompare(b.id)));
}

let scriptCounter = 0;

/** Upsert by name: re-saving the same name swaps the source and keeps the id. */
async function saveScript(args: {
  name: string;
  source: string;
  scope?: "global" | "agent";
  scopeId?: string;
  agentId?: string;
}): Promise<string> {
  const result = await upsertScriptByName({
    name: args.name,
    source: args.source,
    description: "apps sync engine fixture",
    intent: "apps sync engine fixture",
    signatureJson: JSON.stringify({ args: { type: "object" }, result: { type: "object" } }),
    typeChecked: true,
    embeddingMode: "skip",
    scope: args.scope ?? "global",
    scopeId: args.scopeId ?? null,
    agentId: args.agentId ?? null,
  });
  return result.script.id;
}

function scriptName(label: string): string {
  scriptCounter += 1;
  return `apps_sync_engine_${label}_${scriptCounter}`;
}

/** A saved script returning a literal payload; `set` swaps the payload in place. */
async function fixtureScript(label: string, payload: unknown) {
  const name = scriptName(label);
  const body = (value: unknown) => `export default async () => (${JSON.stringify(value)});`;
  const id = await saveScript({ name, source: body(payload) });
  return {
    id,
    set: async (next: unknown) => {
      await saveScript({ name, source: body(next) });
    },
    setSource: async (source: string) => {
      await saveScript({ name, source });
    },
  };
}

function ghRecord(key: string | number, overrides: Record<string, unknown> = {}) {
  return {
    key,
    fields: {
      title: `Issue ${key}`,
      user: { login: "Ada Lovelace" },
      price: 12.34,
      created_at: "2026-01-02T03:04:05.000Z",
      ...overrides,
    },
  };
}

// ── HTTP + MCP door harness (Phase 5) ───────────────────────────────────────

/** node:http around the two handlers the doors live in — no ports but 0. */
function createTestServer(): Server {
  return createHttpServer(async (req: IncomingMessage, res: ServerResponse) => {
    setRequestAuth(req, resolveHttpRequestAuth(req, API_KEY));
    res.setHeader("Content-Type", "application/json");
    const pathSegments = getPathSegments(req.url || "");
    const queryParams = parseQueryParams(req.url || "");
    const agentId = req.headers["x-agent-id"] as string | undefined;
    if (await handleApps(req, res, pathSegments, queryParams, agentId)) return;
    if (await handleScripts(req, res, pathSegments, queryParams, agentId)) return;
    res.writeHead(404);
    res.end(JSON.stringify({ error: "not found" }));
  });
}

async function request<T>(
  path: string,
  init: RequestInit & { agentId?: string } = {},
): Promise<{ status: number; body: T }> {
  const { agentId, ...rest } = init;
  const response = await fetch(`${base}${path}`, {
    ...rest,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${API_KEY}`,
      ...(agentId ? { "X-Agent-ID": agentId } : {}),
      ...rest.headers,
    },
  });
  return { status: response.status, body: (await response.json()) as T };
}

function registeredTool(register: (server: McpServer) => void, name: string): RegisteredTool {
  const toolServer = new McpServer({ name: "apps-sync-engine-test", version: "1.0.0" });
  register(toolServer);
  return (toolServer as unknown as { _registeredTools: Record<string, RegisteredTool> })
    ._registeredTools[name]!;
}

/** MCP agent identity is a real UUID — several app tool schemas pin UUIDs. */
function toolMeta(agentId = OWNER_AGENT_ID) {
  return { sessionId: "apps-sync-engine", requestInfo: { headers: { "x-agent-id": agentId } } };
}

beforeAll(async () => {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      await unlink(`${TEST_DB_PATH}${suffix}`);
    } catch {}
  }
  process.env.AGENT_SWARM_API_KEY = API_KEY;
  delete process.env.API_KEY;
  refreshSecretScrubberCache();
  initDb(TEST_DB_PATH);
  createAgent({ id: OWNER_AGENT_ID, name: "apps-sync-owner", isLead: false, status: "idle" });
  createAgent({ id: LEAD_AGENT_ID, name: "apps-sync-lead", isLead: true, status: "idle" });
  syncTool = registeredTool(registerAppSyncTool, "app-sync");
  scriptDeleteTool = registeredTool(registerScriptDeleteTool, "script-delete");
  server = createTestServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server did not bind a port");
  base = `http://127.0.0.1:${address.port}`;
  // script-delete proxies over HTTP — point the tool transport at this server.
  process.env.MCP_BASE_URL = base;
});

afterAll(async () => {
  // Keep-alive sockets from the proxying tools would otherwise hold close().
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  closeDb();
  for (const key of Object.keys(process.env)) {
    if (!(key in savedEnv)) delete process.env[key];
  }
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  refreshSecretScrubberCache();
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      await unlink(`${TEST_DB_PATH}${suffix}`);
    } catch {}
  }
});

beforeEach(() => {
  getDb().run("DELETE FROM kv_entries WHERE namespace LIKE 'apps:%'");
  getDb().run("DELETE FROM apps");
});

describe("script source pulls", () => {
  test("first pass creates rows with the envelope, join key and transforms", async () => {
    const script = await fixtureScript("create", [
      ghRecord(1),
      ghRecord("two", { user: { login: "Grace Hopper" }, price: 1, created_at: "2026-02-02" }),
    ]);
    const appId = createSyncApp(issueDefinition(script.id));

    const result = await runAppSync({ appId, invokedBy: "user:tester" });

    expect(result.ok).toBe(true);
    expect(result.passes).toHaveLength(1);
    expect(result.passes[0]).toMatchObject({
      model: "issue",
      source: "gh",
      connector: "script",
      pulled: 2,
      created: 2,
      updated: 0,
      refreshed: 0,
      markedStale: 0,
      unchanged: 0,
      invokedBy: "user:tester",
    });
    expect(result.passes[0]?.error).toBeUndefined();

    const rows = rowsOf(appId);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      issueKey: "1",
      title: "Issue 1",
      handle: "ada-lovelace",
      amountCents: 1234,
      openedAt: "2026-01-02T03:04:05.000Z",
      priority: "normal",
      source: "gh",
      stale: false,
      createdBy: "sync:gh",
      updatedBy: "sync:gh",
    });
    expect(typeof rows[0]?.syncedAt).toBe("string");
    expect(rows[1]).toMatchObject({ issueKey: "two", handle: "grace-hopper", amountCents: 100 });
  });

  test("changed data updates projected columns only; an unchanged pass just refreshes", async () => {
    const script = await fixtureScript("update", [ghRecord(1), ghRecord(2)]);
    const appId = createSyncApp(issueDefinition(script.id));
    await runAppSync({ appId });

    // An operator owns `note`; sync must never touch it.
    const before = rowsOf(appId)[0]!;
    await patchAppRow(
      appId,
      "issue",
      modelOf(appId, "issue"),
      before.id,
      { note: "mine" },
      {
        actor: "user:operator",
      },
    );

    await script.set([ghRecord(1, { title: "Renamed" }), ghRecord(2)]);
    const second = await runAppSync({ appId });
    expect(second.passes[0]).toMatchObject({ pulled: 2, created: 0, updated: 1, refreshed: 1 });

    const updated = rowsOf(appId)[0]!;
    expect(updated.title).toBe("Renamed");
    expect(updated.note).toBe("mine");
    expect(updated.updatedBy).toBe("sync:gh");
    expect(Date.parse(String(updated.updatedAt))).toBeGreaterThan(
      Date.parse(String(before.updatedAt)),
    );

    const third = await runAppSync({ appId });
    expect(third.passes[0]).toMatchObject({ created: 0, updated: 0, refreshed: 2 });

    const refreshed = rowsOf(appId)[0]!;
    expect(refreshed.updatedAt).toBe(updated.updatedAt);
    expect(refreshed.updatedBy).toBe(updated.updatedBy);
    expect(refreshed.note).toBe("mine");
    expect(Date.parse(String(refreshed.syncedAt))).toBeGreaterThan(
      Date.parse(String(updated.syncedAt)),
    );
  });

  test("a vanished record goes stale with syncedAt frozen; reappearing clears it", async () => {
    const script = await fixtureScript("stale", [ghRecord(1), ghRecord(2)]);
    const appId = createSyncApp(issueDefinition(script.id));
    await runAppSync({ appId });
    const seeded = rowsOf(appId)[0]!;

    await script.set([ghRecord(2)]);
    const sweep = await runAppSync({ appId });
    expect(sweep.passes[0]).toMatchObject({ pulled: 1, markedStale: 1, refreshed: 1 });
    expect(sweep.passes[0]?.staleSweepSkipped).toBeUndefined();

    const stale = rowsOf(appId)[0]!;
    expect(stale.stale).toBe(true);
    expect(stale.syncedAt).toBe(seeded.syncedAt);
    expect(stale.updatedAt).toBe(seeded.updatedAt);

    // A second sweep must not re-write an already-stale row.
    const again = await runAppSync({ appId });
    expect(again.passes[0]).toMatchObject({ markedStale: 0, unchanged: 1 });

    await script.set([ghRecord(1), ghRecord(2)]);
    const back = await runAppSync({ appId });
    expect(back.passes[0]).toMatchObject({ created: 0, markedStale: 0 });
    const revived = rowsOf(appId)[0]!;
    expect(revived.stale).toBe(false);
    expect(Date.parse(String(revived.syncedAt))).toBeGreaterThan(
      Date.parse(String(stale.syncedAt)),
    );
  });

  test("an unprojectable field nulls one column and warns instead of failing the pass", async () => {
    const script = await fixtureScript("projection", [
      ghRecord(1, { price: "not a number", created_at: "yesterday", title: 42 }),
    ]);
    const appId = createSyncApp(issueDefinition(script.id));

    const pass = (await runAppSync({ appId })).passes[0]!;

    expect(pass.error).toBeUndefined();
    expect(pass.created).toBe(1);
    const row = rowsOf(appId)[0]!;
    expect(row.amountCents).toBeNull();
    expect(row.openedAt).toBeNull();
    expect(row.title).toBeNull();
    expect(pass.warnings).toHaveLength(3);
    expect(pass.warnings.some((warning) => warning.includes('column "amountCents"'))).toBe(true);
    expect(pass.warnings.some((warning) => warning.includes('column "title"'))).toBe(true);
  });

  test("complete:false skips the stale sweep and warns", async () => {
    const script = await fixtureScript("incomplete", [ghRecord(1), ghRecord(2)]);
    const appId = createSyncApp(issueDefinition(script.id));
    await runAppSync({ appId });

    await script.set({ records: [ghRecord(2)], complete: false });
    const pass = (await runAppSync({ appId })).passes[0]!;

    expect(pass).toMatchObject({
      pulled: 1,
      markedStale: 0,
      unchanged: 1,
      staleSweepSkipped: true,
    });
    expect(pass.warnings.some((warning) => warning.includes("stale sweep skipped"))).toBe(true);
    expect(rowsOf(appId)[0]?.stale).toBe(false);
  });

  test("a pull above the 500-record cap truncates and drops completeness", async () => {
    const script = await fixtureScript("cap", []);
    await script.setSource(
      "export default async () => Array.from({ length: 501 }, (_, i) => ({ key: 'k' + i, fields: { title: 't' + i } }));",
    );
    const appId = createSyncApp(issueDefinition(script.id));

    const pass = (await runAppSync({ appId })).passes[0]!;

    expect(pass).toMatchObject({ pulled: 500, created: 500, staleSweepSkipped: true });
    expect(pass.warnings.some((warning) => warning.includes("500-record cap"))).toBe(true);
    expect(listAppRows(appId, "issue")).toHaveLength(500);
  });

  test("an invalid return shape fails the pass with zero row churn", async () => {
    const script = await fixtureScript("shape", [ghRecord(1)]);
    const appId = createSyncApp(issueDefinition(script.id));
    await runAppSync({ appId });
    const before = rowSnapshot(appId);

    await script.set({ error: "upstream said no" });
    const result = await runAppSync({ appId });

    expect(result.ok).toBe(false);
    expect(result.passes[0]?.error).toContain("invalid payload");
    expect(result.passes[0]).toMatchObject({ pulled: 0, created: 0, updated: 0, markedStale: 0 });
    expect(rowSnapshot(appId)).toBe(before);
  });

  test("a thrown script error fails the pass with zero row churn", async () => {
    const script = await fixtureScript("throw", [ghRecord(1)]);
    const appId = createSyncApp(issueDefinition(script.id));
    await runAppSync({ appId });
    const before = rowSnapshot(appId);

    await script.setSource('export default async () => { throw new Error("upstream exploded"); };');
    const result = await runAppSync({ appId });

    expect(result.ok).toBe(false);
    expect(result.passes[0]?.error).toContain("upstream exploded");
    expect(rowSnapshot(appId)).toBe(before);
  });

  test("a non-zero exit fails the pass with zero row churn", async () => {
    const script = await fixtureScript("exit", [ghRecord(1)]);
    const appId = createSyncApp(issueDefinition(script.id));
    await runAppSync({ appId });
    const before = rowSnapshot(appId);

    await script.setSource("export default async () => { process.exit(3); };");
    const result = await runAppSync({ appId });

    expect(result.ok).toBe(false);
    expect(result.passes[0]?.error).toBeDefined();
    expect(result.passes[0]).toMatchObject({ pulled: 0, created: 0, updated: 0, markedStale: 0 });
    expect(rowSnapshot(appId)).toBe(before);
  });

  test("does not adopt an unowned row that already carries the join key", async () => {
    const script = await fixtureScript("adopt", [ghRecord(1)]);
    const appId = createSyncApp(appWith({ issue: { columns: ownedIssueColumns() } }));
    await createAppRow(
      appId,
      "issue",
      modelOf(appId, "issue"),
      { issueKey: "1", title: "hand made", note: "human" },
      { actor: "user:operator" },
    );
    // Adding a source to a model that already has rows is a free schema edit.
    updateApp(appId, { definition: parsed(issueDefinition(script.id)) });

    const pass = (await runAppSync({ appId })).passes[0]!;

    expect(pass).toMatchObject({ created: 1, updated: 0 });
    const rows = rowsOf(appId);
    expect(rows).toHaveLength(2);
    const human = rows.find((row) => row.note === "human")!;
    expect(human.source).toBeUndefined();
    expect(human.title).toBe("hand made");
    expect(rows.find((row) => row.source === "gh")?.title).toBe("Issue 1");
  });
});

describe("script source inputs and run-as", () => {
  const ECHO_COLUMNS: Record<string, unknown> = {
    issueKey: { kind: "string" },
    payload: { kind: "string", source: { of: "gh", field: "payload" } },
  };

  function echoDefinition(scriptId: string, extra: Record<string, unknown> = {}): Definition {
    return appWith({
      issue: { columns: ECHO_COLUMNS, sources: { gh: ghSource(scriptId, extra) } },
    });
  }

  test("args, app, model, source and connection reach the script", async () => {
    await upsertScriptConnection({
      slug: "echoConn",
      kind: "graphql",
      scope: "global",
      baseUrl: "https://api.echo.test/graphql",
      allowedHosts: ["api.echo.test"],
    });
    const name = scriptName("echo");
    const scriptId = await saveScript({
      name,
      source:
        "export default async (args) => [{ key: 'echo', fields: { payload: JSON.stringify(args) } }];",
    });
    const appId = createSyncApp(echoDefinition(scriptId, { connection: "echoConn" }));

    const result = await runAppSync({ appId });

    expect(result.ok).toBe(true);
    const payload = JSON.parse(String(rowsOf(appId)[0]?.payload));
    expect(payload).toEqual({
      repo: "owner/name",
      app: { id: appId },
      model: "issue",
      source: "gh",
      connection: "echoConn",
    });
  });

  test("engine-supplied model and source win over colliding args keys", async () => {
    const scriptId = await saveScript({
      name: scriptName("precedence"),
      source:
        "export default async (args) => [{ key: 'echo', fields: { payload: JSON.stringify(args) } }];",
    });
    const appId = createSyncApp(
      echoDefinition(scriptId, { args: { repo: "x", model: "hijack", source: "hijack2" } }),
    );

    const result = await runAppSync({ appId });

    expect(result.ok).toBe(true);
    expect(JSON.parse(String(rowsOf(appId)[0]?.payload))).toEqual({
      repo: "x",
      app: { id: appId },
      model: "issue",
      source: "gh",
    });
  });

  test("an owner-owned script runs with the owner's connections", async () => {
    await upsertScriptConnection({
      slug: "ownerOnly",
      kind: "graphql",
      scope: "agent",
      scopeId: OWNER_AGENT_ID,
      baseUrl: "https://api.owner.test/graphql",
      allowedHosts: ["api.owner.test"],
    });
    const scriptId = await saveScript({
      name: scriptName("owned"),
      source: "export default async () => [{ key: 'o1', fields: { payload: 'ok' } }];",
      scope: "agent",
      scopeId: OWNER_AGENT_ID,
      agentId: OWNER_AGENT_ID,
    });
    const appId = createSyncApp(echoDefinition(scriptId, { connection: "ownerOnly" }));

    const result = await runAppSync({ appId });

    expect(result.ok).toBe(true);
    expect(result.passes[0]?.created).toBe(1);
  });

  test("an owner-less global script runs as the lead", async () => {
    await upsertScriptConnection({
      slug: "leadOnly",
      kind: "graphql",
      scope: "agent",
      scopeId: LEAD_AGENT_ID,
      baseUrl: "https://api.lead.test/graphql",
      allowedHosts: ["api.lead.test"],
    });
    const scriptId = await saveScript({
      name: scriptName("leadrun"),
      source: "export default async () => [{ key: 'l1', fields: { payload: 'ok' } }];",
    });
    // The lead-scoped connection is only reachable when run-as resolved to the
    // lead — both at definition-write time and in the pull preflight.
    const appId = createSyncApp(echoDefinition(scriptId, { connection: "leadOnly" }));

    const result = await runAppSync({ appId });

    expect(result.ok).toBe(true);
    expect(result.passes[0]?.created).toBe(1);
  });

  test("a connection disabled after the write fails preflight before the script runs", async () => {
    await upsertScriptConnection({
      slug: "goesDark",
      kind: "graphql",
      scope: "global",
      baseUrl: "https://api.dark.test/graphql",
      allowedHosts: ["api.dark.test"],
    });
    const scriptId = await saveScript({
      name: scriptName("marker"),
      source: 'export default async () => { throw new Error("MARKER script ran"); };',
    });
    const appId = createSyncApp(echoDefinition(scriptId, { connection: "goesDark" }));

    await upsertScriptConnection({
      slug: "goesDark",
      kind: "graphql",
      scope: "global",
      baseUrl: "https://api.dark.test/graphql",
      allowedHosts: ["api.dark.test"],
      enabled: false,
    });
    const result = await runAppSync({ appId });

    expect(result.ok).toBe(false);
    expect(result.passes[0]?.error).toContain('connection "goesDark" not found or disabled');
    // The marker proves the script was never invoked.
    expect(result.passes[0]?.error).not.toContain("MARKER");
    expect(listAppRows(appId, "issue")).toHaveLength(0);
  });

  test("a source naming a connection that never existed fails the pass", async () => {
    const scriptId = await saveScript({
      name: scriptName("ghost"),
      source: 'export default async () => { throw new Error("MARKER script ran"); };',
    });
    await upsertScriptConnection({
      slug: "ghostConn",
      kind: "graphql",
      scope: "global",
      baseUrl: "https://api.ghost.test/graphql",
      allowedHosts: ["api.ghost.test"],
    });
    const appId = createSyncApp(echoDefinition(scriptId, { connection: "ghostConn" }));
    // Stored definitions outlive their connections; the engine re-resolves the
    // slug on every pull rather than trusting write-time validation.
    getDb().run("DELETE FROM script_connections WHERE slug = 'ghostConn'");

    const result = await runAppSync({ appId });

    expect(result.ok).toBe(false);
    expect(result.passes[0]?.error).toContain('connection "ghostConn" not found or disabled');
    expect(result.passes[0]?.error).not.toContain("MARKER");
  });
});

describe("swarm-tasks source", () => {
  const TASK_COLUMNS: Record<string, unknown> = {
    taskKey: { kind: "string" },
    prompt: { kind: "string", source: { of: "pool", field: "prompt" } },
    taskStatus: { kind: "string", source: { of: "pool", field: "status" } },
    taskPriority: { kind: "number", source: { of: "pool", field: "priority" } },
    author: { kind: "string", source: { of: "pool", field: "vcsAuthor" } },
  };

  function taskDefinition(config: Record<string, unknown> = {}): Definition {
    return appWith({
      task: {
        columns: TASK_COLUMNS,
        sources: { pool: { connector: "swarm-tasks", joinKey: "taskKey", config } },
      },
    });
  }

  beforeEach(() => {
    getDb().run("DELETE FROM agent_tasks");
  });

  test("projects tasks flatly, truncates the prompt and honours the default heartbeat filter", async () => {
    const longPrompt = "x".repeat(1500);
    const task = createTaskExtended(longPrompt, {
      agentId: OWNER_AGENT_ID,
      tags: ["alpha"],
      priority: 70,
      vcsProvider: "github",
      vcsAuthor: "octocat",
    });
    createTaskExtended("heartbeat noise", { agentId: OWNER_AGENT_ID, tags: ["heartbeat"] });
    const appId = createSyncApp(taskDefinition());

    const pass = (await runAppSync({ appId })).passes[0]!;

    expect(pass).toMatchObject({ connector: "swarm-tasks", pulled: 1, created: 1 });
    const rows = rowsOf(appId, "task", "taskKey");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      taskKey: task.id,
      taskStatus: "pending",
      taskPriority: 70,
      author: "octocat",
      source: "pool",
      stale: false,
    });
    expect(String(rows[0]?.prompt)).toHaveLength(1000);
  });

  test("assetKey prefix-scopes the window and includeHeartbeat widens it", async () => {
    createTaskExtended("app owned", { agentId: OWNER_AGENT_ID, key: "shared/apps/demo/one" });
    createTaskExtended("elsewhere", { agentId: OWNER_AGENT_ID, key: "shared/other/two" });
    createTaskExtended("beat", { agentId: OWNER_AGENT_ID, tags: ["heartbeat"] });

    const scoped = createSyncApp(taskDefinition({ assetKey: "shared/apps/demo" }), "Scoped");
    expect((await runAppSync({ appId: scoped })).passes[0]?.pulled).toBe(1);

    const withBeats = createSyncApp(taskDefinition({ includeHeartbeat: true }), "With beats");
    expect((await runAppSync({ appId: withBeats })).passes[0]?.pulled).toBe(3);
  });

  test("a full page marks the pull incomplete and skips the sweep", async () => {
    for (let index = 0; index < 3; index += 1) {
      createTaskExtended(`task ${index}`, { agentId: OWNER_AGENT_ID });
    }
    const appId = createSyncApp(taskDefinition({ limit: 2 }));

    const pass = (await runAppSync({ appId })).passes[0]!;

    expect(pass).toMatchObject({ pulled: 2, created: 2, staleSweepSkipped: true });
  });

  test("status, tags and agentId filters narrow the window", async () => {
    const other = crypto.randomUUID();
    createAgent({ id: other, name: "apps-sync-other", isLead: false, status: "idle" });
    createTaskExtended("mine tagged", { agentId: OWNER_AGENT_ID, tags: ["alpha", "beta"] });
    createTaskExtended("mine untagged", { agentId: OWNER_AGENT_ID });
    createTaskExtended("theirs tagged", { agentId: other, tags: ["alpha"] });
    createTaskExtended("backlog", { tags: ["alpha"], status: "backlog" });

    const byAgent = createSyncApp(taskDefinition({ agentId: OWNER_AGENT_ID }), "By agent");
    expect((await runAppSync({ appId: byAgent })).passes[0]?.pulled).toBe(2);

    const byTag = createSyncApp(taskDefinition({ tags: "beta" }), "By tag");
    expect((await runAppSync({ appId: byTag })).passes[0]?.pulled).toBe(1);

    const byStatus = createSyncApp(taskDefinition({ status: "backlog,pending" }), "By status");
    expect((await runAppSync({ appId: byStatus })).passes[0]?.pulled).toBe(4);

    const bogus = createSyncApp(taskDefinition({ status: "nonsense" }), "Bogus status");
    const failed = await runAppSync({ appId: bogus });
    expect(failed.ok).toBe(false);
    expect(failed.passes[0]?.error).toContain('unknown task status "nonsense"');
  });

  test("a user-invoked sync is scoped to the requester and never sweeps stale", async () => {
    const userId = createUser({ name: "Apps Sync Requester" }).id;
    createTaskExtended("mine: fix the login flow", {
      agentId: OWNER_AGENT_ID,
      requestedByUserId: userId,
    });
    createTaskExtended("theirs: rotate the billing keys", {
      agentId: OWNER_AGENT_ID,
      requestedByUserId: createUser({ name: "Apps Sync Other" }).id,
    });
    createTaskExtended("pool: unattributed chore", { agentId: OWNER_AGENT_ID });
    const appId = createSyncApp(taskDefinition());

    const scoped = (await runAppSync({ appId, invokedBy: `user:${userId}` })).passes[0]!;

    expect(scoped).toMatchObject({ pulled: 1, created: 1, staleSweepSkipped: true });
    expect(scoped.warnings.some((w) => w.includes("scoped to tasks requested"))).toBe(true);
    const rows = rowsOf(appId, "task", "taskKey");
    expect(rows).toHaveLength(1);
    expect(String(rows[0]?.prompt)).toContain("fix the login flow");
    expect(JSON.stringify(rows)).not.toContain("rotate the billing keys");

    // Operator- and agent-invoked passes keep the full window and its sweep.
    const full = (await runAppSync({ appId, invokedBy: "operator" })).passes[0]!;
    expect(full.pulled).toBe(3);
    expect(full.staleSweepSkipped).toBeUndefined();
  });

  test("malformed scoping config fails the pass instead of widening it", async () => {
    createTaskExtended("only task", { agentId: OWNER_AGENT_ID });

    const badAgent = createSyncApp(taskDefinition({ agentId: 123 }), "Bad agentId");
    const agentResult = await runAppSync({ appId: badAgent });
    expect(agentResult.ok).toBe(false);
    expect(agentResult.passes[0]?.error).toContain("config.agentId must be a non-empty string");
    expect(agentResult.passes[0]?.pulled).toBe(0);

    const badKey = createSyncApp(taskDefinition({ assetKey: true }), "Bad assetKey");
    const keyResult = await runAppSync({ appId: badKey });
    expect(keyResult.ok).toBe(false);
    expect(keyResult.passes[0]?.error).toContain("config.assetKey must be a non-empty string");
    expect(rowsOf(badKey, "task", "taskKey")).toHaveLength(0);

    const badStatus = createSyncApp(taskDefinition({ status: " , " }), "Bad status");
    const statusResult = await runAppSync({ appId: badStatus });
    expect(statusResult.ok).toBe(false);
    expect(statusResult.passes[0]?.error).toContain("config.status must name at least one");

    const badTags = createSyncApp(taskDefinition({ tags: "" }), "Bad tags");
    const tagsResult = await runAppSync({ appId: badTags });
    expect(tagsResult.ok).toBe(false);
    expect(tagsResult.passes[0]?.error).toContain("config.tags must name at least one");
  });

  test("an unsupported config key is reported as a warning", async () => {
    createTaskExtended("only task", { agentId: OWNER_AGENT_ID });
    const appId = createSyncApp(taskDefinition({ nonsense: "value" }));

    const pass = (await runAppSync({ appId })).passes[0]!;

    expect(pass.warnings.some((warning) => warning.includes('config key "nonsense"'))).toBe(true);
  });

  test("limit rails: over the cap and below the floor each warn", async () => {
    createTaskExtended("only task", { agentId: OWNER_AGENT_ID });

    const over = createSyncApp(taskDefinition({ limit: 500 }), "Over cap");
    const overPass = (await runAppSync({ appId: over })).passes[0]!;
    expect(overPass.warnings).toHaveLength(1);
    expect(overPass.warnings[0]).toBe("config.limit 500 exceeds the 200 cap; using 200");

    const under = createSyncApp(taskDefinition({ limit: 0 }), "Under floor");
    const underPass = (await runAppSync({ appId: under })).passes[0]!;
    expect(underPass.warnings).toHaveLength(1);
    expect(underPass.warnings[0]).toBe('config.limit "0" is not a positive integer; using 100');
  });

  test("projects every documented task field onto its bound column", async () => {
    const task = createTaskExtended("full shape", {
      agentId: OWNER_AGENT_ID,
      source: "slack",
      tags: ["alpha", "beta"],
      priority: 42,
      vcsProvider: "gitlab",
      vcsNumber: 77,
      vcsUrl: "https://git.test/mr/77",
      vcsAuthor: "octocat",
    });
    const appId = createSyncApp(
      appWith({
        task: {
          columns: {
            taskKey: { kind: "string" },
            taskId: { kind: "string", source: { of: "pool", field: "id" } },
            taskStatus: { kind: "string", source: { of: "pool", field: "status" } },
            prompt: { kind: "string", source: { of: "pool", field: "prompt" } },
            taskSource: { kind: "string", source: { of: "pool", field: "source" } },
            taskAgentId: { kind: "string", source: { of: "pool", field: "agentId" } },
            // Arrays are not a column kind; `lower` stringifies the tag list.
            tagsCsv: { kind: "string", source: { of: "pool", field: "tags", transform: "lower" } },
            taskPriority: { kind: "number", source: { of: "pool", field: "priority" } },
            openedAt: { kind: "date", source: { of: "pool", field: "createdAt" } },
            touchedAt: { kind: "date", source: { of: "pool", field: "updatedAt" } },
            vcsProvider: { kind: "string", source: { of: "pool", field: "vcsProvider" } },
            vcsNumber: { kind: "number", source: { of: "pool", field: "vcsNumber" } },
            vcsUrl: { kind: "string", source: { of: "pool", field: "vcsUrl" } },
            vcsAuthor: { kind: "string", source: { of: "pool", field: "vcsAuthor" } },
          },
          sources: { pool: { connector: "swarm-tasks", joinKey: "taskKey", config: {} } },
        },
      }),
    );

    const pass = (await runAppSync({ appId })).passes[0]!;

    expect(pass.warnings).toHaveLength(0);
    const row = rowsOf(appId, "task", "taskKey")[0]!;
    expect(row).toMatchObject({
      taskKey: task.id,
      taskId: task.id,
      taskStatus: "pending",
      prompt: "full shape",
      taskSource: "slack",
      taskAgentId: OWNER_AGENT_ID,
      tagsCsv: "alpha,beta",
      taskPriority: 42,
      openedAt: task.createdAt,
      touchedAt: task.lastUpdatedAt,
      vcsProvider: "gitlab",
      vcsNumber: 77,
      vcsUrl: "https://git.test/mr/77",
      vcsAuthor: "octocat",
    });
  });

  test("engine-generated warnings carrying a known secret come back redacted", async () => {
    const secret = "fixture-secret-value-0123456789";
    process.env.APPS_SYNC_FIXTURE_TOKEN = secret;
    refreshSecretScrubberCache();
    try {
      // The task text never leaves the DB layer, so nothing upstream of the
      // engine can scrub it: the cents transform fails and quotes the raw
      // value into a warning the engine itself composes.
      createTaskExtended(`leaked ${secret}`, { agentId: OWNER_AGENT_ID });
      const appId = createSyncApp(
        appWith({
          task: {
            columns: {
              taskKey: { kind: "string" },
              amount: {
                kind: "number",
                source: { of: "pool", field: "prompt", transform: "cents" },
              },
            },
            sources: { pool: { connector: "swarm-tasks", joinKey: "taskKey", config: {} } },
          },
        }),
      );

      const pass = (await runAppSync({ appId })).passes[0]!;

      expect(pass.warnings).toHaveLength(1);
      expect(pass.warnings[0]).toContain("[REDACTED:APPS_SYNC_FIXTURE_TOKEN]");
      expect(pass.warnings[0]).not.toContain(secret);
    } finally {
      delete process.env.APPS_SYNC_FIXTURE_TOKEN;
      refreshSecretScrubberCache();
    }
  });

  test("an engine-generated pass error carrying a known secret is redacted in the status KV", async () => {
    const secret = "fixture-secret-value-0123456789";
    process.env.APPS_SYNC_FIXTURE_TOKEN = secret;
    refreshSecretScrubberCache();
    try {
      // An unknown status token is echoed back by the engine itself — the only
      // scrub between it and the caller is the engine's own.
      const appId = createSyncApp(taskDefinition({ status: secret }));

      const result = await runAppSync({ appId });

      expect(result.ok).toBe(false);
      expect(result.passes[0]?.error).toContain("[REDACTED:APPS_SYNC_FIXTURE_TOKEN]");
      expect(result.passes[0]?.error).not.toContain(secret);
      const status = getAppSyncStatus(appId, "task", "pool")!;
      expect(status.error).toContain("[REDACTED:APPS_SYNC_FIXTURE_TOKEN]");
      expect(status.error).not.toContain(secret);
    } finally {
      delete process.env.APPS_SYNC_FIXTURE_TOKEN;
      refreshSecretScrubberCache();
    }
  });
});

describe("pair expansion", () => {
  test("fans out to every declared pair and reports unresolvable requests", async () => {
    getDb().run("DELETE FROM agent_tasks");
    createTaskExtended("pool task", { agentId: OWNER_AGENT_ID });
    const script = await fixtureScript("fanout", [ghRecord(1)]);
    const appId = createSyncApp(
      appWith({
        issue: {
          columns: {
            ...ISSUE_COLUMNS,
            taskKey: { kind: "string" },
            taskStatus: { kind: "string", source: { of: "pool", field: "status" } },
          },
          sources: {
            gh: ghSource(script.id),
            pool: { connector: "swarm-tasks", joinKey: "taskKey", config: { limit: 50 } },
          },
        },
      }),
    );

    const all = await runAppSync({ appId });
    expect(all.ok).toBe(true);
    expect(all.passes.map((pass) => pass.source)).toEqual(["gh", "pool"]);
    expect(all.passes.map((pass) => pass.created)).toEqual([1, 1]);

    const single = await runAppSync({ appId, source: "gh" });
    expect(single.passes).toHaveLength(1);
    expect(single.passes[0]?.source).toBe("gh");

    expect(await runAppSync({ appId: crypto.randomUUID() })).toMatchObject({
      ok: false,
      passes: [],
      issues: [{ path: "appId" }],
    });
    expect((await runAppSync({ appId, model: "nope" })).issues?.[0]).toMatchObject({
      path: "model",
      message: 'unknown model "nope"',
    });
    expect((await runAppSync({ appId, source: "nope" })).issues?.[0]).toEqual({
      path: "source",
      message: 'unknown source "nope" — no model declares it',
    });
    expect((await runAppSync({ appId, model: "issue", source: "nope" })).issues?.[0]).toEqual({
      path: "source",
      message: 'unknown source "nope" on model "issue"',
    });

    const sourceless = createSyncApp(
      appWith({ issue: { columns: { issueKey: { kind: "string" } } } }),
      "Sourceless",
    );
    const none = await runAppSync({ appId: sourceless });
    expect(none.ok).toBe(false);
    expect(none.issues?.[0]).toEqual({
      path: "appId",
      message: "no model declares a source to sync",
    });
    expect((await runAppSync({ appId: sourceless, model: "issue" })).issues?.[0]).toEqual({
      path: "model",
      message: 'model "issue" declares no sources',
    });
  });
});

describe("concurrency", () => {
  test("single-flight short-circuits and an interleaved operator write survives", async () => {
    const script = await fixtureScript("concurrent", [ghRecord(1), ghRecord(2)]);
    const appId = createSyncApp(issueDefinition(script.id));
    await runAppSync({ appId });
    const seededRow = rowsOf(appId)[0]!;

    // The pull now takes ~400ms and returns changed data for record 1.
    await script.setSource(
      `export default async () => { await new Promise((resolve) => setTimeout(resolve, 400)); return ${JSON.stringify(
        [ghRecord(1, { title: "Changed while locked" }), ghRecord(2)],
      )}; };`,
    );

    // Hold the model lock so reconcile cannot start until the barrier opens.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const held = withMutationLock(appId, "issue", () => gate);

    const first = runAppSync({ appId, invokedBy: "user:a" });
    // Same pair, already in flight: no second pull.
    const second = await runAppSync({ appId, invokedBy: "user:b" });
    expect(second.passes[0]).toMatchObject({
      model: "issue",
      source: "gh",
      skipped: true,
      alreadyRunning: true,
      pulled: 0,
      created: 0,
      invokedBy: "user:b",
    });

    // The slow pass has not finished, so the status still describes the seed
    // pass: a short-circuited trigger must never write status of its own.
    expect(getAppSyncStatus(appId, "issue", "gh")).toMatchObject({
      ok: true,
      created: 2,
      updated: 0,
      refreshed: 0,
      markedStale: 0,
    });

    // Queued behind the barrier and therefore ahead of the reconcile, which
    // only asks for the lock once its pull has finished.
    const operatorWrite = patchAppRow(
      appId,
      "issue",
      modelOf(appId, "issue"),
      seededRow.id,
      { note: "written mid-pull" },
      { actor: "user:operator" },
    );
    const operatorRow = createAppRow(
      appId,
      "issue",
      modelOf(appId, "issue"),
      { note: "operator only" },
      { actor: "user:operator" },
    );

    release();
    await held;
    await operatorWrite;
    await operatorRow;
    const result = await first;

    expect(result.ok).toBe(true);
    expect(result.passes[0]).toMatchObject({ pulled: 2, created: 0, updated: 1, refreshed: 1 });

    const rows = rowsOf(appId);
    const synced = rows.filter((row) => row.source === "gh");
    expect(synced).toHaveLength(2);
    expect(new Set(synced.map((row) => row.issueKey)).size).toBe(2);
    expect(rows).toHaveLength(3);

    const reconciled = synced.find((row) => row.issueKey === "1")!;
    expect(reconciled.title).toBe("Changed while locked");
    expect(reconciled.note).toBe("written mid-pull");

    const unowned = rows.find((row) => row.note === "operator only")!;
    expect(unowned.source).toBeUndefined();
    expect(unowned.stale).toBeUndefined();

    // The short-circuited trigger must not have overwritten the real pass state.
    expect(getAppSyncStatus(appId, "issue", "gh")).toMatchObject({
      ok: true,
      created: 0,
      updated: 1,
      refreshed: 1,
    });
  });

  test("a definition change during the pull aborts the pass with no writes", async () => {
    const script = await fixtureScript("racy", [ghRecord(1)]);
    const appId = createSyncApp(issueDefinition(script.id));
    await runAppSync({ appId });
    const before = rowSnapshot(appId);

    await script.setSource(
      `export default async () => { await new Promise((resolve) => setTimeout(resolve, 300)); return ${JSON.stringify(
        [ghRecord(1, { title: "never written" })],
      )}; };`,
    );
    const pass = runAppSync({ appId });
    // Drop the source while the pull is in the air.
    updateApp(appId, {
      definition: parsed(appWith({ issue: { columns: ownedIssueColumns() } })),
    });

    const result = await pass;

    expect(result.ok).toBe(false);
    expect(result.passes[0]?.error).toContain("no longer declares source");
    expect(rowSnapshot(appId)).toBe(before);
  });

  test("a join-key swap during the pull aborts the pass with no writes", async () => {
    const script = await fixtureScript("joinkey", [ghRecord(1)]);
    const withAltKey = (columns: Record<string, unknown>) => ({
      ...columns,
      altKey: { kind: "string" },
    });
    const appId = createSyncApp(
      appWith({
        issue: { columns: withAltKey(ISSUE_COLUMNS), sources: { gh: ghSource(script.id) } },
      }),
    );
    await runAppSync({ appId });

    await script.setSource(
      `export default async () => { await new Promise((resolve) => setTimeout(resolve, 300)); return ${JSON.stringify(
        [ghRecord(1, { title: "never written" })],
      )}; };`,
    );
    const pass = runAppSync({ appId });
    // A join key is immutable in place, so the only way to move it is
    // remove-then-re-add — both halves land while the pull is in the air.
    updateApp(appId, {
      definition: parsed(appWith({ issue: { columns: withAltKey(ownedIssueColumns()) } })),
    });
    updateApp(appId, {
      definition: parsed(
        appWith({
          issue: {
            columns: withAltKey(ISSUE_COLUMNS),
            sources: { gh: ghSource(script.id, { joinKey: "altKey" }) },
          },
        }),
      ),
    });
    const before = rowSnapshot(appId);

    const result = await pass;

    expect(result.ok).toBe(false);
    expect(result.passes[0]?.error).toContain("changed while the pull was running");
    expect(rowSnapshot(appId)).toBe(before);
  });

  test("an args swap during the pull aborts the pass with no writes", async () => {
    const script = await fixtureScript("args-drift", [ghRecord(1)]);
    const appId = createSyncApp(issueDefinition(script.id));
    await runAppSync({ appId });
    await script.setSource(
      `export default async () => { await new Promise((resolve) => setTimeout(resolve, 300)); return ${JSON.stringify(
        [ghRecord(1, { title: "stale payload" })],
      )}; };`,
    );
    const before = rowSnapshot(appId);

    const pass = runAppSync({ appId });
    // Same connector and join key, different args: the old guard missed this.
    updateApp(appId, {
      definition: parsed(issueDefinition(script.id, { args: { repo: "owner/other" } })),
    });

    const result = await pass;

    expect(result.ok).toBe(false);
    expect(result.passes[0]?.error).toContain("changed while the pull was running");
    expect(rowSnapshot(appId)).toBe(before);
  });

  test("a binding swap during the pull aborts the pass with no writes", async () => {
    const script = await fixtureScript("binding-drift", [ghRecord(1)]);
    const appId = createSyncApp(issueDefinition(script.id));
    await runAppSync({ appId });
    await script.setSource(
      `export default async () => { await new Promise((resolve) => setTimeout(resolve, 300)); return ${JSON.stringify(
        [ghRecord(1, { title: "stale payload" })],
      )}; };`,
    );
    const before = rowSnapshot(appId);

    const pass = runAppSync({ appId });
    // Rebind `title` to a different field mid-pull: the payload was projected
    // against the old rules and must not land under the new ones.
    updateApp(appId, {
      definition: parsed(
        appWith({
          issue: {
            columns: {
              ...ISSUE_COLUMNS,
              title: { kind: "string", source: { of: "gh", field: "user.login" } },
            },
            sources: { gh: ghSource(script.id) },
          },
        }),
      ),
    });

    const result = await pass;

    expect(result.ok).toBe(false);
    expect(result.passes[0]?.error).toContain("changed while the pull was running");
    expect(rowSnapshot(appId)).toBe(before);
  });

  test("a mid-pass write failure reports the committed churn instead of zero counts", async () => {
    // Row writes are independent KV upserts, not a transaction: fail the
    // SECOND create after the first already committed and the pass counts
    // must say so instead of reporting the zero-count base.
    const script = await fixtureScript("partial", [ghRecord(1), ghRecord(2)]);
    const appId = createSyncApp(issueDefinition(script.id));

    const realCreate = rowStore.createAppRowUnlocked;
    let creates = 0;
    const spy = spyOn(rowStore, "createAppRowUnlocked").mockImplementation((...callArgs) => {
      creates += 1;
      if (creates === 2) throw new Error("kv write failed (injected)");
      return realCreate(...callArgs);
    });
    try {
      const result = await runAppSync({ appId });
      const pass = result.passes[0]!;

      expect(result.ok).toBe(false);
      expect(pass.error).toContain("kv write failed (injected)");
      expect(pass).toMatchObject({ pulled: 2, created: 1 });
      expect(rowsOf(appId).map((row) => row.issueKey)).toEqual(["1"]);
      expect(getAppSyncStatus(appId, "issue", "gh")).toMatchObject({ ok: false, created: 1 });
    } finally {
      spy.mockRestore();
    }
  });

  test("single-flight is keyed per source, not per model", async () => {
    createTaskExtended("pool work", { agentId: OWNER_AGENT_ID });
    const script = await fixtureScript("perSource", []);
    await script.setSource(
      `export default async () => { await new Promise((resolve) => setTimeout(resolve, 400)); return ${JSON.stringify(
        [ghRecord(1)],
      )}; };`,
    );
    const appId = createSyncApp(
      appWith({
        issue: {
          columns: {
            ...ISSUE_COLUMNS,
            taskKey: { kind: "string" },
            taskStatus: { kind: "string", source: { of: "pool", field: "status" } },
          },
          sources: {
            gh: ghSource(script.id),
            pool: { connector: "swarm-tasks", joinKey: "taskKey", config: { limit: 50 } },
          },
        },
      }),
    );

    const slow = runAppSync({ appId, source: "gh" });
    // Different source on the same model: this must run, not short-circuit.
    const pool = await runAppSync({ appId, source: "pool" });

    expect(pool.ok).toBe(true);
    expect(pool.passes[0]?.skipped).toBeUndefined();
    expect(pool.passes[0]?.alreadyRunning).toBeUndefined();
    expect(pool.passes[0]?.error).toBeUndefined();
    expect(pool.passes[0]?.created).toBeGreaterThan(0);

    const slowResult = await slow;
    expect(slowResult.ok).toBe(true);
    expect(slowResult.passes[0]).toMatchObject({ source: "gh", created: 1, markedStale: 0 });
    // Each source sweeps only its own rows.
    expect(
      rowsOf(appId)
        .filter((row) => row.source === "pool")
        .every((row) => row.stale === false),
    ).toBe(true);
  });
});

describe("populated-column rebind guard", () => {
  test("rebinding a populated column to another source is rejected like a fresh binding", async () => {
    const script = await fixtureScript("rebind", [ghRecord(1)]);
    const appId = createSyncApp(
      appWith({
        issue: {
          columns: { ...ISSUE_COLUMNS, taskKey: { kind: "string" } },
          sources: {
            gh: ghSource(script.id),
            pool: { connector: "swarm-tasks", joinKey: "taskKey", config: { limit: 50 } },
          },
        },
      }),
    );
    await runAppSync({ appId, source: "gh" });
    expect(rowsOf(appId)[0]?.title).toBe("Issue 1");

    // Move title from gh to pool while a gh-written value exists: the value
    // would be stranded read-only on a row pool never reconciles.
    const rejected = await request<{ issues?: Array<{ path: string; message: string }> }>(
      `/api/apps/${appId}`,
      {
        method: "PATCH",
        body: JSON.stringify({
          definition: {
            models: {
              issue: {
                columns: { title: { kind: "string", source: { of: "pool", field: "prompt" } } },
              },
            },
          },
        }),
      },
    );

    expect(rejected.status).toBe(400);
    expect(
      rejected.body.issues?.some(
        (issue) =>
          issue.path === "models.issue.columns.title.source" &&
          issue.message.includes("binding an existing column"),
      ),
    ).toBe(true);
  });
});

describe("pass snapshot consistency", () => {
  test("a later pass pulls the definition current at ITS start, not selection time", async () => {
    const slow = await fixtureScript("race-slow", []);
    await slow.setSource(
      `export default async () => { await new Promise((resolve) => setTimeout(resolve, 300)); return ${JSON.stringify(
        [ghRecord(1)],
      )}; };`,
    );
    const oldScript = await fixtureScript("race-old", [ghRecord(1, { title: "from-old" })]);
    const newScript = await fixtureScript("race-new", [ghRecord(1, { title: "from-new" })]);
    const definitionWith = (secondId: string) =>
      appWith({
        a: { columns: { ...ISSUE_COLUMNS }, sources: { gh: ghSource(slow.id) } },
        b: { columns: { ...ISSUE_COLUMNS }, sources: { gh: ghSource(secondId) } },
      });
    const appId = createSyncApp(definitionWith(oldScript.id));

    const run = runAppSync({ appId });
    // While pass "a" awaits its slow pull, repoint model b's source. Pass "b"
    // must pull the CURRENT script — pulling the selection-time one while
    // fingerprinting the fresh resolve would commit drifted data silently.
    updateApp(appId, { definition: parsed(definitionWith(newScript.id)) });
    const result = await run;

    expect(result.ok).toBe(true);
    const bRows = rowsOf(appId, "b");
    expect(bRows).toHaveLength(1);
    expect(bRows[0]?.title).toBe("from-new");
  });
});

describe("secret hygiene and sync status", () => {
  test("a pass error carrying a known secret comes back redacted", async () => {
    const secret = "fixture-secret-value-0123456789";
    process.env.APPS_SYNC_FIXTURE_TOKEN = secret;
    refreshSecretScrubberCache();
    try {
      const script = await fixtureScript("secret", []);
      await script.setSource(
        `export default async () => { throw new Error("upstream rejected ${secret}"); };`,
      );
      const appId = createSyncApp(issueDefinition(script.id));

      const result = await runAppSync({ appId });

      expect(result.ok).toBe(false);
      expect(result.passes[0]?.error).toContain("[REDACTED:APPS_SYNC_FIXTURE_TOKEN]");
      expect(result.passes[0]?.error).not.toContain(secret);
      expect(getAppSyncStatus(appId, "issue", "gh")?.error).not.toContain(secret);
    } finally {
      delete process.env.APPS_SYNC_FIXTURE_TOKEN;
      refreshSecretScrubberCache();
    }
  });

  test("sync status records the last pass at the documented key", async () => {
    const script = await fixtureScript("status", [ghRecord(1)]);
    const appId = createSyncApp(issueDefinition(script.id));
    await runAppSync({ appId });

    const entry = getKv(`apps:${appId}`, "sync-status:issue:gh");
    expect(entry).not.toBeNull();
    const ok = getAppSyncStatus(appId, "issue", "gh")!;
    expect(ok).toMatchObject({ ok: true, created: 1, updated: 0, refreshed: 0, markedStale: 0 });
    expect(Object.keys(ok).sort()).toEqual([
      "created",
      "lastFinishedAt",
      "lastStartedAt",
      "markedStale",
      "ok",
      "refreshed",
      "updated",
    ]);
    expect(typeof ok.lastStartedAt).toBe("string");
    expect(Date.parse(ok.lastFinishedAt)).toBeGreaterThanOrEqual(Date.parse(ok.lastStartedAt));
    expect(ok.error).toBeUndefined();

    await script.setSource('export default async () => { throw new Error("pull failed"); };');
    await runAppSync({ appId });

    const failed = getAppSyncStatus(appId, "issue", "gh")!;
    expect(failed.ok).toBe(false);
    expect(failed.error).toContain("pull failed");
    expect(Object.keys(failed).sort()).toEqual([
      "created",
      "error",
      "lastFinishedAt",
      "lastStartedAt",
      "markedStale",
      "ok",
      "refreshed",
      "updated",
    ]);
  });

  test("per-source status rides the app payload once a pass has run", async () => {
    const script = await fixtureScript("payload-status", [ghRecord(1)]);
    const appId = createSyncApp(issueDefinition(script.id));

    // No pass yet: the payload carries no syncStatus key at all.
    const before = await request<{ app: object; syncStatus?: unknown }>(`/api/apps/${appId}`);
    expect(before.status).toBe(200);
    expect(Object.hasOwn(before.body, "syncStatus")).toBe(false);

    await runAppSync({ appId });

    const after = await request<{
      app: object;
      syncStatus?: Record<string, { ok: boolean; created: number; error?: string }>;
    }>(`/api/apps/${appId}`);
    expect(after.status).toBe(200);
    expect(after.body.syncStatus?.["issue:gh"]).toMatchObject({ ok: true, created: 1 });
    expect(Object.keys(after.body.syncStatus ?? {})).toEqual(["issue:gh"]);
  });

  test("app-get carries sync status on both result channels", async () => {
    const script = await fixtureScript("appget-status", [ghRecord(1)]);
    const appId = createSyncApp(issueDefinition(script.id));
    await runAppSync({ appId });

    const appGetTool = registeredTool(registerAppGetTool, "app-get");
    const result = (await appGetTool.handler({ appId }, toolMeta())) as StructuredResult<{
      syncStatus?: Record<string, { ok?: boolean; created?: number }>;
    }> & { content: Array<{ type: string; text?: string }> };

    expect(result.structuredContent.syncStatus?.["issue:gh"]).toMatchObject({
      ok: true,
      created: 1,
    });
    const text = result.content.map((chunk) => chunk.text ?? "").join("\n");
    expect(text).toContain("Sync status (model:source)");
    expect(text).toContain("issue:gh");
  });

  test("a source change invalidates the stale sync status; unrelated edits keep it", async () => {
    const script = await fixtureScript("status-invalidate", [ghRecord(1)]);
    const appId = createSyncApp(issueDefinition(script.id));
    await runAppSync({ appId });
    expect(getAppSyncStatus(appId, "issue", "gh")).not.toBeNull();

    // An unrelated definition edit keeps the pair's freshness.
    const unrelated = await request<{ app: object }>(`/api/apps/${appId}`, {
      method: "PATCH",
      body: JSON.stringify({
        definition: { models: { issue: { columns: { note2: { kind: "string" } } } } },
      }),
    });
    expect(unrelated.status).toBe(200);
    expect(getAppSyncStatus(appId, "issue", "gh")).not.toBeNull();

    // Changing the source's args discards freshness the old config earned:
    // the status would otherwise claim a pass the new config never ran.
    const changed = await request<{ app: object }>(`/api/apps/${appId}`, {
      method: "PATCH",
      body: JSON.stringify({
        definition: issueDefinition(script.id, { args: { repo: "owner/other" } }),
      }),
    });
    expect(changed.status).toBe(200);
    expect(getAppSyncStatus(appId, "issue", "gh")).toBeNull();
  });

  test("an obsolete in-flight pass cannot resurrect invalidated status", async () => {
    const script = await fixtureScript("status-race", [ghRecord(1)]);
    const appId = createSyncApp(issueDefinition(script.id));
    await runAppSync({ appId });
    expect(getAppSyncStatus(appId, "issue", "gh")).not.toBeNull();

    await script.setSource(
      `export default async () => { await new Promise((resolve) => setTimeout(resolve, 300)); return ${JSON.stringify(
        [ghRecord(1)],
      )}; };`,
    );
    const inFlight = runAppSync({ appId });
    // The migration deletes the pair's status while the pull is in the air...
    const changed = await request<{ app: object }>(`/api/apps/${appId}`, {
      method: "PATCH",
      body: JSON.stringify({
        definition: issueDefinition(script.id, { args: { repo: "owner/other" } }),
      }),
    });
    expect(changed.status).toBe(200);
    expect(getAppSyncStatus(appId, "issue", "gh")).toBeNull();

    // ...and the aborted obsolete pass must NOT write it back.
    const result = await inFlight;
    expect(result.ok).toBe(false);
    expect(result.passes[0]?.error).toContain("changed while the pull was running");
    expect(getAppSyncStatus(appId, "issue", "gh")).toBeNull();
  });

  test("a pulled field carrying a known secret is redacted before it lands in a row", async () => {
    const secret = "fixture-secret-value-0123456789";
    process.env.APPS_SYNC_FIXTURE_TOKEN = secret;
    refreshSecretScrubberCache();
    try {
      const script = await fixtureScript("secret-field", [
        ghRecord(1, { title: `deploy key ${secret}` }),
      ]);
      const appId = createSyncApp(issueDefinition(script.id));

      const pass = (await runAppSync({ appId })).passes[0]!;

      expect(pass.error).toBeUndefined();
      const rows = rowsOf(appId);
      expect(rows[0]?.title).toBe("deploy key [REDACTED:APPS_SYNC_FIXTURE_TOKEN]");
      expect(JSON.stringify(rows)).not.toContain(secret);
    } finally {
      delete process.env.APPS_SYNC_FIXTURE_TOKEN;
      refreshSecretScrubberCache();
    }
  });

  test("a secret straddling the prompt cap is scrubbed before truncation", async () => {
    const secret = "fixture-secret-value-0123456789";
    process.env.APPS_SYNC_FIXTURE_TOKEN = secret;
    refreshSecretScrubberCache();
    try {
      // 990 filler chars put the secret across the 1000-char cap: truncating
      // first would strand an unrecognizable 10-char prefix in the row.
      getDb().run("DELETE FROM agent_tasks");
      createTaskExtended("x".repeat(990) + secret, { agentId: OWNER_AGENT_ID });
      const appId = createSyncApp(
        appWith({
          task: {
            columns: {
              taskKey: { kind: "string" },
              prompt: { kind: "string", source: { of: "pool", field: "prompt" } },
            },
            sources: { pool: { connector: "swarm-tasks", joinKey: "taskKey", config: {} } },
          },
        }),
      );

      await runAppSync({ appId });

      const prompt = String(rowsOf(appId, "task", "taskKey")[0]?.prompt);
      expect(prompt).toHaveLength(1000);
      expect(prompt).toContain("[REDACTED");
      expect(prompt).not.toContain(secret.slice(0, 12));
    } finally {
      delete process.env.APPS_SYNC_FIXTURE_TOKEN;
      refreshSecretScrubberCache();
    }
  });

  test("a secret straddling the stderr cap is scrubbed before truncation", async () => {
    const secret = "fixture-secret-value-0123456789";
    process.env.APPS_SYNC_FIXTURE_TOKEN = secret;
    refreshSecretScrubberCache();
    try {
      // 480 filler chars put the secret across the 500-char stderr cap.
      const script = await fixtureScript("stderr-straddle", []);
      await script.setSource(
        `export default async () => { console.error("${"x".repeat(480)}" + ${JSON.stringify(secret)}); process.exit(2); };`,
      );
      const appId = createSyncApp(issueDefinition(script.id));

      const result = await runAppSync({ appId });

      expect(result.ok).toBe(false);
      const error = result.passes[0]?.error ?? "";
      expect(error).toContain("[REDACTED");
      expect(error).not.toContain(secret.slice(0, 12));
    } finally {
      delete process.env.APPS_SYNC_FIXTURE_TOKEN;
      refreshSecretScrubberCache();
    }
  });
});

// ─── Phase 5: the three doors ────────────────────────────────────────────────

type SyncBody = {
  ok?: boolean;
  passes?: SyncPassResult[];
  error?: string;
  issues?: Array<{ path: string; message: string }>;
};

const mutableLegacyPolicy = LEGACY_POLICY as unknown as Record<"app.use", LegacyRule>;

describe("HTTP POST /api/apps/{id}/sync", () => {
  test("runs every declared pair and answers {ok, passes}", async () => {
    const script = await fixtureScript("http-sync", [ghRecord(1), ghRecord(2)]);
    const appId = createSyncApp(issueDefinition(script.id));

    const response = await request<SyncBody>(`/api/apps/${appId}/sync`, {
      method: "POST",
      body: JSON.stringify({}),
    });

    expect(response.status).toBe(200);
    expect(response.body.ok).toBe(true);
    expect(response.body.passes).toHaveLength(1);
    expect(response.body.passes?.[0]).toMatchObject({
      model: "issue",
      source: "gh",
      connector: "script",
      pulled: 2,
      created: 2,
      invokedBy: "operator",
    });
    const rows = rowsOf(appId);
    expect(rows.map((row) => row.issueKey)).toEqual(["1", "2"]);
    expect(rows[0]).toMatchObject({ source: "gh", stale: false, title: "Issue 1" });
    expect(typeof rows[0]?.syncedAt).toBe("string");
  });

  test("narrows to one pair when the body names model and source", async () => {
    const script = await fixtureScript("http-sync-narrow", [ghRecord(9)]);
    const appId = createSyncApp(issueDefinition(script.id));

    const response = await request<SyncBody>(`/api/apps/${appId}/sync`, {
      method: "POST",
      body: JSON.stringify({ model: "issue", source: "gh" }),
    });

    expect(response.status).toBe(200);
    expect(response.body.passes).toHaveLength(1);
    expect(rowsOf(appId)).toHaveLength(1);
  });

  test("404s for an unknown app", async () => {
    const response = await request<{ error: string }>(`/api/apps/${crypto.randomUUID()}/sync`, {
      method: "POST",
      body: JSON.stringify({}),
    });

    expect(response.status).toBe(404);
    expect(response.body.error).toBe("app not found");
  });

  test("400s with path-bearing issues when nothing matches", async () => {
    const script = await fixtureScript("http-sync-nopair", []);
    const withSource = createSyncApp(issueDefinition(script.id));
    const sourceless = createSyncApp(
      appWith({ issue: { columns: ownedIssueColumns() } }),
      "Sourceless app",
    );

    const unknownSource = await request<SyncBody>(`/api/apps/${withSource}/sync`, {
      method: "POST",
      body: JSON.stringify({ source: "nope" }),
    });
    expect(unknownSource.status).toBe(400);
    expect(unknownSource.body.issues).toEqual([
      { path: "source", message: 'unknown source "nope" — no model declares it' },
    ]);

    const unknownModel = await request<SyncBody>(`/api/apps/${withSource}/sync`, {
      method: "POST",
      body: JSON.stringify({ model: "ghost" }),
    });
    expect(unknownModel.status).toBe(400);
    expect(unknownModel.body.issues).toEqual([{ path: "model", message: 'unknown model "ghost"' }]);

    const noSources = await request<SyncBody>(`/api/apps/${sourceless}/sync`, {
      method: "POST",
      body: JSON.stringify({}),
    });
    expect(noSources.status).toBe(400);
    expect(noSources.body.issues).toEqual([
      { path: "appId", message: "no model declares a source to sync" },
    ]);
  });

  test("403s and never pulls when app.use is denied", async () => {
    const script = await fixtureScript("http-sync-denied", [ghRecord(1)]);
    const appId = createSyncApp(issueDefinition(script.id));
    const original = mutableLegacyPolicy["app.use"];
    mutableLegacyPolicy["app.use"] = { ...original, evaluate: () => false };
    try {
      const response = await request<{ error: string }>(`/api/apps/${appId}/sync`, {
        method: "POST",
        body: JSON.stringify({}),
      });
      expect(response.status).toBe(403);
    } finally {
      mutableLegacyPolicy["app.use"] = original;
    }
    expect(rowsOf(appId)).toHaveLength(0);
  });

  test("accepts a request with no body at all", async () => {
    const script = await fixtureScript("http-sync-bodyless", [ghRecord(1)]);
    const appId = createSyncApp(issueDefinition(script.id));

    // No Content-Type, no payload — parseBody must yield {} rather than throw.
    const response = await fetch(`${base}/api/apps/${appId}/sync`, {
      method: "POST",
      headers: { Authorization: `Bearer ${API_KEY}` },
    });
    const body = (await response.json()) as SyncBody;

    expect(response.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.passes).toHaveLength(1);
    expect(rowsOf(appId)).toHaveLength(1);
  });

  test("answers 200 with ok:false when a pass fails", async () => {
    const script = await fixtureScript("http-sync-passfail", []);
    await script.setSource('export default async () => { throw new Error("door pull failed"); };');
    const appId = createSyncApp(issueDefinition(script.id));

    const response = await request<SyncBody & { taskId?: string }>(`/api/apps/${appId}/sync`, {
      method: "POST",
      body: JSON.stringify({}),
    });

    // A failed pull is a reported outcome, not a transport error.
    expect(response.status).toBe(200);
    expect(response.body.ok).toBe(false);
    expect(response.body.issues).toBeUndefined();
    expect(response.body.passes).toHaveLength(1);
    expect(response.body.passes?.[0]?.error).toContain("door pull failed");
    expect(Object.hasOwn(response.body, "taskId")).toBe(false);
    expect(rowsOf(appId)).toHaveLength(0);
  });
});

describe("sync action kind", () => {
  test("answers the script-action shape with no taskId key", async () => {
    const script = await fixtureScript("action-sync", [ghRecord(1)]);
    const definition = issueDefinition(script.id);
    (definition as { actions?: unknown }).actions = { refresh: { kind: "sync" } };
    const appId = createSyncApp(definition);

    const response = await request<{
      ok: boolean;
      result: { passes: SyncPassResult[] };
      durationMs: number;
      taskId?: string;
      error?: string;
    }>(`/api/apps/${appId}/actions/refresh`, {
      method: "POST",
      body: JSON.stringify({ input: {} }),
    });

    expect(response.status).toBe(200);
    // The zero-UI-change contract: app-surface.tsx branches on taskId FIRST.
    expect(Object.hasOwn(response.body, "taskId")).toBe(false);
    expect(response.body.ok).toBe(true);
    expect(response.body.error).toBeUndefined();
    expect(response.body.result.passes).toHaveLength(1);
    expect(response.body.result.passes[0]).toMatchObject({
      model: "issue",
      source: "gh",
      created: 1,
    });
    expect(typeof response.body.durationMs).toBe("number");
    expect(rowsOf(appId)).toHaveLength(1);
  });

  test("reports a failed pass as ok:false plus a named error, still without taskId", async () => {
    const script = await fixtureScript("action-sync-fail", []);
    await script.setSource('export default async () => { throw new Error("pull exploded"); };');
    const definition = issueDefinition(script.id);
    (definition as { actions?: unknown }).actions = {
      refresh: { kind: "sync", model: "issue", source: "gh" },
    };
    const appId = createSyncApp(definition);

    const response = await request<{
      ok: boolean;
      result: { passes: SyncPassResult[] };
      error?: string;
      taskId?: string;
    }>(`/api/apps/${appId}/actions/refresh`, {
      method: "POST",
      body: JSON.stringify({ input: {} }),
    });

    expect(response.status).toBe(200);
    expect(Object.hasOwn(response.body, "taskId")).toBe(false);
    expect(response.body.ok).toBe(false);
    expect(response.body.error).toContain("issue.gh: ");
    expect(response.body.error).toContain("pull exploded");
    expect(response.body.result.passes).toHaveLength(1);
  });

  test("400s with issues when the action selects a pair the app no longer has", async () => {
    const script = await fixtureScript("action-sync-detached", [ghRecord(1)]);
    const definition = issueDefinition(script.id);
    (definition as { actions?: unknown }).actions = { refresh: { kind: "sync" } };
    const appId = createSyncApp(definition);
    // Drop the source behind the action's back — the stored action stays valid.
    const app = getApp(appId)!;
    const models = structuredClone(app.definition.models) as Record<string, ModelDef>;
    delete models.issue?.sources;
    for (const column of Object.values(models.issue?.columns ?? {})) {
      delete (column as { source?: unknown }).source;
    }
    updateApp(appId, { definition: { ...app.definition, models } });

    const response = await request<SyncBody>(`/api/apps/${appId}/actions/refresh`, {
      method: "POST",
      body: JSON.stringify({ input: {} }),
    });

    expect(response.status).toBe(400);
    expect(response.body.issues).toEqual([
      { path: "appId", message: "no model declares a source to sync" },
    ]);
  });
});

describe("app-sync MCP tool", () => {
  test("returns a rendered pass table and the result object", async () => {
    const script = await fixtureScript("mcp-sync", [ghRecord(1), ghRecord(2)]);
    const appId = createSyncApp(issueDefinition(script.id));

    const result = (await syncTool.handler({ appId }, toolMeta())) as StructuredResult<{
      success: boolean;
      message: string;
      details: string;
      ok: boolean;
      passes: SyncPassResult[];
    }>;

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent.success).toBe(true);
    expect(result.structuredContent.ok).toBe(true);
    expect(result.structuredContent.passes).toHaveLength(1);
    expect(result.structuredContent.passes[0]).toMatchObject({
      model: "issue",
      source: "gh",
      created: 2,
      invokedBy: `agent:${OWNER_AGENT_ID}`,
    });
    expect(result.structuredContent.message).toContain("2 created");
    expect(result.structuredContent.details).toContain("| model | source |");
    expect(result.structuredContent.details).toContain("| issue | gh |");
    expect(rowsOf(appId)).toHaveLength(2);
  });

  test("is an error result when a pass fails or nothing matches", async () => {
    const script = await fixtureScript("mcp-sync-fail", []);
    await script.setSource('export default async () => { throw new Error("mcp pull failed"); };');
    const appId = createSyncApp(issueDefinition(script.id));

    const failed = (await syncTool.handler({ appId }, toolMeta())) as StructuredResult<{
      success: boolean;
      details: string;
      ok: boolean;
    }>;
    expect(failed.isError).toBe(true);
    expect(failed.structuredContent.success).toBe(false);
    expect(failed.structuredContent.ok).toBe(false);
    expect(failed.structuredContent.details).toContain("mcp pull failed");

    const nothing = (await syncTool.handler(
      { appId, source: "nope" },
      toolMeta(),
    )) as StructuredResult<{ success: boolean; message: string; details: string }>;
    expect(nothing.isError).toBe(true);
    expect(nothing.structuredContent.message).toContain("Cannot sync");
    expect(nothing.structuredContent.details).toContain('unknown source "nope"');

    const missing = (await syncTool.handler(
      { appId: crypto.randomUUID() },
      toolMeta(),
    )) as StructuredResult<{ success: boolean; message: string }>;
    expect(missing.isError).toBe(true);
    expect(missing.structuredContent.message).toContain("not found");
  });
});

describe("script delete guard", () => {
  /** A model whose only source binding is the join key — patchable to sourceless. */
  function guardDefinition(scriptId: string): Definition {
    return appWith({
      issue: {
        columns: { issueKey: { kind: "string" }, note: { kind: "string" } },
        sources: { gh: { connector: "script", scriptId, joinKey: "issueKey" } },
      },
    });
  }

  async function deleteScriptByName(name: string) {
    return request<{
      deleted?: boolean;
      error?: string;
      issues?: Array<{ path: string; message: string }>;
    }>(`/api/scripts/${name}?scope=global`, { method: "DELETE", agentId: LEAD_AGENT_ID });
  }

  test("409s naming the app and the source path", async () => {
    const name = scriptName("guard-source");
    const scriptId = await saveScript({ name, source: "export default async () => ([]);" });
    const appId = createSyncApp(guardDefinition(scriptId), "Guarded app");

    const blocked = await deleteScriptByName(name);

    expect(blocked.status).toBe(409);
    expect(blocked.body.error).toBe("script is referenced by an app definition");
    expect(blocked.body.issues).toEqual([
      {
        path: `apps.${appId}`,
        message: `app "Guarded app" (${appId}) uses this script at models.issue.sources.gh`,
      },
    ]);
    expect(getApp(appId)).not.toBeNull();
  });

  test("409s when only a script action references it", async () => {
    const name = scriptName("guard-action");
    const scriptId = await saveScript({ name, source: "export default async () => ({});" });
    const definition = appWith({ issue: { columns: { note: { kind: "string" } } } });
    (definition as { actions?: unknown }).actions = { run: { kind: "script", scriptId } };
    const appId = createSyncApp(definition, "Action app");

    const blocked = await deleteScriptByName(name);

    expect(blocked.status).toBe(409);
    expect(blocked.body.issues).toEqual([
      {
        path: `apps.${appId}`,
        message: `app "Action app" (${appId}) uses this script at actions.run`,
      },
    ]);
  });

  test("blocks on a broken definition that still names the script", async () => {
    const name = scriptName("guard-broken");
    const scriptId = await saveScript({ name, source: "export default async () => ([]);" });
    const appId = createSyncApp(guardDefinition(scriptId), "Broken app");
    // Corrupt the stored definition the way a bad hand-edit would.
    getDb().run("UPDATE apps SET definition = ? WHERE id = ?", [
      JSON.stringify({ models: { issue: { sources: { gh: { scriptId } } } }, oops: true }),
      appId,
    ]);
    expect(getApp(appId)?.definitionError).toBeDefined();

    const blocked = await deleteScriptByName(name);

    expect(blocked.status).toBe(409);
    expect(blocked.body.issues?.[0]?.message).toContain(
      "uses this script at models.issue.sources.gh",
    );
  });

  test("blocks on an unparseable definition that still contains the id", async () => {
    const name = scriptName("guard-nonjson");
    const scriptId = await saveScript({ name, source: "export default async () => ([]);" });
    const appId = createSyncApp(guardDefinition(scriptId), "Unparseable app");
    // Not JSON at all: decodeApp cannot even parse it, so the tolerant
    // collector yields nothing and only the raw probe can see the reference.
    getDb().run("UPDATE apps SET definition = ? WHERE id = ?", [`{not json ${scriptId}`, appId]);
    expect(getApp(appId)?.definitionError?.[0]?.message).toContain("invalid stored JSON");

    const blocked = await deleteScriptByName(name);

    expect(blocked.status).toBe(409);
    expect(blocked.body.issues).toEqual([
      {
        path: `apps.${appId}`,
        message: `app "Unparseable app" (${appId}) uses this script at its (unparseable) definition`,
      },
    ]);
  });

  test("the script-delete MCP tool carries the blocking apps in its text channel", async () => {
    const name = scriptName("guard-mcp");
    const scriptId = await saveScript({ name, source: "export default async () => ([]);" });
    const appId = createSyncApp(guardDefinition(scriptId), "MCP guarded app");

    const result = (await scriptDeleteTool.handler(
      { name, scope: "global" },
      toolMeta(LEAD_AGENT_ID),
    )) as StructuredResult<{ success: boolean; message: string; details: string }>;

    expect(result.isError).toBe(true);
    expect(result.structuredContent.success).toBe(false);
    expect(result.structuredContent.message).toContain("referenced by an app definition");
    expect(result.structuredContent.details).toContain(
      `apps.${appId}: app "MCP guarded app" (${appId}) uses this script at models.issue.sources.gh`,
    );
    // Both channels stay consistent — the text channel must carry it too.
    expect(JSON.stringify(result.content)).toContain("models.issue.sources.gh");
    expect(getApp(appId)).not.toBeNull();
  });

  test("succeeds once the source is removed via PATCH", async () => {
    const name = scriptName("guard-removable");
    const scriptId = await saveScript({ name, source: "export default async () => ([]);" });
    const appId = createSyncApp(guardDefinition(scriptId), "Removable app");

    expect((await deleteScriptByName(name)).status).toBe(409);

    const patched = await request<{ app: { definition: { models: Record<string, ModelDef> } } }>(
      `/api/apps/${appId}`,
      {
        method: "PATCH",
        body: JSON.stringify({ definition: { models: { issue: { sources: { gh: null } } } } }),
      },
    );
    expect(patched.status).toBe(200);
    // Deleting the last entry leaves an empty map, not an absent key.
    expect(patched.body.app.definition.models.issue?.sources ?? {}).toEqual({});

    const deleted = await deleteScriptByName(name);
    expect(deleted.status).toBe(200);
    expect(deleted.body.deleted).toBe(true);
  });

  test("still deletes an unreferenced script", async () => {
    const name = scriptName("guard-free");
    await saveScript({ name, source: "export default async () => ([]);" });

    const deleted = await deleteScriptByName(name);

    expect(deleted.status).toBe(200);
    expect(deleted.body.deleted).toBe(true);
  });
});

// ── Catalog seed scripts (Phase 6) ──────────────────────────────────────────

function catalogSource(name: string): string {
  const entry = SEED_SCRIPTS.find((script) => script.name === name);
  if (!entry) throw new Error(`catalog script "${name}" is not registered in SEED_SCRIPTS`);
  return entry.source;
}

/** A GitHub issues-endpoint entry, in the API's own snake_case wire shape. */
function ghApiIssue(number: number, overrides: Record<string, unknown> = {}) {
  return {
    number,
    id: 1000 + number,
    title: `Issue ${number}`,
    state: "open",
    body: `body ${number}`,
    user: { login: "ada" },
    labels: [{ name: "bug" }, { name: "p1" }],
    comments: 3,
    html_url: `https://github.com/owner/name/issues/${number}`,
    created_at: "2026-01-02T03:04:05Z",
    updated_at: "2026-01-03T03:04:05Z",
    ...overrides,
  };
}

/** The same endpoint interleaves pull requests; only PR entries carry `pull_request`. */
function ghApiPull(number: number) {
  return { ...ghApiIssue(number), pull_request: { url: `https://api.github.com/pulls/${number}` } };
}

describe("github-issues-pull", () => {
  // The script reaches GitHub through ctx.stdlib.fetchJson, which bottoms out in
  // globalThis.fetch. Stub that (never mock.module — it leaks process-wide) and
  // hand the script the real stdlib so the fetch layer under test is the real one.
  const stdlibCtx = { stdlib: { fetchJson: runtimeFetchJson } };
  let originalFetch: typeof globalThis.fetch;
  let lastRequest: { url: string; headers: Headers } | undefined;
  let fetchCalls = 0;

  function stubGithub(body: unknown, status = 200) {
    globalThis.fetch = (async (input: unknown, init?: { headers?: Record<string, string> }) => {
      fetchCalls += 1;
      lastRequest = { url: String(input), headers: new Headers(init?.headers ?? {}) };
      return new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof globalThis.fetch;
  }

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    lastRequest = undefined;
    fetchCalls = 0;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("filters out pull requests and projects flat camelCase fields", async () => {
    stubGithub([ghApiIssue(1), ghApiPull(2), ghApiIssue(3)]);

    const result = (await githubIssuesPull({ repo: "owner/name" }, stdlibCtx)) as {
      records: Array<{ key: string; fields: Record<string, unknown> }>;
      complete: boolean;
    };

    expect(result.records.map((record) => record.key)).toEqual(["1", "3"]);
    expect(result.records[0]).toEqual({
      key: "1",
      fields: {
        number: 1,
        id: 1001,
        title: "Issue 1",
        state: "open",
        body: "body 1",
        userLogin: "ada",
        labelsCsv: "bug,p1",
        comments: 3,
        htmlUrl: "https://github.com/owner/name/issues/1",
        createdAt: "2026-01-02T03:04:05Z",
        updatedAt: "2026-01-03T03:04:05Z",
      },
    });
    expect(result.complete).toBe(true);
    expect(lastRequest?.url).toBe(
      "https://api.github.com/repos/owner/name/issues?state=open&per_page=100",
    );
    expect(lastRequest?.headers.get("accept")).toBe("application/vnd.github+json");
    expect(lastRequest?.headers.get("user-agent")).toBe("agent-swarm-apps-sync");
    // The script hands the egress layer a placeholder, never secret material.
    expect(lastRequest?.headers.get("authorization")).toBe("Bearer [REDACTED:GITHUB_TOKEN]");
  });

  test("forwards state and limit to the issues query", async () => {
    stubGithub([]);

    await githubIssuesPull({ repo: "owner/name", state: "all", limit: 25 }, stdlibCtx);

    expect(lastRequest?.url).toBe(
      "https://api.github.com/repos/owner/name/issues?state=all&per_page=25",
    );
  });

  test("echoes the connection slug back without otherwise using it", async () => {
    stubGithub([ghApiIssue(1)]);

    const result = (await githubIssuesPull(
      { repo: "owner/name", connection: "ghApp" },
      stdlibCtx,
    )) as { connection: string };

    expect(result.connection).toBe("ghApp");
    // Credentials resolve at the egress layer for the run-as identity — naming a
    // connection changes nothing about the request the script builds.
    expect(lastRequest?.url).toBe(
      "https://api.github.com/repos/owner/name/issues?state=open&per_page=100",
    );
    expect(lastRequest?.headers.get("authorization")).toBe("Bearer [REDACTED:GITHUB_TOKEN]");
  });

  test("a full raw page reports an incomplete window even after PRs are filtered out", async () => {
    stubGithub([ghApiIssue(1), ghApiPull(2)]);

    const result = (await githubIssuesPull({ repo: "owner/name", limit: 2 }, stdlibCtx)) as {
      records: unknown[];
      complete: boolean;
    };

    // Two raw entries filled the page even though only one survived filtering.
    expect(result.records).toHaveLength(1);
    expect(result.complete).toBe(false);
  });

  test("a short raw page reports a complete window", async () => {
    stubGithub([ghApiIssue(1)]);

    const result = (await githubIssuesPull({ repo: "owner/name", limit: 2 }, stdlibCtx)) as {
      complete: boolean;
    };

    expect(result.complete).toBe(true);
  });

  test("returns the full body untruncated for the engine to scrub whole", async () => {
    stubGithub([ghApiIssue(1, { body: "x".repeat(5000) })]);

    const result = (await githubIssuesPull({ repo: "owner/name" }, stdlibCtx)) as {
      records: Array<{ fields: { body: string } }>;
    };

    // Truncating in the script would run BEFORE the engine's scrub and could
    // split a secret across the cut; the complete value must travel back.
    expect(result.records[0]?.fields.body).toHaveLength(5000);
  });

  for (const repo of ["owner", "owner/name/extra", "../name", "owner/..", "/name", "owner/"]) {
    test(`rejects the malformed repo "${repo}" without a request`, async () => {
      stubGithub([ghApiIssue(1)]);

      await expect(githubIssuesPull({ repo }, stdlibCtx)).rejects.toThrow("owner/name");
      expect(fetchCalls).toBe(0);
    });
  }

  test("rejects a missing repo as invalid args", async () => {
    stubGithub([ghApiIssue(1)]);

    await expect(githubIssuesPull({}, stdlibCtx)).rejects.toThrow("invalid args");
    expect(fetchCalls).toBe(0);
  });

  test("a non-2xx response throws with GitHub's own message", async () => {
    stubGithub({ message: "API rate limit exceeded" }, 403);

    // A returned {error} object would exit 0 and reach the engine as a generic
    // invalid-payload error; throwing preserves the cause via scriptFailure.
    await expect(githubIssuesPull({ repo: "owner/name" }, stdlibCtx)).rejects.toThrow(
      "API rate limit exceeded",
    );
  });
});

describe("apps-sync catalog registration", () => {
  for (const name of ["github-issues-pull", "app-sync-run"]) {
    test(`${name} is registered and typechecks against the live SDK`, () => {
      const entry = SEED_SCRIPTS.find((script) => script.name === name);
      expect(entry).toBeDefined();
      expect(entry?.description.length).toBeGreaterThan(0);
      expect(entry?.intent.length).toBeGreaterThan(0);

      expect(validateScriptImports(entry?.source ?? "").ok).toBe(true);
      const typecheck = typecheckScript(entry?.source ?? "");
      expect(typecheck.ok ? [] : typecheck.diagnostics).toEqual([]);
    });
  }

  test("the source script uses placeholder auth and never reads secrets", () => {
    const source = catalogSource("github-issues-pull");

    expect(source).toContain("Bearer [REDACTED:GITHUB_TOKEN]");
    expect(source).not.toContain("includeSecrets");
    expect(source).not.toContain("Redacted.value");
    // Seeded scripts are typechecked against the LIVE connection registry, which
    // is empty on a fresh DB — a ctx.api.<slug> reference would fail boot seeding.
    expect(source).not.toContain("ctx.api.");
  });

  test("app-sync-run just forwards to the app_sync tool", () => {
    const source = catalogSource("app-sync-run");

    expect(source).toContain("ctx.swarm.app_sync");
  });

  test("app-sync-run throws when the sync payload reports failure", async () => {
    // The bridge answers HTTP 200 with a structured error payload; returning
    // it would exit 0 and the scheduler would record a successful run.
    const failing = {
      swarm: {
        app_sync: async () => ({
          success: true,
          status: 200,
          data: { success: false, ok: false, error: "pass failed: boom" },
        }),
      },
    };
    await expect(appSyncRun({ appId: "app-1" }, failing)).rejects.toThrow("pass failed: boom");
  });

  test("app-sync-run returns the payload when the sync succeeded", async () => {
    const okCtx = {
      swarm: {
        app_sync: async () => ({
          success: true,
          status: 200,
          data: { success: true, ok: true, passes: [] },
        }),
      },
    };
    const result = (await appSyncRun({ appId: "app-1" }, okCtx)) as { success: boolean };
    expect(result.success).toBe(true);
  });

  test("app-sync-run rejects invalid args without calling the tool", async () => {
    await expect(appSyncRun({}, { swarm: {} })).rejects.toThrow("invalid args");
  });
});

describe("a sync source against a dummy GitHub through the real sandbox", () => {
  // The real path end to end: runSavedScriptAsAgent -> sandbox subprocess ->
  // patched fetch -> a Bun.serve fixture on 127.0.0.1. Nothing reaches GitHub.
  //
  // Egress note: the sandbox's network is open, so no allowlist entry is needed
  // to REACH the fixture. The allowlist governs secret SUBSTITUTION only, and
  // that is the point of these tests: GITHUB_TOKEN's binding is allowlisted to
  // api.github.com, so an active binding exists while the fixture host does not
  // match it — the placeholder must therefore leave the sandbox unsubstituted.
  const FIXTURE_TOKEN = "ghp_fixture_secret_value_9876543210";

  let fixture: ReturnType<typeof Bun.serve>;
  let origin = "";
  let seen: { path: string; authorization: string | null } | undefined;
  let nextPage: (echo: { authorization: string | null }) => unknown[] = () => [];
  let releaseStall: (() => void) | undefined;

  /** The shipped catalog script, repointed at the fixture. Same logic, no GitHub. */
  function fixtureSource(): string {
    return catalogSource("github-issues-pull").replace("https://api.github.com", origin);
  }

  function fixtureDefinition(scriptId: string, args: Record<string, unknown>): Definition {
    return appWith({
      issue: {
        columns: {
          issueKey: { kind: "string" },
          title: { kind: "string", source: { of: "gh", field: "title" } },
          userLogin: { kind: "string", source: { of: "gh", field: "userLogin" } },
          comments: { kind: "number", source: { of: "gh", field: "comments" } },
        },
        sources: { gh: { connector: "script", scriptId, joinKey: "issueKey", args } },
      },
    });
  }

  beforeAll(() => {
    // Mints the default GITHUB_TOKEN credential binding (allowlisted to
    // api.github.com) for every run-as identity.
    process.env.GITHUB_TOKEN = FIXTURE_TOKEN;
    refreshSecretScrubberCache();
    fixture = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: async (req: Request) => {
        const url = new URL(req.url);
        const authorization = req.headers.get("authorization");
        seen = { path: url.pathname + url.search, authorization };
        if (url.pathname === "/stall") {
          await new Promise<void>((resolve) => {
            releaseStall = resolve;
          });
        }
        return new Response(JSON.stringify(nextPage({ authorization })), {
          headers: {
            "content-type": "application/json",
            // Echo what the fixture actually received back to the caller.
            "x-echo-authorization": authorization ?? "<none>",
          },
        });
      },
    });
    origin = `http://127.0.0.1:${fixture.port}`;
  });

  afterAll(() => {
    releaseStall?.();
    fixture.stop(true);
    delete process.env.GITHUB_TOKEN;
    refreshSecretScrubberCache();
  });

  beforeEach(() => {
    seen = undefined;
    nextPage = () => [];
  });

  test("a successful pull creates rows from the fixture's page", async () => {
    nextPage = () => [ghApiIssue(1), ghApiPull(2), ghApiIssue(3)];
    const scriptId = await saveScript({ name: scriptName("fixture-ok"), source: fixtureSource() });
    const appId = createSyncApp(fixtureDefinition(scriptId, { repo: "owner/name", limit: 100 }));

    const pass = (await runAppSync({ appId })).passes[0]!;

    expect(pass.error).toBeUndefined();
    expect(pass).toMatchObject({ pulled: 2, created: 2 });
    expect(pass.staleSweepSkipped).toBeUndefined();
    expect(seen?.path).toBe("/repos/owner/name/issues?state=open&per_page=100");
    const rows = rowsOf(appId);
    expect(rows.map((row) => row.issueKey)).toEqual(["1", "3"]);
    expect(rows[0]).toMatchObject({
      issueKey: "1",
      title: "Issue 1",
      userLogin: "ada",
      comments: 3,
      source: "gh",
      stale: false,
    });
  });

  test("a full page at the limit skips the stale sweep", async () => {
    const scriptId = await saveScript({
      name: scriptName("fixture-page"),
      source: fixtureSource(),
    });
    const appId = createSyncApp(fixtureDefinition(scriptId, { repo: "owner/name", limit: 2 }));

    nextPage = () => [ghApiIssue(10)];
    const first = (await runAppSync({ appId })).passes[0]!;
    expect(first).toMatchObject({ created: 1 });
    expect(first.staleSweepSkipped).toBeUndefined();

    // A raw page of exactly `limit` entries, one of which is a PR: the window is
    // incomplete even though only one record survives filtering.
    nextPage = () => [ghApiIssue(11), ghApiPull(12)];
    const second = (await runAppSync({ appId })).passes[0]!;

    expect(second).toMatchObject({
      pulled: 1,
      created: 1,
      markedStale: 0,
      staleSweepSkipped: true,
    });
    expect(second.warnings.some((warning) => warning.includes("stale sweep skipped"))).toBe(true);
    // The row the incomplete window never saw must survive.
    expect(rowsOf(appId).find((row) => row.issueKey === "10")?.stale).toBe(false);
  });

  test("a fetch that outlives its timeout fails the pass with zero row churn", async () => {
    const name = scriptName("fixture-timeout");
    const scriptId = await saveScript({ name, source: fixtureSource() });
    const appId = createSyncApp(fixtureDefinition(scriptId, { repo: "owner/name", limit: 100 }));
    nextPage = () => [ghApiIssue(30)];
    await runAppSync({ appId });
    const before = rowSnapshot(appId);

    // Bare fetch, not ctx.stdlib.fetch: the stdlib wrapper retries three times,
    // so an external abort there costs three stalled attempts instead of one.
    await saveScript({
      name,
      source: `export default async () => {
        await fetch("${origin}/stall", { signal: AbortSignal.timeout(300) });
        return [];
      };`,
    });
    const result = await runAppSync({ appId });

    expect(result.ok).toBe(false);
    expect(result.passes[0]?.error).toContain("TimeoutError");
    expect(result.passes[0]).toMatchObject({ pulled: 0, created: 0, updated: 0, markedStale: 0 });
    expect(rowSnapshot(appId)).toBe(before);
    releaseStall?.();
  });

  test("the fixture never sees the token — the unresolved placeholder header is dropped", async () => {
    // An ACTIVE binding for this identity — otherwise the assertion is vacuous.
    const bindings = await buildScriptCredentialBindingsWithFailures({ agentId: LEAD_AGENT_ID });
    const github = bindings.egressSecrets.find((secret) => secret.configKey === "GITHUB_TOKEN");
    expect(github?.value).toBe(FIXTURE_TOKEN);
    expect(github?.allowedHosts).toEqual(["api.github.com"]);

    // The fixture echoes the Authorization header it received into the record it
    // serves, so the projected row carries whatever actually left the sandbox.
    nextPage = (echo) => [ghApiIssue(40, { title: echo.authorization })];
    const scriptId = await saveScript({
      name: scriptName("fixture-auth"),
      source: fixtureSource(),
    });
    const appId = createSyncApp(fixtureDefinition(scriptId, { repo: "owner/name", limit: 100 }));

    const result = await runAppSync({ appId });

    // The fixture host is not allowlisted for the binding, so the placeholder
    // header is DROPPED before egress: no auth reaches it — never the token.
    expect(seen?.authorization ?? null).toBeNull();
    expect(rowsOf(appId)[0]?.title ?? null).toBeNull();
    expect(JSON.stringify(rowsOf(appId))).not.toContain(FIXTURE_TOKEN);
    expect(JSON.stringify(result)).not.toContain(FIXTURE_TOKEN);
    expect(JSON.stringify(getAppSyncStatus(appId, "issue", "gh"))).not.toContain(FIXTURE_TOKEN);
  });
});
