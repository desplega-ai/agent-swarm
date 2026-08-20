import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { closeDb, createAgent, createUser, getDbClient, getTaskById, initDb } from "../be/db";
import { upsertScriptByName } from "../be/scripts/db";
import { type IdentityActor, mintToken } from "../be/users";
import { handleApps } from "../http/apps";
import { resolveHttpRequestAuth } from "../http/auth";
import { getPathSegments, parseQueryParams } from "../http/utils";
import { clearAuditSink, LEGACY_POLICY, type LegacyRule, setAuditSink } from "../rbac";
import type { RbacCheck } from "../rbac/types";
import { registerAppDiffTool } from "../tools/app-diff";
import { registerAppGetTool, registerAppQueryTool } from "../tools/app-get";
import { registerAppHistoryTool } from "../tools/app-history";
import { registerAppPatchTool } from "../tools/app-patch";
import { setRequestAuth } from "../utils/request-auth-context";

const TEST_DB_PATH = `/private/tmp/test-apps-rbac-${process.pid}.sqlite`;
const API_KEY = "apps-rbac-test-key";
const AGENT_ID = crypto.randomUUID();
const LEAD_ID = crypto.randomUUID();
const OPERATOR_ACTOR: IdentityActor = { kind: "operator", id: "apps-rbac-test" };

const definition = {
  models: { note: { columns: { title: { kind: "string" } } } },
  queries: { allNotes: { model: "note" } },
  actions: { triage: { kind: "task", prompt: "Triage this note." } },
  pages: { main: { root: "root", elements: { root: { type: "Container", props: {} } } } },
  defaultPage: "main",
};

type Principal = "operator" | "user" | "agent";
type AppPermissionVerb = "app.use" | "app.manage";
type RegisteredTool = { handler: (args: unknown, extra: unknown) => Promise<unknown> };

const mutableLegacyPolicy = LEGACY_POLICY as unknown as Record<AppPermissionVerb, LegacyRule>;

let server: Server;
let base = "";
let userId = "";
let userToken = "";
let appId = "";
let tools: Record<string, RegisteredTool>;

function headers(principal: Principal): HeadersInit {
  if (principal === "operator") return { Authorization: `Bearer ${API_KEY}` };
  if (principal === "user") return { Authorization: `Bearer ${userToken}` };
  return { "X-Agent-ID": AGENT_ID };
}

function createTestServer(): Server {
  return createHttpServer(async (req: IncomingMessage, res: ServerResponse) => {
    setRequestAuth(req, await resolveHttpRequestAuth(req, API_KEY));
    res.setHeader("Content-Type", "application/json");
    const pathSegments = getPathSegments(req.url || "");
    const queryParams = parseQueryParams(req.url || "");
    const myAgentId = req.headers["x-agent-id"] as string | undefined;
    if (await handleApps(req, res, pathSegments, queryParams, myAgentId)) return;
    res.writeHead(404);
    res.end(JSON.stringify({ error: "not found" }));
  });
}

