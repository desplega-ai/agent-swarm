import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer as createHttpServer, type Server } from "node:http";
import {
  closeDb,
  createAgent,
  createMcpServer,
  initDb,
  installMcpServer,
  upsertSwarmConfig,
} from "../be/db";
import { handleMcpServers } from "../http/mcp-servers";
import { listenOnFreePort } from "./test-net";

const TEST_DB_PATH = "./test-mcp-server-codex-oauth-env.sqlite";
let TEST_PORT = 0;

process.env.SECRETS_ENCRYPTION_KEY = Buffer.alloc(32, 13).toString("base64");

// Synthetic credential blobs: the refresh token is the value that must never
// reach a stdio server's env.
const FAKE_REFRESH = "fake-refresh-token-must-not-leak";
const fakeCodexBlob = (n: number) =>
  JSON.stringify({
    access: `fake-access-${n}`,
    refresh: `${FAKE_REFRESH}-${n}`,
    expires: Date.now() + 3600_000,
    accountId: `fake-account-${n}`,
  });

let server: Server;

beforeAll(async () => {
  initDb(TEST_DB_PATH);
  server = createHttpServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = req.url || "";
    const pathEnd = url.indexOf("?");
    const path = pathEnd === -1 ? url : url.slice(0, pathEnd);
    const pathSegments = path.split("/").filter(Boolean);
    const queryParams = new URLSearchParams(pathEnd === -1 ? "" : url.slice(pathEnd + 1));
    const matched = await handleMcpServers(req, res, pathSegments, queryParams);
    if (!matched) {
      res.statusCode = 404;
      res.end(JSON.stringify({ error: "not found" }));
    }
  });
  TEST_PORT = await listenOnFreePort(server);

  await upsertSwarmConfig({
    scope: "global",
    key: "codex_oauth",
    value: fakeCodexBlob(9),
    isSecret: true,
  });
  await upsertSwarmConfig({
    scope: "global",
    key: "codex_oauth_0",
    value: fakeCodexBlob(0),
    isSecret: true,
  });
  await upsertSwarmConfig({
    scope: "global",
    key: "codex_oauth_1",
    value: fakeCodexBlob(1),
    isSecret: true,
  });
  // Positive control: an ordinary secret on the same server still resolves.
  await upsertSwarmConfig({
    scope: "global",
    key: "PLAIN_TOKEN",
    value: "plain-value",
    isSecret: true,
  });
  // Lookalike keys outside the denylist pattern still resolve.
  await upsertSwarmConfig({
    scope: "global",
    key: "codex_oauth_note",
    value: "not-a-credential",
    isSecret: false,
  });
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  closeDb();
  for (const suffix of ["", "-wal", "-shm"]) {
    await unlink(`${TEST_DB_PATH}${suffix}`).catch(() => {});
  }
});

async function resolvedEnvFor(envConfigKeys: unknown): Promise<Record<string, string>> {
  const agent = await createAgent({
    id: crypto.randomUUID(),
    name: "codex-env-agent",
    status: "idle",
    isLead: false,
  });
  const mcp = await createMcpServer({
    name: `stdio-${crypto.randomUUID()}`,
    transport: "stdio",
    command: "node",
    scope: "agent",
    ownerAgentId: agent.id,
    envConfigKeys: JSON.stringify(envConfigKeys),
  });
  await installMcpServer(agent.id, mcp.id);

  const res = await fetch(
    `http://localhost:${TEST_PORT}/api/agents/${agent.id}/mcp-servers?resolveSecrets=true`,
  );
  expect(res.status).toBe(200);
  const raw = await res.text();
  // Nothing in the response body may carry a refresh token, in any field.
  expect(raw).not.toContain(FAKE_REFRESH);
  const body = JSON.parse(raw) as {
    servers: Array<{ id: string; resolvedEnv?: Record<string, string> }>;
  };
  const match = body.servers.find((s) => s.id === mcp.id);
  expect(match).toBeTruthy();
  return match!.resolvedEnv ?? {};
}

describe("resolveSecrets never resolves codex_oauth rows into stdio env", () => {
  test("array form drops codex_oauth keys and keeps ordinary keys", async () => {
    const env = await resolvedEnvFor([
      "codex_oauth",
      "codex_oauth_0",
      "codex_oauth_1",
      "PLAIN_TOKEN",
      "codex_oauth_note",
    ]);
    expect(env).toEqual({ PLAIN_TOKEN: "plain-value", codex_oauth_note: "not-a-credential" });
  });

  test("object form filters on the source config key, not the env alias", async () => {
    const env = await resolvedEnvFor({
      AUTH_BLOB: "codex_oauth_0",
      LEGACY_BLOB: "codex_oauth",
      // Destination named like an innocent var, source is a pool slot.
      OPENAI_API_KEY: "codex_oauth_1",
      PLAIN: "PLAIN_TOKEN",
    });
    expect(env).toEqual({ PLAIN: "plain-value" });
  });
});
