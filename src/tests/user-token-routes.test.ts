import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { deleteExpiredConnectorCodes, exchangeConnectorCode } from "../be/connector-codes";
import { closeDb, createUser, getDbClient, initDb, upsertSwarmConfig } from "../be/db";
import { fingerprintApiKey, resolveUserByToken } from "../be/users";
import { handleCore } from "../http/core";
import { clientIp, createIpRateLimiter } from "../http/ip-rate-limit";
import { _resetConnectorExchangeRateLimitForTests, handleUsers } from "../http/users";
import { getPathSegments, parseQueryParams } from "../http/utils";
import { listenOnFreePort } from "./test-net";

const TEST_DB_PATH = "./test-user-token-routes.sqlite";
const API_KEY = "example-test-user-token-key";
const ORIGINAL_API_KEY = process.env.AGENT_SWARM_API_KEY;

async function removeDbFiles(path: string): Promise<void> {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      await unlink(path + suffix);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

function createTestServer(apiKey: string): Server {
  return createHttpServer(async (req: IncomingMessage, res: ServerResponse) => {
    const myAgentId = req.headers["x-agent-id"] as string | undefined;
    const handled = await handleCore(req, res, myAgentId, apiKey);
    if (handled) return;
    const pathSegments = getPathSegments(req.url || "");
    const queryParams = parseQueryParams(req.url || "");
    const ok = await handleUsers(req, res, pathSegments, queryParams);
    if (!ok) {
      res.writeHead(404);
      res.end("Not Found");
    }
  });
}

let server: Server;
let port: number;

beforeAll(async () => {
  await removeDbFiles(TEST_DB_PATH);
  initDb(TEST_DB_PATH);
  process.env.AGENT_SWARM_API_KEY = API_KEY;
  server = createTestServer(API_KEY);
  port = await listenOnFreePort(server, "127.0.0.1");
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  closeDb();
  await removeDbFiles(TEST_DB_PATH);
  if (ORIGINAL_API_KEY === undefined) {
    delete process.env.AGENT_SWARM_API_KEY;
  } else {
    process.env.AGENT_SWARM_API_KEY = ORIGINAL_API_KEY;
  }
});

beforeEach(async () => {
  const client = getDbClient();
  _resetConnectorExchangeRateLimitForTests();
  await client.run("DELETE FROM connector_codes");
  await client.run("DELETE FROM swarm_config WHERE key IN ('PUBLIC_MCP_BASE_URL', 'APP_URL')");
  await client.run("DELETE FROM user_identity_events");
  await client.run("DELETE FROM user_tokens");
  await client.run("DELETE FROM users");
});

function url(path: string): string {
  return `http://127.0.0.1:${port}${path}`;
}

function authedFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${API_KEY}`,
    "Content-Type": "application/json",
    ...((init.headers as Record<string, string>) ?? {}),
  };
  return fetch(url(path), { ...init, headers });
}

type TokenSummary = {
  id: string;
  userId: string;
  label: string | null;
  tokenPreview: string;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
};

describe("operator MCP token routes", () => {
  test("POST mints an aswt_ plaintext once and persists only hash + preview", async () => {
    const user = await createUser({ name: "Token User", email: "token@example.com" });

    const response = await authedFetch(`/api/users/${user.id}/mcp-tokens`, {
      method: "POST",
      body: JSON.stringify({ label: "laptop" }),
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      plaintext: string;
      token: TokenSummary;
      user: { id: string; tokens: TokenSummary[]; recentEvents: Array<{ eventType: string }> };
    };
    expect(body.plaintext.startsWith("aswt_")).toBe(true);
    expect(body.token.label).toBe("laptop");
    expect(body.token.tokenPreview).toBe(body.plaintext.slice(-4));
    expect(body.token.userId).toBe(user.id);
    expect(body.user.tokens).toContainEqual(body.token);
    expect(body.user.recentEvents.map((event) => event.eventType)).toContain("token_minted");

    const stored = await getDbClient().get<{ tokenHash: string; tokenPreview: string }>(
      "SELECT tokenHash, tokenPreview FROM user_tokens WHERE id = ?",
      [body.token.id],
    );
    expect(stored).toBeTruthy();
    expect(stored!.tokenHash).not.toBe(body.plaintext);
    expect(stored!.tokenHash).toHaveLength(64);
    expect(stored!.tokenPreview).toBe(body.plaintext.slice(-4));

    const reread = await authedFetch(`/api/users/${user.id}`);
    const rereadBody = (await reread.json()) as {
      user: { tokens: TokenSummary[]; recentEvents: Array<{ eventType: string }> };
    };
    expect(JSON.stringify(rereadBody)).not.toContain(body.plaintext);
    expect(rereadBody.user.tokens[0]!.tokenPreview).toBe(body.plaintext.slice(-4));
  });

  test("DELETE revokes a token and records token_revoked", async () => {
    const user = await createUser({ name: "Revoked User" });
    const mintResponse = await authedFetch(`/api/users/${user.id}/mcp-tokens`, {
      method: "POST",
      body: JSON.stringify({ label: null }),
    });
    const minted = (await mintResponse.json()) as { token: TokenSummary };

    const revokeResponse = await authedFetch(
      `/api/users/${user.id}/mcp-tokens/${minted.token.id}`,
      { method: "DELETE" },
    );

    expect(revokeResponse.status).toBe(200);
    const body = (await revokeResponse.json()) as {
      user: { tokens: TokenSummary[]; recentEvents: Array<{ eventType: string }> };
    };
    expect(body.user.tokens[0]!.id).toBe(minted.token.id);
    expect(body.user.tokens[0]!.revokedAt).toBeTruthy();
    expect(body.user.recentEvents.map((event) => event.eventType)).toEqual(
      expect.arrayContaining(["token_minted", "token_revoked"]),
    );
  });

  test("POST and DELETE reject without the swarm key", async () => {
    const user = await createUser({ name: "Auth User" });

    const post = await fetch(url(`/api/users/${user.id}/mcp-tokens`), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ label: "missing-auth" }),
    });
    expect(post.status).toBe(401);

    const deleteResponse = await fetch(url(`/api/users/${user.id}/mcp-tokens/unknown`), {
      method: "DELETE",
    });
    expect(deleteResponse.status).toBe(401);
  });

  test("DELETE unknown token returns 404", async () => {
    const user = await createUser({ name: "Unknown Token User" });
    const response = await authedFetch(`/api/users/${user.id}/mcp-tokens/not-a-token`, {
      method: "DELETE",
    });
    expect(response.status).toBe(404);
  });

  test("POST unknown user returns 404", async () => {
    const response = await authedFetch("/api/users/not-a-user/mcp-tokens", {
      method: "POST",
      body: JSON.stringify({ label: "nope" }),
    });
    expect(response.status).toBe(404);
  });

  test("operator events are tagged with the API-key fingerprint", async () => {
    const user = await createUser({ name: "Actor User" });
    const response = await authedFetch(`/api/users/${user.id}/mcp-tokens`, {
      method: "POST",
      body: JSON.stringify({ label: "actor" }),
    });
    expect(response.status).toBe(200);

    const row = await getDbClient().get<{ actor: string }>(
      "SELECT actor FROM user_identity_events WHERE userId = ? AND eventType = 'token_minted'",
      [user.id],
    );
    expect(row?.actor).toBe(`operator:${fingerprintApiKey(API_KEY)}`);
  });
});

describe("ChatGPT connector codes", () => {
  const ORIGINAL_PUBLIC_URL = process.env.PUBLIC_MCP_BASE_URL;
  const ORIGINAL_CONNECT_URL = process.env.CONNECTOR_CONNECT_URL;

  beforeEach(() => {
    process.env.PUBLIC_MCP_BASE_URL = "https://swarm.example.com";
    delete process.env.CONNECTOR_CONNECT_URL;
  });

  afterAll(() => {
    if (ORIGINAL_PUBLIC_URL === undefined) delete process.env.PUBLIC_MCP_BASE_URL;
    else process.env.PUBLIC_MCP_BASE_URL = ORIGINAL_PUBLIC_URL;
    if (ORIGINAL_CONNECT_URL === undefined) delete process.env.CONNECTOR_CONNECT_URL;
    else process.env.CONNECTOR_CONNECT_URL = ORIGINAL_CONNECT_URL;
  });

  type CodeBody = { code: string; expiresAt: string; connectUrl: string };

  async function createCode(userId: string, body: object = {}): Promise<CodeBody> {
    const response = await authedFetch(`/api/users/${userId}/connector-codes`, {
      method: "POST",
      body: JSON.stringify(body),
    });
    expect(response.status).toBe(201);
    return (await response.json()) as CodeBody;
  }

  function exchange(code: string, headers: Record<string, string> = {}): Promise<Response> {
    return fetch(url("/api/connector/exchange"), {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify({ code }),
    });
  }

  test("POST creates a single-use code, stores only its hash, and mints no token", async () => {
    const user = await createUser({ name: "Connector User" });
    const before = Date.now();
    const body = await createCode(user.id);

    expect(body.code).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const ttl = new Date(body.expiresAt).getTime() - before;
    expect(ttl).toBeGreaterThan(9 * 60 * 1000);
    expect(ttl).toBeLessThanOrEqual(10 * 60 * 1000 + 1000);
    expect(body.connectUrl).toBe(
      `https://mcp.agent-swarm.dev/connections?swarm=${encodeURIComponent("https://swarm.example.com")}&code=${body.code}`,
    );

    const rows = await getDbClient().query<{
      code_hash: string;
      label: string;
      used_at: string | null;
    }>("SELECT code_hash, label, used_at FROM connector_codes WHERE user_id = ?", [user.id]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.code_hash).toHaveLength(64);
    expect(rows[0]!.code_hash).not.toContain(body.code);
    expect(rows[0]!.label).toBe("ChatGPT connector");
    expect(rows[0]!.used_at).toBeNull();
    const tokens = await getDbClient().query("SELECT id FROM user_tokens WHERE userId = ?", [
      user.id,
    ]);
    expect(tokens).toHaveLength(0);
  });

  test("POST honors CONNECTOR_CONNECT_URL (keeping its query) and a custom label", async () => {
    process.env.CONNECTOR_CONNECT_URL = "https://connector.test/connect?ref=swarm";
    const user = await createUser({ name: "Custom Connector User" });
    const body = await createCode(user.id, { label: "my chatgpt" });
    const connect = new URL(body.connectUrl);
    expect(`${connect.origin}${connect.pathname}`).toBe("https://connector.test/connect");
    expect(connect.searchParams.get("ref")).toBe("swarm");
    expect(connect.searchParams.get("swarm")).toBe("https://swarm.example.com");
    expect(connect.searchParams.get("code")).toBe(body.code);
    const row = await getDbClient().get<{ label: string }>(
      "SELECT label FROM connector_codes WHERE user_id = ?",
      [user.id],
    );
    expect(row?.label).toBe("my chatgpt");
  });

  test("POST keeps a fragment on CONNECTOR_CONNECT_URL outside the query", async () => {
    process.env.CONNECTOR_CONNECT_URL = "https://connector.test/connect#signup";
    const user = await createUser({ name: "Fragment Connector User" });
    const body = await createCode(user.id);
    const connect = new URL(body.connectUrl);
    expect(connect.hash).toBe("#signup");
    expect(connect.searchParams.get("code")).toBe(body.code);
  });

  test("POST rejects an insecure or malformed CONNECTOR_CONNECT_URL without storing a code", async () => {
    const user = await createUser({ name: "Insecure Connector User" });
    for (const value of ["http://connector.test/connect", "not a url", "javascript:alert(1)"]) {
      process.env.CONNECTOR_CONNECT_URL = value;
      const response = await authedFetch(`/api/users/${user.id}/connector-codes`, {
        method: "POST",
        body: "{}",
      });
      expect(response.status).toBe(400);
    }
    expect(await getDbClient().query("SELECT code_hash FROM connector_codes")).toHaveLength(0);
  });

  test("POST resolves the public origin from swarm_config before env", async () => {
    process.env.PUBLIC_MCP_BASE_URL = "http://localhost:3013";
    await upsertSwarmConfig({
      scope: "global",
      key: "PUBLIC_MCP_BASE_URL",
      value: "https://configured.example.com/",
    });
    const user = await createUser({ name: "Config Origin User" });
    const body = await createCode(user.id);
    expect(new URL(body.connectUrl).searchParams.get("swarm")).toBe(
      "https://configured.example.com",
    );
  });

  test("discovery is public and reports the API, dashboard and connect URLs", async () => {
    const originalAppUrl = process.env.APP_URL;
    const originalDashboardUrl = process.env.DASHBOARD_URL;
    try {
      delete process.env.APP_URL;
      delete process.env.DASHBOARD_URL;
      const bare = await fetch(url("/api/connector/discovery"));
      expect(bare.status).toBe(200);
      expect(await bare.json()).toEqual({
        apiUrl: "https://swarm.example.com",
        connectUrl: "https://mcp.agent-swarm.dev/connections",
      });

      process.env.APP_URL = "https://env-app.example.com";
      await upsertSwarmConfig({
        scope: "global",
        key: "APP_URL",
        value: "https://app.example.com/, https://other.example.com",
      });
      process.env.CONNECTOR_CONNECT_URL = "http://insecure.test/connect";
      const configured = await fetch(url("/api/connector/discovery"));
      expect(await configured.json()).toEqual({
        apiUrl: "https://swarm.example.com",
        appUrl: "https://app.example.com",
        connectUrl: null,
      });
    } finally {
      if (originalAppUrl === undefined) delete process.env.APP_URL;
      else process.env.APP_URL = originalAppUrl;
      if (originalDashboardUrl === undefined) delete process.env.DASHBOARD_URL;
      else process.env.DASHBOARD_URL = originalDashboardUrl;
    }
  });

  test("POST rejects a non-HTTPS public origin, unknown users, and missing auth", async () => {
    const user = await createUser({ name: "Http Origin User" });
    process.env.PUBLIC_MCP_BASE_URL = "http://localhost:3013";
    const insecure = await authedFetch(`/api/users/${user.id}/connector-codes`, {
      method: "POST",
      body: "{}",
    });
    expect(insecure.status).toBe(400);
    process.env.PUBLIC_MCP_BASE_URL = "https://swarm.example.com";

    const unknown = await authedFetch("/api/users/not-a-user/connector-codes", {
      method: "POST",
      body: "{}",
    });
    expect(unknown.status).toBe(404);

    const unauthed = await fetch(url(`/api/users/${user.id}/connector-codes`), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    expect(unauthed.status).toBe(401);
    expect(await getDbClient().query("SELECT code_hash FROM connector_codes")).toHaveLength(0);
  });

  test("exchange mints a working token without the API key and records token_minted", async () => {
    const user = await createUser({ name: "Exchange User" });
    const { code } = await createCode(user.id);

    const response = await exchange(code);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { token: string; userId: string; version: string };
    expect(body.token.startsWith("aswt_")).toBe(true);
    expect(body.userId).toBe(user.id);
    const pkg = (await Bun.file("package.json").json()) as { version: string };
    expect(body.version).toBe(pkg.version);

    expect((await resolveUserByToken(body.token))?.id).toBe(user.id);
    const event = await getDbClient().get<{ actor: string; afterJson: string }>(
      "SELECT actor, afterJson FROM user_identity_events WHERE userId = ? AND eventType = 'token_minted'",
      [user.id],
    );
    expect(event?.actor).toBe(`operator:${fingerprintApiKey(API_KEY)}`);
    expect(JSON.parse(event!.afterJson).label).toBe("ChatGPT connector");
    expect(JSON.parse(event!.afterJson).source).toBe("connector_exchange");
    const row = await getDbClient().get<{ used_at: string | null }>(
      "SELECT used_at FROM connector_codes WHERE user_id = ?",
      [user.id],
    );
    expect(row?.used_at).toBeTruthy();
  });

  test("exchange returns the same 404 for reused, expired and unknown codes", async () => {
    const user = await createUser({ name: "Invalid Code User" });
    const { code } = await createCode(user.id);
    expect((await exchange(code)).status).toBe(200);

    const reused = await exchange(code);
    expect(reused.status).toBe(404);
    expect(await reused.json()).toEqual({ error: "code_invalid" });

    const { code: expiredCode } = await createCode(user.id);
    await getDbClient().run("UPDATE connector_codes SET expires_at = ? WHERE used_at IS NULL", [
      new Date(Date.now() - 1000).toISOString(),
    ]);
    const expired = await exchange(expiredCode);
    expect(expired.status).toBe(404);
    expect(await expired.json()).toEqual({ error: "code_invalid" });

    const unknown = await exchange("not-a-real-code");
    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toEqual({ error: "code_invalid" });

    const tokens = await getDbClient().query("SELECT id FROM user_tokens WHERE userId = ?", [
      user.id,
    ]);
    expect(tokens).toHaveLength(1);
  });

  test("exchange rejects malformed codes with 404 and oversized bodies with 413", async () => {
    const user = await createUser({ name: "Malformed Code User" });
    const { code } = await createCode(user.id);

    const truncated = await exchange(code.slice(0, 42));
    expect(truncated.status).toBe(404);
    expect(await truncated.json()).toEqual({ error: "code_invalid" });

    const oversized = await fetch(url("/api/connector/exchange"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: "x".repeat(4096) }),
    });
    expect(oversized.status).toBe(413);

    // The real code still works after the rejected attempts.
    expect((await exchange(code)).status).toBe(200);
  });

  test("concurrent exchanges of one code mint exactly one token", async () => {
    const user = await createUser({ name: "Race User" });
    const { code } = await createCode(user.id);
    const results = await Promise.all([exchangeConnectorCode(code), exchangeConnectorCode(code)]);
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  test("exchange is rate limited to 10 per minute per IP", async () => {
    const ip = { "X-Forwarded-For": "203.0.113.7" };
    for (let i = 0; i < 10; i++) {
      expect((await exchange(`unknown-${i}`, ip)).status).toBe(404);
    }
    const limited = await exchange("unknown-11", ip);
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("6");
    expect((await exchange("other-ip", { "X-Forwarded-For": "203.0.113.8" })).status).toBe(404);
  });

  test("cleanup deletes codes that expired more than an hour ago", async () => {
    const user = await createUser({ name: "Sweep User" });
    await createCode(user.id);
    await createCode(user.id);
    const now = Date.now();
    await getDbClient().run(
      "UPDATE connector_codes SET expires_at = ? WHERE rowid = (SELECT MIN(rowid) FROM connector_codes)",
      [new Date(now - 61 * 60 * 1000).toISOString()],
    );
    expect(await deleteExpiredConnectorCodes(new Date(now))).toBe(1);
    expect(await getDbClient().query("SELECT code_hash FROM connector_codes")).toHaveLength(1);
  });
});

