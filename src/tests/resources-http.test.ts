import { afterAll, beforeAll, expect, test } from "bun:test";
import { createServer } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { closeDb, getDbClient, initDb } from "../be/db";
import { enqueueAuditRow, flushAuditBuffer } from "../be/rbac-audit";
import { addResourceLink } from "../be/resources/db";
import { insertSessionToken, resolveSessionToken } from "../be/users";
import { assertNoDeniedTables } from "../http/db-query-shared";
import { handleResources } from "../http/resources";
import { getPathSegments, parseQueryParams } from "../http/utils";
import { clearAuditSink, setAuditSink } from "../rbac";
import { registerResourceListTool } from "../tools/resource-list";
import {
  beginRequestAuthScope,
  type HttpRequestAuth,
  setRequestAuth,
} from "../utils/request-auth-context";
import { removeResourceTestDb, resourceFixture } from "./resources-test-utils";
import { listenOnFreePort } from "./test-net";

const path = "./test-resources-http.sqlite";
let f: Awaited<ReturnType<typeof resourceFixture>>;
let token: string;
let boundToken: string;
let base: string;
const operatorKey = crypto.randomUUID();
const server = createServer(async (req, res) => {
  beginRequestAuthScope();
  const bearer = req.headers.authorization?.slice(7);
  let auth: HttpRequestAuth | null = null;
  if (bearer === operatorKey) auth = { kind: "operator", fingerprint: "test-operator" };
  else if (bearer === "test-user") auth = { kind: "user", userId: f.user.id, user: f.user };
  else if (bearer) auth = await resolveSessionToken(bearer);
  if (!auth) {
    res.writeHead(401);
    res.end();
    return;
  }
  setRequestAuth(req, auth);
  if (auth.kind === "agent") req.headers["x-agent-id"] = auth.agentId;
  if (req.url === "/mcp") {
    const mcp = new McpServer({ name: "resource-test", version: "1" });
    registerResourceListTool(mcp);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      void transport.close();
      void mcp.close();
    });
    await mcp.connect(transport);
    await transport.handleRequest(req, res);
    return;
  }
  const agentId =
    typeof req.headers["x-agent-id"] === "string" ? req.headers["x-agent-id"] : undefined;
  if (
    !(await handleResources(
      req,
      res,
      getPathSegments(req.url ?? "/"),
      parseQueryParams(req.url ?? "/"),
      agentId,
    ))
  ) {
    res.writeHead(404);
    res.end();
  }
});
beforeAll(async () => {
  await removeResourceTestDb(path);
  initDb(path);
  f = await resourceFixture();
  token = (await insertSessionToken(f.agent.id, null, null, 60_000)).plaintext;
  const bound = await insertSessionToken(f.agent.id, null, null, 60_000);
  await getDbClient().run("UPDATE session_tokens SET sourceTaskId = ? WHERE id = ?", [
    f.task.id,
    bound.tokenId,
  ]);
  boundToken = bound.plaintext;
  base = `http://127.0.0.1:${await listenOnFreePort(server)}`;
  setAuditSink(enqueueAuditRow);
});
afterAll(async () => {
  clearAuditSink();
  await flushAuditBuffer();
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  closeDb();
  await removeResourceTestDb(path);
});
const request = (url: string, bearer: string | null = token) =>
  fetch(base + url, { headers: bearer ? { Authorization: `Bearer ${bearer}` } : {} });

test("authenticated filtered REST lists and details exclude all private storage", async () => {
  expect((await request("/api/resources", null)).status).toBe(401);
  expect((await request("/api/resources")).status).toBe(403);
  const response = await request(`/api/resources?taskId=${f.task.id}&kind=sandbox`);
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.json()).toEqual({ resources: [f.resource] });
  const detail = await request(`/api/resources/${f.browser.id}?taskId=${f.sibling.id}`);
  expect(detail.status).toBe(200);
  expect(await detail.json()).toEqual({ resource: f.browser });
  expect((await request(`/api/resources?taskId=${f.task.id}&limit=0`)).status).toBe(400);
  expect(
    await (await request(`/api/resources?taskId=${f.task.id}&limit=1&offset=1`)).json(),
  ).toMatchObject({ resources: [expect.any(Object)] });
  await flushAuditBuffer();
  const audits = await getDbClient().query<Record<string, unknown>>(
    "SELECT * FROM permission_audit WHERE verb = 'resource.read'",
  );
  expect(audits.length).toBeGreaterThan(0);
  expect(audits.some((row) => row.resourceId === f.browser.id)).toBe(true);
  const serialized = JSON.stringify(audits);
  for (const secret of [
    "providerHandle",
    "privateConfig",
    "cdpUrl",
    "liveUrl",
    "private-browser-session-handle",
    "private-resource-config-value",
  ])
    expect(serialized).not.toContain(secret);
});

test("forged task, requester, owner, and links cannot widen REST access", async () => {
  expect((await request(`/api/resources?taskId=${f.foreign.id}`)).status).toBe(403);
  await addResourceLink({
    resourceId: f.resource.id,
    kind: "task",
    targetId: f.concurrent.id,
    isPrimary: false,
  });
  const forged = `taskId=${f.concurrent.id}&requestedByUserId=${f.user.id}&ownerUserId=${f.user.id}&resourceLink=${f.resource.id}`;
  expect(await (await request(`/api/resources?${forged}`)).json()).toEqual({ resources: [] });
  expect((await request(`/api/resources/${f.resource.id}?${forged}`)).status).toBe(404);
  expect((await request(`/api/resources/${f.browser.id}?taskId=${f.feedback.id}`)).status).toBe(
    404,
  );
  expect((await request(`/api/resources?taskId=${f.concurrent.id}`, boundToken)).status).toBe(403);
  expect((await request("/api/resources", boundToken)).status).toBe(200);
  expect((await request(`/api/resources/${f.resource.id}`, "test-user")).status).toBe(200);
  for (const table of [
    "resources",
    "browser_profiles",
    "sandbox_templates",
    "resource_links",
    "resource_operations",
    "resource_costs",
  ]) {
    expect(() => assertNoDeniedTables(`SELECT * FROM ${table}`)).toThrow();
  }
});

test("authenticated MCP lists the fake resource and denies forged task and profile access", async () => {
  const client = new Client({ name: "resource-client", version: "1" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${boundToken}` } },
    }),
  );
  try {
    const listed = await client.callTool({
      name: "resource-list",
      arguments: { taskId: f.task.id, kind: "sandbox" },
    });
    expect(listed.isError).toBe(false);
    expect(listed.structuredContent).toMatchObject({ success: true, resources: [f.resource] });
    const denied = await client.callTool({
      name: "resource-list",
      arguments: { taskId: f.foreign.id },
    });
    expect(denied.isError).toBe(true);
    const serialized = JSON.stringify(listed);
    for (const secret of [
      "private-provider-session-handle",
      "private-resource-config-value",
      "privateConfig",
      "providerHandle",
      "cdpUrl",
    ])
      expect(serialized).not.toContain(secret);
  } finally {
    await client.close();
  }
});