async function request<T>(
  path: string,
  principal: Principal,
  init: RequestInit = {},
): Promise<{ status: number; body: T }> {
  const response = await fetch(`${base}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...headers(principal),
      ...init.headers,
    },
  });
  return { status: response.status, body: (await response.json()) as T };
}

async function createFixtureApp(): Promise<string> {
  const result = await request<{ app: { id: string } }>("/api/apps", "operator", {
    method: "POST",
    body: JSON.stringify({ name: "RBAC fixture", definition }),
  });
  expect(result.status).toBe(201);
  return result.body.app.id;
}

function expectAppCheck(
  checks: RbacCheck[],
  principal: Principal,
  verb: AppPermissionVerb,
  expectedAppId: string,
): void {
  const check = checks.find(
    (candidate) => candidate.principal.kind === principal && candidate.verb === verb,
  );
  expect(check).toBeDefined();
  expect(check?.resource).toEqual({ kind: "app", appId: expectedAppId });
}

async function expectDeniedHttpCheck(
  checks: RbacCheck[],
  verb: AppPermissionVerb,
  path: string,
  init: RequestInit = {},
): Promise<void> {
  const before = checks.length;
  expect((await request<unknown>(path, "operator", init)).status).toBe(403);
  expect(checks.slice(before)).toEqual([
    {
      principal: { kind: "operator" },
      verb,
      resource: { kind: "app", appId },
      source: "http",
    },
  ]);
}

function registeredTools(): Record<string, RegisteredTool> {
  const toolServer = new McpServer({ name: "apps-rbac-test", version: "1.0.0" });
  registerAppGetTool(toolServer);
  registerAppQueryTool(toolServer);
  registerAppHistoryTool(toolServer);
  registerAppDiffTool(toolServer);
  registerAppPatchTool(toolServer);
  return (toolServer as unknown as { _registeredTools: Record<string, RegisteredTool> })
    ._registeredTools;
}

async function callTool(name: string, args: unknown): Promise<unknown> {
  const handler = tools[name]?.handler;
  if (!handler) throw new Error(`Tool not registered: ${name}`);
  return handler(args, {
    sessionId: "apps-rbac-test",
    requestInfo: { headers: { "x-agent-id": AGENT_ID } },
  });
}

beforeAll(async () => {
  for (const suffix of ["", "-wal", "-shm"]) {
    await unlink(`${TEST_DB_PATH}${suffix}`).catch(() => undefined);
  }
  initDb(TEST_DB_PATH);
  await createAgent({ id: AGENT_ID, name: "apps-rbac-worker", isLead: false, status: "idle" });
  await createAgent({ id: LEAD_ID, name: "apps-rbac-lead", isLead: true, status: "idle" });
  const user = await createUser({ name: "Apps RBAC User" });
  userId = user.id;
  userToken = (await mintToken(user.id, "apps-rbac", OPERATOR_ACTOR)).plaintext;
  tools = registeredTools();
  server = createTestServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server did not bind a port");
  base = `http://127.0.0.1:${address.port}`;
});

beforeEach(async () => {
  clearAuditSink();
  await getDbClient().run("DELETE FROM agent_tasks");
  await getDbClient().run("DELETE FROM kv_entries WHERE namespace LIKE 'apps:%'");
  await getDbClient().run("DELETE FROM apps");
  appId = await createFixtureApp();
  clearAuditSink();
});

afterEach(() => {
  clearAuditSink();
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  closeDb();
  for (const suffix of ["", "-wal", "-shm"]) {
    await unlink(`${TEST_DB_PATH}${suffix}`).catch(() => undefined);
  }
});

