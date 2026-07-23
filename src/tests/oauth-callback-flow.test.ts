import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { closeDb, createAgent, createMcpServer, getDb, initDb } from "../be/db";
import { getMcpServerAuthMethod, insertMcpOAuthPending } from "../be/db-queries/mcp-oauth";
import {
  createOAuthPending,
  gcOAuthPending,
  getAuthorizationById,
  getOAuthAppIdByProvider,
  listAuthorizationsForApp,
  upsertOAuthApp,
} from "../be/db-queries/oauth";
import { getOAuthProviderConfig } from "../be/oauth-credential-bindings";
import { handleOAuthCallback } from "../http/oauth-callback";
import { handleGenericOAuth } from "../http/oauth-generic";
import { handleScriptConnections } from "../http/script-connections";
import { getPathSegments, parseQueryParams } from "../http/utils";
import { buildAuthorizationUrl } from "../oauth/wrapper";

const TEST_DB_PATH = "./test-oauth-callback-flow.sqlite";
const LEAD_ID = "aaaa9100-0000-4000-8000-000000000001";
const NON_LEAD_ID = "aaaa9100-0000-4000-8000-000000000002";

// ─── Mock OAuth provider (token + userinfo endpoints) ────────────────────────

let providerServer: ReturnType<typeof Bun.serve>;
let providerBase = "";
let lastTokenBody = "";

// ─── App-side callback dispatcher (wraps the real handlers) ──────────────────

function callbackServer(): Server {
  return createHttpServer(async (req: IncomingMessage, res: ServerResponse) => {
    const pathSegments = getPathSegments(req.url || "");
    const queryParams = parseQueryParams(req.url || "");
    if (await handleOAuthCallback(req, res, pathSegments, queryParams)) return;
    if (await handleGenericOAuth(req, res, pathSegments, queryParams)) return;
    const agentId = (req.headers["x-agent-id"] as string | undefined) ?? undefined;
    if (await handleScriptConnections(req, res, pathSegments, queryParams, agentId)) return;
    res.writeHead(404);
    res.end("not found");
  });
}

let appServer: Server;
let appBase = "";

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server did not bind");
  return address.port;
}

function testApp(provider: string) {
  return {
    clientId: `${provider}-client`,
    clientSecret: `${provider}-secret`,
    authorizeUrl: `${providerBase}/authorize`,
    tokenUrl: `${providerBase}/token`,
    redirectUri: `${appBase}/api/oauth/callback`,
    userinfoUrl: `${providerBase}/userinfo`,
    scopes: "read,write",
  };
}

const savedAllowPrivateHosts = process.env.MCP_OAUTH_ALLOW_PRIVATE_HOSTS;

beforeAll(async () => {
  // The mock provider runs on localhost; MCP token exchange SSRF-guards loopback.
  process.env.MCP_OAUTH_ALLOW_PRIVATE_HOSTS = "true";
  initDb(TEST_DB_PATH);
  createAgent({ id: LEAD_ID, name: "lead", isLead: true, status: "idle" });
  createAgent({ id: NON_LEAD_ID, name: "worker", isLead: false, status: "idle" });

  providerServer = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/token") {
        lastTokenBody = await req.text();
        return Response.json({
          access_token: "mock-access-token",
          token_type: "Bearer",
          expires_in: 3600,
          refresh_token: "mock-refresh-token",
          scope: "read write",
        });
      }
      if (url.pathname === "/userinfo") {
        return Response.json({ email: "connected@example.test", sub: "user-123" });
      }
      return new Response("not found", { status: 404 });
    },
  });
  providerBase = `http://localhost:${providerServer.port}`;

  appServer = callbackServer();
  appBase = `http://localhost:${await listen(appServer)}`;
});

afterAll(async () => {
  if (savedAllowPrivateHosts === undefined) delete process.env.MCP_OAUTH_ALLOW_PRIVATE_HOSTS;
  else process.env.MCP_OAUTH_ALLOW_PRIVATE_HOSTS = savedAllowPrivateHosts;
  appServer.close();
  await providerServer.stop(true);
  closeDb();
  await unlink(TEST_DB_PATH).catch(() => {});
  await unlink(`${TEST_DB_PATH}-wal`).catch(() => {});
  await unlink(`${TEST_DB_PATH}-shm`).catch(() => {});
});

