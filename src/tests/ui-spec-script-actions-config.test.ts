/**
 * `UI_SPEC_SCRIPT_ACTIONS` is human-only: only an admin user may write or
 * delete it. The operator key (held by every worker), agents (the Lead
 * included), guests and page sessions are refused, on the HTTP routes, the
 * HITL config answer path and MCP tools.
 */
import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { createServer, type Server } from "node:http";
import { closeDb, createAgent, createUser, initDb, upsertSwarmConfig } from "../be/db";
import { attachRole, setUserRoles } from "../be/rbac-roles";
import { validateConfigValue } from "../be/swarm-config-guard";
import { findUserById } from "../be/users";
import { handleApprovalRequests } from "../http/approval-requests";
import { handleConfig } from "../http/config";
import * as core from "../http/core";
import { getPathSegments, parseQueryParams } from "../http/utils";
import { registerDeleteConfigTool } from "../tools/swarm-config/delete-config";
import { registerSetConfigTool } from "../tools/swarm-config/set-config";
import { setRequestAuth } from "../utils/request-auth-context";
import { listenOnFreePort } from "./test-net";

const KEY = "UI_SPEC_SCRIPT_ACTIONS";
const PIN = "github-metrics@0123456789abcdef";
const LEAD_ID = "22222222-2222-4222-8222-222222222222";

type ToolResult = { structuredContent?: { success?: boolean; message?: string } };
const tools = new Map<string, (args: unknown, meta: unknown) => Promise<ToolResult>>();
const mcp = {
  registerTool(
    name: string,
    _config: unknown,
    handler: (a: unknown, m: unknown) => Promise<ToolResult>,
  ) {
    tools.set(name, handler);
    return { name };
  },
};

let server: Server;
let baseUrl: string;
let adminId = "";
let plainUserId = "";
const reloadSpy = spyOn(core, "scheduleIntegrationsReload").mockImplementation(() => {});
const PAGE_ERROR = "cannot be changed from a page session";

beforeAll(async () => {
  initDb(":memory:");
  await createAgent({ id: LEAD_ID, name: "lead", isLead: true, status: "idle", capabilities: [] });
  adminId = (await createUser({ name: "Admin" })).id;
  await attachRole(adminId, "admin");
  plainUserId = (await createUser({ name: "Requester" })).id;
  await setUserRoles(plainUserId, ["requester"], adminId);
  registerSetConfigTool(mcp as never);
  registerDeleteConfigTool(mcp as never);

  server = createServer(async (req, res) => {
    // `x-test-user-id` makes a user principal (`x-test-page` binds it to a page
    // session, as auth.ts does for a uid cookie), `x-test-guest` a guest; else
    // the operator key.
    const userId = req.headers["x-test-user-id"] as string | undefined;
    if (userId) {
      const user = await findUserById(userId);
      const page = req.headers["x-test-page"]
        ? { page: { id: "p1", executionAgentId: LEAD_ID } }
        : {};
      setRequestAuth(req, user ? { kind: "user", userId: user.id, user, ...page } : null);
    } else if (req.headers["x-test-guest"]) {
      setRequestAuth(req, { kind: "guest" });
    } else {
      setRequestAuth(req, { kind: "operator", fingerprint: "config-guard-test" });
    }
    const segments = getPathSegments(req.url ?? "");
    const query = parseQueryParams(req.url ?? "");
    if (await handleConfig(req, res, segments, query)) return;
    if (await handleApprovalRequests(req, res, segments, query)) return;
    res.writeHead(404).end();
  });
  baseUrl = `http://127.0.0.1:${await listenOnFreePort(server)}`;
});

afterAll(async () => {
  reloadSpy.mockRestore();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  closeDb();
});

function put(headers: Record<string, string>, value = PIN) {
  return fetch(`${baseUrl}/api/config`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify({ scope: "global", key: KEY, value }),
  });
}

