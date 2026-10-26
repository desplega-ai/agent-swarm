import { afterAll, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { unlink } from "node:fs/promises";
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { createConnectorCode, INVITE_CODE_TTL_MS } from "../be/connector-codes";
import { closeDb, createUser, getDbClient, initDb, upsertSwarmConfig } from "../be/db";
import { ensureRbacSeedsSynced, listUserRoles, setUserRoles } from "../be/rbac-roles";
import { type IdentityActor, mintToken } from "../be/users";
import { handleCore } from "../http/core";
import {
  _resetConnectorExchangeRateLimitForTests,
  _resetInviteExchangeRateLimitForTests,
  handleUsers,
} from "../http/users";
import { getPathSegments, parseQueryParams } from "../http/utils";
import { DEFAULT_APP_URL } from "../utils/constants";
import { listenOnFreePort } from "./test-net";

const TEST_DB_PATH = "./test-invites-http.sqlite";
const API_KEY = "example-test-invites-key";
const ACTOR: IdentityActor = { kind: "operator", id: "invites-test" };
const ORIGINAL_ENV = {
  AGENT_SWARM_API_KEY: process.env.AGENT_SWARM_API_KEY,
  PUBLIC_MCP_BASE_URL: process.env.PUBLIC_MCP_BASE_URL,
  APP_URL: process.env.APP_URL,
  DASHBOARD_URL: process.env.DASHBOARD_URL,
};

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

function restoreEnv(key: keyof typeof ORIGINAL_ENV): void {
  const value = ORIGINAL_ENV[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

let server: Server;
let port: number;

beforeAll(async () => {
  await removeDbFiles(TEST_DB_PATH);
  initDb(TEST_DB_PATH);
  ensureRbacSeedsSynced({ quiet: true });
  process.env.AGENT_SWARM_API_KEY = API_KEY;
  server = createTestServer(API_KEY);
  port = await listenOnFreePort(server, "127.0.0.1");
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  closeDb();
  await removeDbFiles(TEST_DB_PATH);
  for (const key of Object.keys(ORIGINAL_ENV) as Array<keyof typeof ORIGINAL_ENV>) {
    restoreEnv(key);
  }
});

beforeEach(async () => {
  process.env.PUBLIC_MCP_BASE_URL = "https://swarm.example.com";
  process.env.APP_URL = "https://app.example.com";
  delete process.env.DASHBOARD_URL;
  _resetInviteExchangeRateLimitForTests();
  _resetConnectorExchangeRateLimitForTests();
  const client = getDbClient();
  await client.run("DELETE FROM connector_codes");
  await client.run("DELETE FROM swarm_config WHERE key IN ('PUBLIC_MCP_BASE_URL', 'APP_URL')");
  await client.run("DELETE FROM user_identity_events");
  await client.run("DELETE FROM user_tokens");
  await client.run("DELETE FROM principal_roles WHERE principalType = 'user'");
  await client.run("DELETE FROM users");
});

function url(path: string): string {
  return `http://127.0.0.1:${port}${path}`;
}

function post(path: string, body: unknown, bearer: string | null = API_KEY): Promise<Response> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (bearer) headers.Authorization = `Bearer ${bearer}`;
  return fetch(url(path), { method: "POST", headers, body: JSON.stringify(body) });
}

type InviteBody = {
  user: { id: string; email: string | null; name: string; status: string };
  inviteUrl: string;
  appUrl: string;
  expiresAt: string;
  apiReachable: "public" | "local";
};

async function invite(body: Record<string, unknown>, bearer = API_KEY): Promise<InviteBody> {
  const response = await post("/api/invites", body, bearer);
  expect(response.status).toBe(201);
  return (await response.json()) as InviteBody;
}

function codeOf(inviteUrl: string): string {
  const code = new URL(inviteUrl).pathname.split("/invite/")[1];
  if (!code) throw new Error("invite URL has no code");
  return code;
}

function exchange(code: string, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(url("/api/invites/exchange"), {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify({ code }),
  });
}

async function roleNames(userId: string): Promise<string[]> {
  return (await listUserRoles(userId)).map((role) => role.name).sort();
}

async function tokenCount(userId: string): Promise<number> {
  return (await getDbClient().query("SELECT id FROM user_tokens WHERE userId = ?", [userId]))
    .length;
}

describe("POST /api/invites", () => {
  test("creates an invited requester, stores only the code hash, and mints no token", async () => {
    const before = Date.now();
    const body = await invite({ email: "ada@example.com" });

    expect(body.user.status).toBe("invited");
    expect(body.user.email).toBe("ada@example.com");
    expect(body.user.name).toBe("ada");
    expect(body.apiReachable).toBe("public");
    const code = codeOf(body.inviteUrl);
    expect(body.inviteUrl).toBe(`https://swarm.example.com/invite/${code}`);
    expect(body.appUrl).toBe("https://app.example.com");
    expect(code).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const ttl = new Date(body.expiresAt).getTime() - before;
    expect(ttl).toBeGreaterThan(INVITE_CODE_TTL_MS - 60_000);
    expect(ttl).toBeLessThanOrEqual(INVITE_CODE_TTL_MS + 1000);

    const rows = await getDbClient().query<{ code_hash: string; kind: string; used_at: null }>(
      "SELECT code_hash, kind, used_at FROM connector_codes WHERE user_id = ?",
      [body.user.id],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.code_hash).toHaveLength(64);
    expect(rows[0]!.code_hash).not.toContain(code);
    expect(rows[0]!.kind).toBe("invite");
    expect(rows[0]!.used_at).toBeNull();
    expect(await tokenCount(body.user.id)).toBe(0);

    // The DB trigger's default admin role is replaced, not added to.
    expect(await roleNames(body.user.id)).toEqual(["requester"]);
  });

  test("honors the role and name, and falls back to the hosted dashboard", async () => {
    delete process.env.APP_URL;
    const body = await invite({ email: "grace@example.com", name: "Grace H", role: "viewer" });
    expect(body.user.name).toBe("Grace H");
    expect(await roleNames(body.user.id)).toEqual(["viewer"]);
    expect(body.appUrl).toBe(DEFAULT_APP_URL);
  });

  test("reports a loopback, private or single-label API as local", async () => {
    for (const origin of [
      "http://localhost:3013",
      "http://127.0.0.1:3013",
      "http://192.168.1.10:3013",
      "http://swarm-api:3013",
      "http://box.local:3013",
    ]) {
      process.env.PUBLIC_MCP_BASE_URL = origin;
      await getDbClient().run("DELETE FROM users");
      const body = await invite({ email: "local@example.com" });
      expect(body.apiReachable).toBe("local");
    }
  });

  test("an active or suspended email (or alias) gets 409 and no code", async () => {
    await createUser({ name: "Active", email: "active@example.com" });
    await createUser({ name: "Suspended", email: "suspended@example.com", status: "suspended" });
    await createUser({
      name: "Aliased",
      email: "main@example.com",
      emailAliases: ["alt@example.com"],
    });
    for (const email of ["active@example.com", "SUSPENDED@example.com", "alt@example.com"]) {
      const response = await post("/api/invites", { email });
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({ error: "user_exists" });
    }
    expect(await getDbClient().query("SELECT code_hash FROM connector_codes")).toHaveLength(0);
  });

  test("a re-invite sets the new role and replaces the old code", async () => {
    const first = await invite({ email: "re@example.com" });
    const second = await invite({ email: "re@example.com", role: "viewer" });
    expect(second.user.id).toBe(first.user.id);
    expect(await roleNames(first.user.id)).toEqual(["viewer"]);
    const codes = await getDbClient().query("SELECT code_hash FROM connector_codes");
    expect(codes).toHaveLength(1);

    const old = await exchange(codeOf(first.inviteUrl));
    expect(old.status).toBe(404);
    expect(await old.json()).toEqual({ error: "code_invalid" });
    expect((await exchange(codeOf(second.inviteUrl))).status).toBe(200);
  });

  test("rejects bad input, missing auth, and a requester caller", async () => {
    expect((await post("/api/invites", { email: "not-an-email" })).status).toBe(400);
    expect((await post("/api/invites", { email: "x@example.com", role: "owner" })).status).toBe(
      400,
    );
    expect((await post("/api/invites", { email: "x@example.com" }, null)).status).toBe(401);

    // Keep an active admin so the requester's role set is legal.
    const admin = await createUser({ name: "Admin", email: "admin@example.com" });
    const requester = await createUser({ name: "Req", email: "req@example.com" });
    await setUserRoles(requester.id, ["requester"], null);
    const { plaintext } = await mintToken(requester.id, "req", ACTOR);
    const denied = await post("/api/invites", { email: "x@example.com" }, plaintext);
    expect(denied.status).toBe(403);

    const adminToken = (await mintToken(admin.id, "admin", ACTOR)).plaintext;
    const allowed = await invite({ email: "x@example.com" }, adminToken);
    const event = await getDbClient().get<{ actor: string }>(
      "SELECT actor FROM user_identity_events WHERE userId = ? AND eventType = 'identity_added'",
      [allowed.user.id],
    );
    expect(event?.actor).toBe(`user:${admin.id}`);

    const users = await getDbClient().query<{ email: string }>("SELECT email FROM users");
    expect(users.map((u) => u.email).sort()).toEqual([
      "admin@example.com",
      "req@example.com",
      "x@example.com",
    ]);
  });

  test("a failed role set leaves no user and no code", async () => {
    await getDbClient().run("UPDATE roles SET name = 'requester-gone' WHERE name = 'requester'");
    try {
      const response = await post("/api/invites", { email: "rollback@example.com" });
      expect(response.status).toBe(500);
      const text = await response.text();
      expect(text).not.toContain("code=");
    } finally {
      await getDbClient().run("UPDATE roles SET name = 'requester' WHERE name = 'requester-gone'");
    }
    expect(await getDbClient().query("SELECT id FROM users")).toHaveLength(0);
    expect(await getDbClient().query("SELECT code_hash FROM connector_codes")).toHaveLength(0);
  });
});

describe("GET /invite/:code", () => {
  test("redirects without authentication and leaves the code available for exchange", async () => {
    const { inviteUrl } = await invite({ email: "preview@example.com" });
    const code = codeOf(inviteUrl);
    const response = await fetch(url(`/invite/${code}`), { redirect: "manual" });
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(
      `https://app.example.com/join?swarm=${encodeURIComponent("https://swarm.example.com")}#code=${code}`,
    );
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect((await exchange(code)).status).toBe(200);
  });

  test("resolves global config again when an existing link opens", async () => {
    const { inviteUrl } = await invite({ email: "config@example.com" });
    const code = codeOf(inviteUrl);
    await upsertSwarmConfig({
      scope: "global",
      key: "APP_URL",
      value: "https://custom.example.com/",
    });
    await upsertSwarmConfig({
      scope: "global",
      key: "PUBLIC_MCP_BASE_URL",
      value: "https://public.example.com/",
    });
    const response = await fetch(url(`/invite/${code}`), { redirect: "manual" });
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(
      `https://custom.example.com/join?swarm=${encodeURIComponent("https://public.example.com")}#code=${code}`,
    );
  });

  test("uses the hosted dashboard when no dashboard URL is configured", async () => {
    delete process.env.APP_URL;
    const code = "unknown_code_1234";
    const response = await fetch(url(`/invite/${code}`), { redirect: "manual" });
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(
      `${DEFAULT_APP_URL}/join?swarm=${encodeURIComponent("https://swarm.example.com")}#code=${code}`,
    );
  });

  test("rejects malformed codes without any database call", async () => {
    const client = getDbClient();
    const spies = [
      spyOn(client, "query"),
      spyOn(client, "get"),
      spyOn(client, "run"),
      spyOn(client, "transaction"),
    ];
    try {
      for (const code of ["short", "x".repeat(257), "invalid.code_12345", "invalid%20code_12345"]) {
        const response = await fetch(url(`/invite/${code}`), { redirect: "manual" });
        expect(response.status).toBe(404);
        expect(await response.json()).toEqual({ error: "code_invalid" });
      }
      for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });
});

describe("POST /api/invites/exchange", () => {
  test("activates the user and returns a token that works on whoami", async () => {
    const { user, inviteUrl } = await invite({ email: "ada@example.com" });

    const response = await exchange(codeOf(inviteUrl));
    expect(response.status).toBe(200);
    const body = (await response.json()) as { token: string; userId: string };
    expect(body.userId).toBe(user.id);
    expect(body.token.startsWith("aswt_")).toBe(true);

    const whoami = await fetch(url("/api/whoami"), {
      headers: { Authorization: `Bearer ${body.token}` },
    });
    expect(whoami.status).toBe(200);
    const me = (await whoami.json()) as { kind: string; user: { id: string; status: string } };
    expect(me.kind).toBe("user");
    expect(me.user.id).toBe(user.id);
    expect(me.user.status).toBe("active");

    const status = await getDbClient().get<{ beforeJson: string; afterJson: string }>(
      "SELECT beforeJson, afterJson FROM user_identity_events WHERE userId = ? AND eventType = 'status_changed'",
      [user.id],
    );
    expect(JSON.parse(status!.beforeJson).status).toBe("invited");
    expect(JSON.parse(status!.afterJson).status).toBe("active");
    const minted = await getDbClient().get<{ afterJson: string }>(
      "SELECT afterJson FROM user_identity_events WHERE userId = ? AND eventType = 'token_minted'",
      [user.id],
    );
    expect(JSON.parse(minted!.afterJson).source).toBe("invite_exchange");
    expect(await roleNames(user.id)).toEqual(["requester"]);
  });

  test("a second exchange, an expired code and an unknown code all get the same 404", async () => {
    const { user, inviteUrl } = await invite({ email: "once@example.com" });
    const code = codeOf(inviteUrl);
    expect((await exchange(code)).status).toBe(200);
    const again = await exchange(code);
    expect(again.status).toBe(404);
    expect(await again.json()).toEqual({ error: "code_invalid" });

    const expiredInvite = await invite({ email: "late@example.com" });
    await getDbClient().run("UPDATE connector_codes SET expires_at = ? WHERE user_id = ?", [
      new Date(Date.now() - 1000).toISOString(),
      expiredInvite.user.id,
    ]);
    const expired = await exchange(codeOf(expiredInvite.inviteUrl));
    expect(expired.status).toBe(404);
    expect(await expired.json()).toEqual({ error: "code_invalid" });
    expect(await tokenCount(expiredInvite.user.id)).toBe(0);

    const unknown = await exchange("A".repeat(43));
    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toEqual({ error: "code_invalid" });
    expect(await tokenCount(user.id)).toBe(1);
  });

  test("a user suspended before the exchange gets 404 and no token", async () => {
    const { user, inviteUrl } = await invite({ email: "gone@example.com" });
    await getDbClient().run("UPDATE users SET status = 'suspended' WHERE id = ?", [user.id]);
    const response = await exchange(codeOf(inviteUrl));
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "code_invalid" });
    expect(await tokenCount(user.id)).toBe(0);
    const row = await getDbClient().get<{ status: string }>(
      "SELECT status FROM users WHERE id = ?",
      [user.id],
    );
    expect(row?.status).toBe("suspended");
  });

  test("a connector code fails on the invite route, and an invite code on the connector route", async () => {
    const connectorUser = await createUser({ name: "Connector" });
    const { code: connectorCode } = await createConnectorCode(connectorUser.id, "c", ACTOR);
    expect((await exchange(connectorCode)).status).toBe(404);

    const { user, inviteUrl } = await invite({ email: "kind@example.com" });
    const inviteCode = codeOf(inviteUrl);
    const viaConnector = await fetch(url("/api/connector/exchange"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: inviteCode }),
    });
    expect(viaConnector.status).toBe(404);
    expect(await tokenCount(connectorUser.id)).toBe(0);
    expect(await tokenCount(user.id)).toBe(0);

    // Both codes still work on their own route.
    expect((await exchange(inviteCode)).status).toBe(200);
    const connectorOk = await fetch(url("/api/connector/exchange"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: connectorCode }),
    });
    expect(connectorOk.status).toBe(200);
  });

  test("rejects malformed codes with 404 and oversized bodies with 413", async () => {
    const { inviteUrl } = await invite({ email: "shape@example.com" });
    const code = codeOf(inviteUrl);
    expect((await exchange(code.slice(0, 42))).status).toBe(404);
    const oversized = await fetch(url("/api/invites/exchange"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: "x".repeat(4096) }),
    });
    expect(oversized.status).toBe(413);
    expect((await exchange(code)).status).toBe(200);
  });

  test("is rate limited to 10 per minute per IP", async () => {
    const ip = { "X-Forwarded-For": "203.0.113.9" };
    for (let i = 0; i < 10; i++) {
      expect((await exchange(`unknown-${i}`, ip)).status).toBe(404);
    }
    const limited = await exchange("unknown-11", ip);
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("6");
    expect((await exchange("other-ip", { "X-Forwarded-For": "203.0.113.10" })).status).toBe(404);
  });
});
