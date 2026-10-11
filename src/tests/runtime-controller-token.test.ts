import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { createServer, type Server } from "node:http";
import WebSocket from "ws";
import { closeDb, createAgent, getDbClient, initDb } from "../be/db";
import { createRuntimeController, deleteRuntimeController } from "../be/runtime-pools/db";
import { mintControllerToken } from "../be/runtime-pools/tokens";
import { validateConfigValue } from "../be/swarm-config-guard";
import { mintRuntimeToken, resolveBySessionToken, resolveSessionToken } from "../be/users";
import { handleCore } from "../http/core";
import { handleRuntimePools } from "../http/runtime-pools";
import { getPathSegments, parseQueryParams } from "../http/utils";
import { issueRealtimeTicket } from "../realtime/tickets";
import { attachRealtimeTransport } from "../realtime/transport";
import { registerSessionTokenConnection } from "../utils/session-token-connections";
import { listenOnFreePort } from "./test-net";

const key = "controller-token-test-operator";
const previous = {
  key: process.env.AGENT_SWARM_API_KEY,
  enabled: process.env.RUNTIME_POOLS_ENABLED,
  days: process.env.RUNTIME_CONTROLLER_TOKEN_TTL_DAYS,
};
let server: Server;
let url: string;
let detach: () => void;
let controllerId: string;
let leadToken: string;

