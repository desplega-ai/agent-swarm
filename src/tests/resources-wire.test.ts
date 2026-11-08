import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { closeDb, createUser, getDbClient, initDb } from "../be/db";
import { ensureRbacSeedsSynced, setUserRoles } from "../be/rbac-roles";
import { createResource } from "../be/resources/db";
import { insertSessionToken, mintToken } from "../be/users";
import { E2E_API_KEY, type SwarmServer, spawnSwarmServer } from "./rbac-e2e-helpers";
import { resourceFixture } from "./resources-test-utils";

setDefaultTimeout(120_000);
const templateGlobals = globalThis as typeof globalThis & { __testMigrationTemplate?: Uint8Array };
let savedTemplate: Uint8Array | undefined;
const dir = `/tmp/resources-wire-${crypto.randomUUID()}`;
let server: SwarmServer;
let f: Awaited<ReturnType<typeof resourceFixture>>;
let otherResource: Awaited<ReturnType<typeof createResource>>;
let requester: string;
let viewer: string;
let boundAgent: string;
const actor = { kind: "system", id: "resource-wire-test" } as const;

beforeAll(async () => {
  savedTemplate = templateGlobals.__testMigrationTemplate;
  templateGlobals.__testMigrationTemplate = undefined;
  closeDb();
  await Bun.$`mkdir -p ${dir}`.quiet();
  // Seed a disposable DB before boot. The running API has no test-only write route.
  initDb(`${dir}/wire.sqlite`);
  ensureRbacSeedsSynced({ quiet: true });
  f = await resourceFixture();
  await createUser({ name: "Retained admin" });
  await setUserRoles(f.user.id, ["requester"], null);
  await setUserRoles(f.otherUser.id, ["viewer"], null);
  requester = (await mintToken(f.user.id, "requester", actor)).plaintext;
  viewer = (await mintToken(f.otherUser.id, "viewer", actor)).plaintext;
  const bound = await insertSessionToken(f.agent.id, null, null, 120_000);
  await getDbClient().run("UPDATE session_tokens SET sourceTaskId = ? WHERE id = ?", [
    f.task.id,
    bound.tokenId,
  ]);
  boundAgent = bound.plaintext;
  otherResource = await createResource({
    kind: "sandbox",
    provider: "fake",
    creatorAgentId: f.otherAgent.id,
    sourceTaskId: f.foreign.id,
    createRequestKey: "viewer-owned",
    expiresAt: f.resource.expiresAt,
  });
  closeDb();
  server = await spawnSwarmServer({
    dbPath: `${dir}/wire.sqlite`,
    logPath: `${dir}/server.log`,
    env: { RBAC_ENABLED: "true", DESPLEGA_TELEMETRY_ENV: "test" },
  });
});

afterAll(async () => {
  templateGlobals.__testMigrationTemplate = savedTemplate;
  if (server) await server.stop();
  closeDb();
  await Bun.$`rm -r ${dir}`.quiet();
});

async function rest(path: string, bearer: string, extraHeaders: Record<string, string> = {}) {
  const response = await fetch(server.base + path, {
    headers: { Authorization: `Bearer ${bearer}`, ...extraHeaders },
  });
  return { status: response.status, body: await response.json() };
}

async function mcp(
  bearer: string,
  args: Record<string, unknown> = {},
  extraHeaders: Record<string, string> = {},
) {
  const client = new Client({ name: "resource-wire", version: "1" });
  await client.connect(
    new StreamableHTTPClientTransport(
      new URL(`${server.base}/${bearer.startsWith("aswt_") ? "mcp-user" : "mcp"}`),
      {
        requestInit: { headers: { Authorization: `Bearer ${bearer}`, ...extraHeaders } },
      },
    ),
  );
  try {
    return await client.callTool({ name: "resource-list", arguments: args });
  } finally {
    await client.close();
  }
}