describe("UI_SPEC_SCRIPT_ACTIONS value", () => {
  test("accepts name@hash pins of 12 to 64 hex chars", () => {
    expect(validateConfigValue(KEY, "")).toBeNull();
    expect(validateConfigValue(KEY, `${PIN}, other@${"a".repeat(64)}`)).toBeNull();
  });

  test("rejects a bare name, a short hash and a non-hex hash", () => {
    expect(validateConfigValue(KEY, "github-metrics")).toContain("name@<contentHash>");
    expect(validateConfigValue(KEY, "github-metrics@0123abc")).toContain("at least 12 hex");
    expect(validateConfigValue(KEY, "github-metrics@zzzzzzzzzzzzzz")).toContain("name@");
  });
});

describe("PUT and DELETE /api/config", () => {
  test("the operator key is refused, even naming the lead", async () => {
    for (const headers of [{}, { "X-Agent-ID": LEAD_ID }]) {
      const response = await put(headers);
      expect(response.status).toBe(403);
      expect(await response.text()).toContain("can only be changed by an admin user");
    }
  });

  test("a guest and a non-admin user are refused", async () => {
    expect((await put({ "x-test-guest": "1" })).status).toBe(403);
    expect((await put({ "x-test-user-id": plainUserId })).status).toBe(403);
  });

  test("an admin user writes it, and an invalid value is refused", async () => {
    const response = await put({ "x-test-user-id": adminId });
    expect(response.status).toBe(200);
    expect(((await response.json()) as { value: string }).value).toBe(PIN);
    expect((await put({ "x-test-user-id": adminId }, "github-metrics")).status).toBe(400);
  });

  test("an admin's page session is refused, with its own message", async () => {
    const response = await put({ "x-test-user-id": adminId, "x-test-page": "1" });
    expect(response.status).toBe(403);
    expect(await response.text()).toContain(PAGE_ERROR);
  });

  test("an admin's page session cannot delete it", async () => {
    const row = await upsertSwarmConfig({ scope: "global", key: KEY, value: PIN });
    const response = await fetch(`${baseUrl}/api/config/${row.id}`, {
      method: "DELETE",
      headers: { "x-test-user-id": adminId, "x-test-page": "1" },
    });
    expect(response.status).toBe(403);
    expect(await response.text()).toContain(PAGE_ERROR);
  });

  test("only an admin user deletes it", async () => {
    const row = await upsertSwarmConfig({ scope: "global", key: KEY, value: PIN });
    const del = (headers: Record<string, string>) =>
      fetch(`${baseUrl}/api/config/${row.id}`, { method: "DELETE", headers });
    expect((await del({})).status).toBe(403);
    expect((await del({ "x-test-user-id": adminId })).status).toBe(200);
  });
});

describe("set-config and delete-config tools", () => {
  const meta = { requestInfo: { headers: { "x-agent-id": LEAD_ID } } };

  test("the lead cannot set it", async () => {
    const result = await tools.get("set-config")!({ scope: "global", key: KEY, value: PIN }, meta);
    expect(result.structuredContent?.success).toBe(false);
    expect(result.structuredContent?.message).toContain("can only be changed by an admin user");
  });

  test("the lead cannot delete it", async () => {
    const row = await upsertSwarmConfig({ scope: "global", key: KEY, value: PIN });
    const result = await tools.get("delete-config")!({ id: row.id }, meta);
    expect(result.structuredContent?.success).toBe(false);
    expect(result.structuredContent?.message).toContain("can only be changed by an admin user");
  });
});

describe("HITL config answer", () => {
  test("an admin's page session cannot set it; the admin can", async () => {
    const created = await fetch(`${baseUrl}/api/approval-requests`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "Pin a card script",
        approvers: { policy: "any" },
        questions: [{ id: "cfg", type: "config", config: { key: KEY, scope: "global" } }],
      }),
    });
    expect(created.status).toBe(201);
    const { approvalRequest } = (await created.json()) as { approvalRequest: { id: string } };
    const answer = (headers: Record<string, string>) =>
      fetch(`${baseUrl}/api/approval-requests/${approvalRequest.id}/respond`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body: JSON.stringify({ responses: { cfg: { action: "set", value: PIN } } }),
      });

    const fromPage = await answer({ "x-test-user-id": adminId, "x-test-page": "1" });
    expect(fromPage.status).toBe(403);
    expect(await fromPage.text()).toContain(PAGE_ERROR);
    expect((await answer({ "x-test-user-id": adminId })).status).toBe(200);
  });
});