describe("clientIp", () => {
  function fakeReq(remoteAddress: string, xff?: string): IncomingMessage {
    return {
      socket: { remoteAddress },
      headers: xff ? { "x-forwarded-for": xff } : {},
    } as unknown as IncomingMessage;
  }

  test("trusts the rightmost X-Forwarded-For hop only behind a private peer", () => {
    expect(clientIp(fakeReq("127.0.0.1", "1.1.1.1, 203.0.113.7"))).toBe("203.0.113.7");
    expect(clientIp(fakeReq("::ffff:172.18.0.2", "203.0.113.7"))).toBe("203.0.113.7");
    expect(clientIp(fakeReq("10.0.0.5", "203.0.113.7"))).toBe("203.0.113.7");
  });

  test("ignores X-Forwarded-For from a public peer", () => {
    expect(clientIp(fakeReq("198.51.100.4", "203.0.113.7"))).toBe("198.51.100.4");
    expect(clientIp(fakeReq("172.32.0.1", "203.0.113.7"))).toBe("172.32.0.1");
  });

  test("falls back to the peer when the header is absent", () => {
    expect(clientIp(fakeReq("127.0.0.1"))).toBe("127.0.0.1");
  });
});

describe("createIpRateLimiter", () => {
  test("caps tracked buckets by evicting the oldest key", () => {
    const limiter = createIpRateLimiter({ capacity: 1, refillPerMs: 0 });
    const now = 1_000;
    expect(limiter.take("first", now)).toBe(true);
    expect(limiter.take("first", now)).toBe(false);
    for (let i = 0; i < 50_000; i++) limiter.take(`ip-${i}`, now);
    // "first" was evicted, so it starts with a fresh bucket.
    expect(limiter.take("first", now)).toBe(true);
  });
});