afterEach(() => {
  lastTokenBody = "";
});

async function driveStaticCallback(state: string, code = "auth-code"): Promise<Response> {
  return fetch(`${appBase}/api/oauth/callback?code=${code}&state=${state}`, {
    redirect: "manual",
  });
}

describe("static OAuth callback + multi-authorization flow", () => {
  test("GET /api/oauth/redirect-uri returns the static callback URL", async () => {
    const res = await fetch(`${appBase}/api/oauth/redirect-uri`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { redirectUri: string };
    expect(body.redirectUri).toContain("/api/oauth/callback");
  });

  test("two labeled authorizations land independently with captured identity", async () => {
    const provider = "flow-multi";
    upsertOAuthApp(provider, testApp(provider));
    const appId = getOAuthAppIdByProvider(provider);
    expect(appId).toBeTruthy();
    const config = getOAuthProviderConfig(provider);
    if (!appId || !config) throw new Error("app setup failed");

    // First label: "support"
    const support = await buildAuthorizationUrl(config, {
      appId,
      label: "support",
      flow: "generic",
    });
    const res1 = await driveStaticCallback(support.state);
    expect(res1.status).toBe(200);
    expect(lastTokenBody).toContain("grant_type=authorization_code");

    let authorizations = listAuthorizationsForApp(appId);
    expect(authorizations).toHaveLength(1);
    const supportAuth = authorizations[0]!;
    expect(supportAuth.label).toBe("support");
    expect(supportAuth.status).toBe("active");
    expect(supportAuth.accountEmail).toBe("connected@example.test");
    // Tokens are encrypted at rest but decrypt to the mock values on read.
    expect(supportAuth.tokensEncrypted).toBe(true);
    expect(supportAuth.accessToken).toBe("mock-access-token");
    expect(supportAuth.refreshToken).toBe("mock-refresh-token");

    // Second label: "sales" — first authorization must be untouched.
    const sales = await buildAuthorizationUrl(config, { appId, label: "sales", flow: "generic" });
    const res2 = await driveStaticCallback(sales.state);
    expect(res2.status).toBe(200);

    authorizations = listAuthorizationsForApp(appId);
    expect(authorizations).toHaveLength(2);
    const labels = authorizations.map((a) => a.label).sort();
    expect(labels).toEqual(["sales", "support"]);
    // Same support authorization id preserved.
    expect(getAuthorizationById(supportAuth.id)?.label).toBe("support");
  });

  test("POST /api/oauth-apps/{id}/authorize-url (lead) issues a state the callback completes", async () => {
    const provider = "flow-http-route";
    upsertOAuthApp(provider, testApp(provider));
    const appId = getOAuthAppIdByProvider(provider)!;

    const authRes = await fetch(`${appBase}/api/oauth-apps/${appId}/authorize-url`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-agent-id": LEAD_ID },
      body: JSON.stringify({ label: "billing" }),
    });
    expect(authRes.status).toBe(200);
    const payload = (await authRes.json()) as {
      authorizeUrl: string;
      state: string;
      label: string;
      redirectUri: string;
    };
    expect(payload.label).toBe("billing");
    expect(payload.redirectUri).toContain("/api/oauth/callback");
    expect(new URL(payload.authorizeUrl).searchParams.get("state")).toBe(payload.state);

    const res = await driveStaticCallback(payload.state);
    expect(res.status).toBe(200);
    expect(listAuthorizationsForApp(appId).some((a) => a.label === "billing")).toBe(true);

    // The list route surfaces the authorization (no token material).
    const listRes = await fetch(`${appBase}/api/oauth-apps/${appId}/authorizations`);
    const listed = (await listRes.json()) as {
      authorizations: Array<{ label: string; accountEmail: string | null }>;
    };
    const billing = listed.authorizations.find((a) => a.label === "billing");
    expect(billing?.accountEmail).toBe("connected@example.test");
  });

  test("state is single-use — replay is rejected", async () => {
    const provider = "flow-replay";
    upsertOAuthApp(provider, testApp(provider));
    const appId = getOAuthAppIdByProvider(provider)!;
    const config = getOAuthProviderConfig(provider)!;
    const { state } = await buildAuthorizationUrl(config, { appId, flow: "generic" });

    expect((await driveStaticCallback(state)).status).toBe(200);
    const replay = await driveStaticCallback(state);
    expect(replay.status).toBe(400);
    expect((await replay.json()).error).toContain("Invalid or expired OAuth state");
  });

  test("expired pending rows are garbage-collected", async () => {
    const provider = "flow-gc";
    upsertOAuthApp(provider, testApp(provider));
    const appId = getOAuthAppIdByProvider(provider)!;
    createOAuthPending({
      state: "gc-state",
      appId,
      flow: "generic",
      codeVerifier: "verifier",
      redirectUri: `${appBase}/api/oauth/callback`,
    });
    // Sweep everything created before "now + 1s" — removes the fresh row.
    const removed = gcOAuthPending(-1000);
    expect(removed).toBeGreaterThanOrEqual(1);
    const res = await driveStaticCallback("gc-state");
    expect(res.status).toBe(400);
  });

  test("legacy per-provider callback still completes a flow", async () => {
    const provider = "flow-legacy";
    upsertOAuthApp(provider, testApp(provider));
    const appId = getOAuthAppIdByProvider(provider)!;
    const config = getOAuthProviderConfig(provider)!;
    const { state } = await buildAuthorizationUrl(config, { appId, flow: "generic" });
    const res = await fetch(
      `${appBase}/api/oauth/${provider}/callback?code=legacy-code&state=${state}`,
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("You can close this tab.");
    expect(listAuthorizationsForApp(appId)).toHaveLength(1);
  });

  test("pending state is persisted in the DB (restart-safe, not an in-memory map)", async () => {
    const provider = "flow-restart";
    upsertOAuthApp(provider, testApp(provider));
    const appId = getOAuthAppIdByProvider(provider)!;
    const config = getOAuthProviderConfig(provider)!;
    const { state, codeVerifier } = await buildAuthorizationUrl(config, {
      appId,
      label: "persisted",
      flow: "generic",
    });

    // The row lives in oauth_pending (encrypted verifier) — a process restart
    // would keep it, unlike the old in-memory PKCE map. Assert it is on disk,
    // then complete the flow.
    const row = getDb()
      .query("SELECT state, label, flow, codeVerifier FROM oauth_pending WHERE state = ?")
      .get(state) as { state: string; label: string; flow: string; codeVerifier: string } | null;
    expect(row).toBeTruthy();
    expect(row!.label).toBe("persisted");
    expect(row!.flow).toBe("generic");
    // Stored encrypted — never the raw verifier.
    expect(row!.codeVerifier).not.toBe(codeVerifier);

    const res = await driveStaticCallback(state);
    expect(res.status).toBe(200);
    expect(listAuthorizationsForApp(appId).some((a) => a.label === "persisted")).toBe(true);
  });

  test("MCP-flow pending routes through the static callback and flips authMethod", async () => {
    const mcpServer = createMcpServer({
      name: `mcp-static-flip-${crypto.randomUUID()}`,
      transport: "http",
      url: `${providerBase}/mcp`,
      scope: "swarm",
    });
    insertMcpOAuthPending({
      state: "mcp-static-state",
      mcpServerId: mcpServer.id,
      codeVerifier: "mcp-verifier",
      resourceUrl: `${providerBase}/mcp`,
      authorizationServerIssuer: providerBase,
      authorizeUrl: `${providerBase}/authorize`,
      tokenUrl: `${providerBase}/token`,
      scopes: "read",
      dcrClientId: "mcp-client",
      dcrClientSecret: "mcp-secret",
      redirectUri: `${appBase}/api/oauth/callback`,
    });

    expect(getMcpServerAuthMethod(mcpServer.id)).not.toBe("oauth");
    const res = await driveStaticCallback("mcp-static-state", "mcp-code");
    // MCP callbacks redirect (302) back to the dashboard.
    expect(res.status).toBe(302);
    expect(getMcpServerAuthMethod(mcpServer.id)).toBe("oauth");
  });

  test("RBAC: non-lead agent is denied on the authorize-url manage route", async () => {
    const provider = "flow-rbac";
    upsertOAuthApp(provider, testApp(provider));
    const appId = getOAuthAppIdByProvider(provider)!;
    const res = await fetch(`${appBase}/api/oauth-apps/${appId}/authorize-url`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-agent-id": NON_LEAD_ID },
      body: JSON.stringify({ label: "support" }),
    });
    expect(res.status).toBe(403);
  });
});