beforeAll(async () => {
  initDb(":memory:");
  process.env.AGENT_SWARM_API_KEY = key;
  process.env.RUNTIME_POOLS_ENABLED = "true";
  delete process.env.RUNTIME_CONTROLLER_TOKEN_TTL_DAYS;
  controllerId = (
    await createRuntimeController({ name: "remote", kind: "docker", placement: "remote" })
  ).id;
  const lead = await createAgent({ name: "lead", isLead: true, status: "idle" });
  leadToken = (await mintRuntimeToken(lead.id, crypto.randomUUID())).plaintext;
  server = createServer((req, res) => {
    void (async () => {
      if (await handleCore(req, res, req.headers["x-agent-id"] as string | undefined, key)) return;
      if (
        await handleRuntimePools(
          req,
          res,
          getPathSegments(req.url ?? ""),
          parseQueryParams(req.url ?? ""),
          req.headers["x-agent-id"] as string | undefined,
        )
      )
        return;
      res.writeHead(404).end();
    })().catch(() => res.writeHead(500).end());
  });
  url = `http://127.0.0.1:${await listenOnFreePort(server)}`;
  detach = attachRealtimeTransport(server);
});
afterAll(async () => {
  detach();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  closeDb();
  for (const [name, value] of Object.entries({
    AGENT_SWARM_API_KEY: previous.key,
    RUNTIME_POOLS_ENABLED: previous.enabled,
    RUNTIME_CONTROLLER_TOKEN_TTL_DAYS: previous.days,
  })) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

function request(path: string, bearer = key, method = "GET") {
  return fetch(url + path, { method, headers: { Authorization: `Bearer ${bearer}` } });
}

test("controller identity rejects extra spaces and lowercase bearer before every HTTP route", async () => {
  const token = await mintControllerToken(controllerId);
  for (const header of [`Bearer  ${token.plaintext}`, `bearer ${token.plaintext}`]) {
    for (const path of [
      "/api/agents",
      "/api/tasks",
      "/api/config/resolved?includeSecrets=true",
      "/health",
      "/mcp-user",
    ]) {
      const response = await fetch(url + path, { headers: { Authorization: header } });
      expect(response.status).toBe(403);
      await response.text();
    }
  }
});

test("worker HTTP authentication performs one session-token lookup", async () => {
  const query = spyOn(getDbClient(), "get");
  try {
    const response = await request("/me", leadToken);
    await response.text();
    expect(query.mock.calls.filter(([sql]) => sql.includes("FROM session_tokens"))).toHaveLength(1);
  } finally {
    query.mockRestore();
  }
});

test("mint returns a controller identity, stores only its hash, and rotates the previous token", async () => {
  const firstResponse = await request(
    `/api/runtime-controllers/${controllerId}/token`,
    key,
    "POST",
  );
  expect(firstResponse.status).toBe(200);
  expect(firstResponse.headers.get("cache-control")).toBe("no-store");
  const first = (await firstResponse.json()) as {
    plaintext: string;
    tokenId: string;
    expiresAt: string;
  };
  expect(first.plaintext).toStartWith("aseph_");
  expect(await resolveSessionToken(first.plaintext)).toMatchObject({
    controllerId,
    tokenId: first.tokenId,
  });
  expect(await resolveBySessionToken(first.plaintext)).toBeNull();
  expect(Date.parse(first.expiresAt) - Date.now()).toBeGreaterThan(89 * 86_400_000);
  const stored = await getDbClient().get<{ tokenHash: string }>(
    "SELECT tokenHash FROM session_tokens WHERE id = ?",
    [first.tokenId],
  );
  expect(stored?.tokenHash).not.toContain(first.plaintext);
  let closed = false;
  const unregister = registerSessionTokenConnection(first.tokenId, () => {
    closed = true;
  });
  try {
    const second = await request(`/api/runtime-controllers/${controllerId}/token`, key, "POST");
    expect(second.status).toBe(200);
    expect(await resolveSessionToken(first.plaintext)).toBeNull();
    expect(closed).toBe(true);
  } finally {
    unregister();
  }
});

test("controller tokens cannot access poll, MCP, config, public routes, or token minting", async () => {
  const token = await mintControllerToken(controllerId);
  for (const path of [
    "/api/poll",
    "/api/config/resolved?includeSecrets=true",
    "/me",
    "/api/runtime-controllers",
    "/health",
    "/@swarm/realtime.js",
    "/mcp-user",
  ]) {
    const response = await request(path, token.plaintext);
    expect(response.status).toBe(403);
    await response.text();
  }
  for (const path of ["/mcp", `/api/runtime-controllers/${controllerId}/token`]) {
    const response = await request(path, token.plaintext, "POST");
    expect(response.status).toBe(403);
    await response.text();
  }
});

test("lead token mint is forbidden and built-in controllers cannot receive tokens", async () => {
  expect(
    (await request(`/api/runtime-controllers/${controllerId}/token`, leadToken, "POST")).status,
  ).toBe(403);
  const builtin = await createRuntimeController({
    name: "builtin",
    kind: "docker",
    placement: "builtin",
  });
  expect((await request(`/api/runtime-controllers/${builtin.id}/token`, key, "POST")).status).toBe(
    400,
  );
});

test("controller token cannot upgrade the realtime socket", async () => {
  const token = await mintControllerToken(controllerId);
  const ws = new WebSocket(`${url.replace("http:", "ws:")}/api/realtime`, {
    headers: { Authorization: `Bearer ${token.plaintext}` },
  });
  const status = await new Promise<number>((resolve, reject) => {
    ws.on("unexpected-response", (_req, response) => {
      response.resume();
      ws.terminate();
      resolve(response.statusCode ?? 0);
    });
    ws.on("open", () => {
      ws.terminate();
      reject(new Error("Controller upgraded realtime"));
    });
    ws.on("error", () => {});
  });
  expect(status).toBe(401);
});

for (const prefix of ["Bearer ", "Bearer  ", "bearer "])
  test(`a realtime ticket cannot bypass a controller with ${JSON.stringify(prefix)}`, async () => {
    const token = await mintControllerToken(controllerId);
    const ticket = issueRealtimeTicket({ kind: "operator", fingerprint: "test" }).ticket;
    const ws = new WebSocket(`${url.replace("http:", "ws:")}/api/realtime?ticket=${ticket}`, {
      headers: { Authorization: `${prefix}${token.plaintext}` },
    });
    const status = await new Promise<number>((resolve, reject) => {
      ws.on("unexpected-response", (_req, response) => {
        response.resume();
        ws.terminate();
        resolve(response.statusCode ?? 0);
      });
      ws.on("open", () => {
        ws.terminate();
        reject(new Error("Controller upgraded realtime with a ticket"));
      });
      ws.on("error", () => {});
    });
    expect(status).toBe(401);
  });

test("controller delete revokes tokens and expiration prevents resolution", async () => {
  const row = await createRuntimeController({
    name: "deletable",
    kind: "docker",
    placement: "remote",
  });
  const token = await mintControllerToken(row.id);
  await getDbClient().run("UPDATE session_tokens SET expiresAt = ? WHERE id = ?", [
    new Date(Date.now() - 1000).toISOString(),
    token.tokenId,
  ]);
  expect(await resolveSessionToken(token.plaintext)).toBeNull();
  const replacement = await mintControllerToken(row.id);
  await deleteRuntimeController(row.id);
  expect(await resolveSessionToken(replacement.plaintext)).toBeNull();
  expect(
    await getDbClient().get(
      "SELECT id FROM session_tokens WHERE id = ? AND revokedAt IS NOT NULL",
      [replacement.tokenId],
    ),
  ).toBeTruthy();
});

test("controller configuration validates bounds and TTL applies to new tokens", async () => {
  expect(validateConfigValue("RUNTIME_CONTROLLER_TOKEN_TTL_DAYS", "0")).not.toBeNull();
  expect(validateConfigValue("RUNTIME_CONTROLLER_TOKEN_TTL_DAYS", "3651")).not.toBeNull();
  expect(validateConfigValue("RUNTIME_CONTROLLER_GRACE_SEC", "-1")).not.toBeNull();
  expect(validateConfigValue("RUNTIME_CONTROLLER_GRACE_SEC", "0")).toBeNull();
  process.env.RUNTIME_CONTROLLER_TOKEN_TTL_DAYS = "1";
  const token = await mintControllerToken(controllerId);
  expect(Date.parse(token.expiresAt) - Date.now()).toBeLessThanOrEqual(86_400_000);
  expect(Date.parse(token.expiresAt) - Date.now()).toBeGreaterThan(86_399_000);
  delete process.env.RUNTIME_CONTROLLER_TOKEN_TTL_DAYS;
});