describe("app.use and app.manage plumbing", () => {
  test("operator, user, and agent principals reach can() on both surfaces", async () => {
    const checks: RbacCheck[] = [];
    setAuditSink((check) => checks.push(check));

    expect((await request(`/api/apps/${appId}`, "operator")).status).toBe(200);
    expect((await request(`/api/apps/${appId}/models/note/rows`, "user")).status).toBe(200);
    expect((await request(`/api/apps/${appId}/queries/allNotes`, "agent")).status).toBe(200);
    expect((await request(`/api/apps/${appId}/versions`, "operator")).status).toBe(200);
    expect(
      (
        await request(`/api/apps/${appId}`, "user", {
          method: "PATCH",
          body: JSON.stringify({ description: "user managed" }),
        })
      ).status,
    ).toBe(200);
    expect((await request(`/api/apps/${appId}/versions`, "agent")).status).toBe(200);

    expectAppCheck(checks, "operator", "app.use", appId);
    expectAppCheck(checks, "user", "app.use", appId);
    expectAppCheck(checks, "agent", "app.use", appId);
    expectAppCheck(checks, "operator", "app.manage", appId);
    expectAppCheck(checks, "user", "app.manage", appId);
    expectAppCheck(checks, "agent", "app.manage", appId);
  });

  test("all per-app use routes fail closed through scoped app.use checks", async () => {
    const checks: RbacCheck[] = [];
    const original = mutableLegacyPolicy["app.use"];
    mutableLegacyPolicy["app.use"] = { ...original, evaluate: () => false };
    setAuditSink((check) => checks.push(check));
    try {
      await expectDeniedHttpCheck(checks, "app.use", `/api/apps/${appId}`);
      await expectDeniedHttpCheck(checks, "app.use", `/api/apps/${appId}/models/note/rows`, {
        method: "POST",
        body: JSON.stringify({ values: { title: "deny fixture" } }),
      });
      await expectDeniedHttpCheck(checks, "app.use", `/api/apps/${appId}/models/note/rows/bulk`, {
        method: "POST",
        body: JSON.stringify({ rows: [] }),
      });
      await expectDeniedHttpCheck(checks, "app.use", `/api/apps/${appId}/models/note/rows`);
      await expectDeniedHttpCheck(
        checks,
        "app.use",
        `/api/apps/${appId}/models/note/rows/not-a-row`,
      );
      await expectDeniedHttpCheck(
        checks,
        "app.use",
        `/api/apps/${appId}/models/note/rows/not-a-row`,
        { method: "PATCH", body: JSON.stringify({ values: { title: "denied" } }) },
      );
      await expectDeniedHttpCheck(
        checks,
        "app.use",
        `/api/apps/${appId}/models/note/rows/not-a-row`,
        { method: "DELETE" },
      );
      await expectDeniedHttpCheck(checks, "app.use", `/api/apps/${appId}/queries/allNotes`);
      await expectDeniedHttpCheck(checks, "app.use", `/api/apps/${appId}/actions/triage`, {
        method: "POST",
        body: JSON.stringify({ input: {} }),
      });
    } finally {
      mutableLegacyPolicy["app.use"] = original;
    }
  });

  test("app definition PATCH fails closed through a scoped app.manage check", async () => {
    const checks: RbacCheck[] = [];
    const original = mutableLegacyPolicy["app.manage"];
    mutableLegacyPolicy["app.manage"] = { ...original, evaluate: () => false };
    setAuditSink((check) => checks.push(check));
    try {
      await expectDeniedHttpCheck(checks, "app.manage", `/api/apps/${appId}`, {
        method: "PATCH",
        body: JSON.stringify({ description: "denied" }),
      });
    } finally {
      mutableLegacyPolicy["app.manage"] = original;
    }
  });

  test("MCP app-get and app-query use app.use with the app resource", async () => {
    const checks: RbacCheck[] = [];
    setAuditSink((check) => checks.push(check));

    await callTool("app-get", { appId });
    await callTool("app-query", { appId, query: "allNotes" });

    const appUseChecks = checks.filter((check) => check.verb === "app.use");
    expect(appUseChecks).toHaveLength(2);
    for (const check of appUseChecks) {
      expect(check.source).toBe("mcp");
      expect(check.resource).toEqual({ kind: "app", appId });
    }
  });

  test("MCP app-manage tools use app.manage with the app resource", async () => {
    const checks: RbacCheck[] = [];
    setAuditSink((check) => checks.push(check));

    await callTool("app-history", { appId });
    await callTool("app-diff", { appId });
    await callTool("app-patch", { appId, definition: {} });

    const manageChecks = checks.filter((check) => check.verb === "app.manage");
    expect(manageChecks).toHaveLength(3);
    for (const check of manageChecks) {
      expect(check.source).toBe("mcp");
      expect(check.resource).toEqual({ kind: "app", appId });
    }
  });
});

describe("app viewer identity", () => {
  test("row provenance and task actions preserve the viewer user", async () => {
    const userRow = await request<{ row: { createdBy: string } }>(
      `/api/apps/${appId}/models/note/rows`,
      "user",
      { method: "POST", body: JSON.stringify({ values: { title: "user row" } }) },
    );
    expect(userRow.status).toBe(201);
    expect(userRow.body.row.createdBy).toBe(`user:${userId}`);

    const operatorRow = await request<{ row: { createdBy: string } }>(
      `/api/apps/${appId}/models/note/rows`,
      "operator",
      { method: "POST", body: JSON.stringify({ values: { title: "operator row" } }) },
    );
    expect(operatorRow.status).toBe(201);
    expect(operatorRow.body.row.createdBy).toBe("operator");

    const action = await request<{ taskId: string }>(`/api/apps/${appId}/actions/triage`, "user", {
      method: "POST",
      body: JSON.stringify({ input: { note: "user viewer" } }),
    });
    expect(action.status).toBe(200);
    expect((await getTaskById(action.body.taskId))?.requestedByUserId).toBe(userId);

    const operatorAction = await request<{ taskId: string }>(
      `/api/apps/${appId}/actions/triage`,
      "operator",
      { method: "POST", body: JSON.stringify({ input: { note: "operator viewer" } }) },
    );
    expect(operatorAction.status).toBe(200);
    expect((await getTaskById(operatorAction.body.taskId))?.requestedByUserId).toBeUndefined();

    const agentAction = await request<{ taskId: string }>(
      `/api/apps/${appId}/actions/triage`,
      "agent",
      { method: "POST", body: JSON.stringify({ input: { note: "agent viewer" } }) },
    );
    expect(agentAction.status).toBe(200);
    expect((await getTaskById(agentAction.body.taskId))?.requestedByUserId).toBeUndefined();
  });
});