test("real requester and viewer bearers pass core admission with nonempty REST and MCP parity", async () => {
  for (const [bearer, resource] of [
    [requester, f.resource],
    [viewer, otherResource],
  ] as const) {
    const list = await rest("/api/resources?kind=sandbox", bearer);
    expect(list).toEqual({ status: 200, body: { resources: [resource] } });
    expect(await rest(`/api/resources/${resource.id}`, bearer)).toEqual({
      status: 200,
      body: { resource },
    });
    const result = await mcp(bearer, { kind: "sandbox" });
    expect(result.isError).toBe(false);
    expect(result.structuredContent).toMatchObject({
      success: true,
      resources: list.body.resources,
    });
  }
  expect((await rest(`/api/resources/${f.browser.id}`, requester)).status).toBe(200);
});

test("real auth rejects foreign users and forged context across REST and MCP", async () => {
  expect((await rest(`/api/resources/${f.resource.id}`, viewer)).status).toBe(404);
  expect((await rest(`/api/resources/${otherResource.id}`, requester)).status).toBe(404);
  expect((await rest(`/api/resources?taskId=${f.task.id}`, viewer)).status).toBe(403);
  const forged = `taskId=${f.feedback.id}&requestedByUserId=${f.user.id}&ownerUserId=${f.user.id}&resourceLink=${f.browser.id}`;
  expect(
    (await rest(`/api/resources/${f.browser.id}?${forged}`, viewer, { "X-Agent-ID": f.agent.id }))
      .status,
  ).toBe(403);
  const denied = await mcp(viewer, { taskId: f.task.id });
  expect(denied.isError).toBe(true);
  const foreignList = await mcp(
    viewer,
    {},
    {
      "X-Agent-ID": f.agent.id,
      "X-Source-Task-Id": f.task.id,
    },
  );
  expect(foreignList.isError).toBe(true);
});

test("shared-key worker headers stay task-scoped while operator reads show sanitized metadata", async () => {
  const workerHeaders = { "X-Agent-ID": f.agent.id, "X-Source-Task-Id": f.task.id };
  expect(await rest("/api/resources?kind=sandbox", E2E_API_KEY, workerHeaders)).toEqual({
    status: 200,
    body: { resources: [f.resource] },
  });
  expect(
    (await mcp(E2E_API_KEY, { kind: "sandbox" }, workerHeaders)).structuredContent,
  ).toMatchObject({
    success: true,
    resources: [f.resource],
  });
  expect((await rest("/api/resources", E2E_API_KEY, { "X-Agent-ID": f.agent.id })).status).toBe(
    403,
  );
  expect(
    (
      await rest("/api/resources", E2E_API_KEY, {
        ...workerHeaders,
        "X-Source-Task-Id": f.foreign.id,
      })
    ).status,
  ).toBe(403);
  expect(await rest(`/api/resources/${f.browser.id}`, E2E_API_KEY)).toEqual({
    status: 200,
    body: { resource: f.browser },
  });
  const listed = await rest("/api/resources?kind=browser", E2E_API_KEY);
  expect(listed).toEqual({ status: 200, body: { resources: [f.browser] } });
  expect(JSON.stringify(listed)).not.toContain("providerHandle");
  expect(JSON.stringify(listed)).not.toContain("privateConfig");
});

test("real agent credentials bind source task and agent identity before REST or MCP selection", async () => {
  expect(await rest("/api/resources?kind=sandbox", boundAgent)).toEqual({
    status: 200,
    body: { resources: [f.resource] },
  });
  expect((await rest(`/api/resources/${f.browser.id}`, boundAgent)).status).toBe(200);
  for (const taskId of [f.foreign.id, f.concurrent.id, f.feedback.id]) {
    expect((await rest(`/api/resources?taskId=${taskId}`, boundAgent)).status).toBe(403);
    expect((await rest("/api/resources", boundAgent, { "X-Source-Task-Id": taskId })).status).toBe(
      403,
    );
    expect((await mcp(boundAgent, { taskId })).isError).toBe(true);
  }
  const listed = await mcp(boundAgent, { kind: "sandbox" });
  expect(listed.structuredContent).toMatchObject({ success: true, resources: [f.resource] });
  const spoofedAgent = await rest("/api/resources?kind=sandbox", boundAgent, {
    "X-Agent-ID": f.otherAgent.id,
  });
  // Core authentication rejects conflicting identity before the handler.
  expect(spoofedAgent.status).toBe(403);
});