describe("user writers and the script ownership gate", () => {
  async function saveScript(scope: "agent" | "global", ownerId: string | null): Promise<string> {
    const result = await upsertScriptByName({
      name: `apps_rbac_${scope}_${crypto.randomUUID().replaceAll("-", "")}`,
      scope,
      scopeId: ownerId,
      agentId: ownerId,
      source: "export default function run() { return { ok: true }; }",
      description: "Ownership-gate fixture",
      intent: "Prove the user-writer ownership gate",
      signatureJson: JSON.stringify({ args: { type: "object" }, result: { type: "object" } }),
      typeChecked: true,
      embeddingMode: "skip",
    });
    return result.script.id;
  }

  function withSource(scriptId: string) {
    return {
      ...definition,
      models: {
        note: {
          columns: {
            title: { kind: "string" },
            issueKey: { kind: "string" },
            body: { kind: "string", source: { of: "gh", field: "body" } },
          },
          sources: { gh: { connector: "script", scriptId, joinKey: "issueKey" } },
        },
      },
    };
  }

  test("a web user cannot wire agent-scoped or catalog scripts; stored paths stay editable", async () => {
    const ownerId = crypto.randomUUID();
    await createAgent({
      id: ownerId,
      name: "apps-rbac-script-owner",
      isLead: false,
      status: "idle",
    });
    const foreignId = await saveScript("agent", ownerId);
    const globalId = await saveScript("global", null);
    type Issues = { issues?: Array<{ path: string; message: string }> };

    // A user write carries no agent id — it must NOT pass like the operator.
    const asSource = await request<Issues>("/api/apps", "user", {
      method: "POST",
      body: JSON.stringify({ name: "User foreign source", definition: withSource(foreignId) }),
    });
    expect(asSource.status).toBe(400);
    expect(
      asSource.body.issues?.some(
        (issue) =>
          issue.path === "models.note.sources.gh.scriptId" &&
          issue.message.includes("agent-scoped to another agent"),
      ),
    ).toBe(true);

    const asAction = await request<Issues>("/api/apps", "user", {
      method: "POST",
      body: JSON.stringify({
        name: "User foreign action",
        definition: {
          ...definition,
          actions: { steal: { kind: "script", scriptId: foreignId } },
        },
      }),
    });
    expect(asAction.status).toBe(400);
    expect(
      asAction.body.issues?.some(
        (issue) =>
          issue.path === "actions.steal.scriptId" &&
          issue.message.includes("agent-scoped to another agent"),
      ),
    ).toBe(true);

    // Owner-less global (catalog) scripts sync with the LEAD's credentials —
    // a user may not wire those as sources either.
    const globalApp = await request<Issues>("/api/apps", "user", {
      method: "POST",
      body: JSON.stringify({ name: "User global source", definition: withSource(globalId) }),
    });
    expect(globalApp.status).toBe(400);
    expect(
      globalApp.body.issues?.some(
        (issue) =>
          issue.path === "models.note.sources.gh.scriptId" &&
          issue.message.includes("only that agent or the operator"),
      ),
    ).toBe(true);

    // An operator-authored app carrying the foreign script at a stored path
    // stays editable for users — grandfathering is path-exact, not skipped.
    const operatorApp = await request<{ app: { id: string } }>("/api/apps", "operator", {
      method: "POST",
      body: JSON.stringify({
        name: "Operator foreign action",
        definition: { ...definition, actions: { run: { kind: "script", scriptId: foreignId } } },
      }),
    });
    expect(operatorApp.status).toBe(201);

    const edited = await request<Issues>(`/api/apps/${operatorApp.body.app.id}`, "user", {
      method: "PATCH",
      body: JSON.stringify({
        definition: { models: { note: { columns: { extra: { kind: "string" } } } } },
      }),
    });
    expect(edited.status).toBe(200);
  });
});
