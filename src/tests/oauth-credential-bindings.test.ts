import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { unlink } from "node:fs/promises";
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { closeDb, createAgent, getDb, initDb } from "../be/db";
import {
  deleteOAuthTokens,
  getOAuthApp,
  getOAuthTokens,
  storeOAuthTokens,
  upsertOAuthApp,
} from "../be/db-queries/oauth";
import { getOAuthProviderConfig } from "../be/oauth-credential-bindings";
import {
  listRelationalCredentialBindings,
  upsertCredentialBinding,
} from "../be/script-connections";
import { buildScriptCredentialBindings } from "../be/script-credential-broker";
import { handleGenericOAuth } from "../http/oauth-generic";
import { getPathSegments, parseQueryParams } from "../http/utils";
import { _clearPendingStates, buildAuthorizationUrl } from "../oauth/wrapper";
import { registerCredentialBindingsTool } from "../tools/credential-bindings";

const TEST_DB_PATH = "./test-oauth-credential-bindings.sqlite";
const LEAD_ID = "aaaa9000-0000-4000-8000-000000000001";
const originalFetch = globalThis.fetch;
const savedEnv = { ...process.env };

type RegisteredTool = {
  handler: (args: unknown, extra: unknown) => Promise<unknown>;
};

type ToolResult = {
  structuredContent: {
    success: boolean;
    message: string;
    bindings: Array<{
      configKey: string;
      authKind?: "config" | "oauth";
      oauthAuthorizationId?: string;
      tokenStatus?: "ok" | "expiring" | "refresh-failed" | "revoked" | "missing";
    }>;
  };
};

function testApp(provider: string, tokenUrl = "https://oauth.example.test/token") {
  return {
    clientId: `${provider}-client`,
    clientSecret: `${provider}-secret`,
    authorizeUrl: "https://oauth.example.test/authorize",
    tokenUrl,
    redirectUri: `https://api.public.test/api/oauth/${provider}/callback`,
    scopes: "read,write",
  };
}

function credentialBindingsTool() {
  const server = new McpServer({ name: "oauth-credential-bindings-test", version: "1.0.0" });
  registerCredentialBindingsTool(server);
  const registered = (server as unknown as { _registeredTools: Record<string, RegisteredTool> })
    ._registeredTools;
  const tool = registered["credential-bindings"];
  if (!tool) throw new Error("credential-bindings tool not registered");
  return tool;
}

function meta(agentId = LEAD_ID) {
  return {
    sessionId: "oauth-credential-bindings-test-session",
    requestInfo: { headers: { "x-agent-id": agentId } },
  };
}

function createOAuthServer(): Server {
  return createHttpServer(async (req: IncomingMessage, res: ServerResponse) => {
    const handled = await handleGenericOAuth(
      req,
      res,
      getPathSegments(req.url || ""),
      parseQueryParams(req.url || ""),
    );
    if (!handled) {
      res.writeHead(404);
      res.end("not found");
    }
  });
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server did not bind");
  return address.port;
}

function cleanupRows() {
  const db = getDb();
  db.run("DELETE FROM script_credential_bindings WHERE config_key LIKE 'PHASE2_%'");
  db.run("DELETE FROM oauth_apps WHERE provider LIKE 'phase2-%'");
}

beforeAll(async () => {
  await unlink(TEST_DB_PATH).catch(() => {});
  await unlink(`${TEST_DB_PATH}-wal`).catch(() => {});
  await unlink(`${TEST_DB_PATH}-shm`).catch(() => {});
  initDb(TEST_DB_PATH);
  createAgent({ id: LEAD_ID, name: "OAuth Credential Lead", isLead: true, status: "idle" });
});

beforeEach(() => {
  cleanupRows();
  _clearPendingStates();
  process.env.PUBLIC_MCP_BASE_URL = "https://api.public.test";
  globalThis.fetch = originalFetch;
});

afterEach(() => {
  cleanupRows();
  _clearPendingStates();
  globalThis.fetch = originalFetch;
  for (const key of Object.keys(process.env)) {
    if (!(key in savedEnv)) delete process.env[key];
  }
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

afterAll(async () => {
  globalThis.fetch = originalFetch;
  closeDb();
  await unlink(TEST_DB_PATH).catch(() => {});
  await unlink(`${TEST_DB_PATH}-wal`).catch(() => {});
  await unlink(`${TEST_DB_PATH}-shm`).catch(() => {});
});

describe("OAuth credential bindings", () => {
  test("migration columns round-trip through credential binding persistence", () => {
    const columns = getDb()
      .query<{ name: string }, []>("PRAGMA table_info(script_credential_bindings)")
      .all()
      .map((column) => column.name);
    expect(columns).toContain("auth_kind");
    expect(columns).toContain("oauth_authorization_id");

    upsertOAuthApp("phase2-roundtrip", testApp("phase2-roundtrip"));
    storeOAuthTokens("phase2-roundtrip", {
      accessToken: "roundtrip-access",
      expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    });
    const authorizationId = getOAuthTokens("phase2-roundtrip")!.id;

    const binding = upsertCredentialBinding({
      configKey: "PHASE2_ROUNDTRIP_OAUTH",
      allowedHosts: ["api.vendor.test"],
      headerTemplate: "Authorization: Bearer [REDACTED:PHASE2_ROUNDTRIP_OAUTH]",
      authKind: "oauth",
      oauthAuthorizationId: authorizationId,
    });

    expect(binding.authKind).toBe("oauth");
    expect(binding.oauthAuthorizationId).toBe(authorizationId);

    const listed = listRelationalCredentialBindings({ includeInactive: true }).find(
      (item) => item.id === binding.id,
    );
    expect(listed?.authKind).toBe("oauth");
    expect(listed?.oauthAuthorizationId).toBe(authorizationId);
  });

  test("OAuth binding resolves through the stored access token", async () => {
    upsertOAuthApp("phase2-resolve", testApp("phase2-resolve"));
    storeOAuthTokens("phase2-resolve", {
      accessToken: "stored-oauth-access",
      refreshToken: "stored-oauth-refresh",
      expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    });
    upsertCredentialBinding({
      configKey: "PHASE2_RESOLVE_OAUTH",
      allowedHosts: ["api.vendor.test"],
      headerTemplate: "Authorization: Bearer [REDACTED:PHASE2_RESOLVE_OAUTH]",
      authKind: "oauth",
      oauthAuthorizationId: getOAuthTokens("phase2-resolve")!.id,
    });
    process.env.PHASE2_RESOLVE_OAUTH = "env-must-not-win";

    const bindings = await buildScriptCredentialBindings({});

    expect(bindings).toContainEqual(
      expect.objectContaining({
        configKey: "PHASE2_RESOLVE_OAUTH",
        value: "stored-oauth-access",
      }),
    );
  });

  test("expiring OAuth binding token is refreshed before resolution", async () => {
    upsertOAuthApp("phase2-refresh", testApp("phase2-refresh"));
    storeOAuthTokens("phase2-refresh", {
      accessToken: "old-access-token",
      refreshToken: "old-refresh-token",
      expiresAt: new Date(Date.now() + 60 * 1000).toISOString(),
    });
    upsertCredentialBinding({
      configKey: "PHASE2_REFRESH_OAUTH",
      allowedHosts: ["api.vendor.test"],
      headerTemplate: "Authorization: Bearer [REDACTED:PHASE2_REFRESH_OAUTH]",
      authKind: "oauth",
      oauthAuthorizationId: getOAuthTokens("phase2-refresh")!.id,
    });

    const fetchSpy = mock((input: string | URL | Request, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : input.toString();
      if (url !== "https://oauth.example.test/token") {
        return originalFetch(input, init);
      }
      expect(init?.method).toBe("POST");
      expect(String(init?.body)).toContain("grant_type=refresh_token");
      expect(String(init?.body)).toContain("refresh_token=old-refresh-token");
      return Promise.resolve(
        Response.json({
          access_token: "new-access-token",
          token_type: "Bearer",
          expires_in: 3600,
          refresh_token: "new-refresh-token",
        }),
      );
    });
    globalThis.fetch = fetchSpy as typeof fetch;

    const bindings = await buildScriptCredentialBindings({});

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(bindings).toContainEqual(
      expect.objectContaining({
        configKey: "PHASE2_REFRESH_OAUTH",
        value: "new-access-token",
      }),
    );
    expect(getOAuthTokens("phase2-refresh")?.refreshToken).toBe("new-refresh-token");
  });

  test("basic tokenAuthStyle + json tokenBodyFormat reach the token endpoint (Notion-style)", async () => {
    upsertOAuthApp("phase2-basic", {
      ...testApp("phase2-basic"),
      metadata: JSON.stringify({ tokenAuthStyle: "basic", tokenBodyFormat: "json" }),
    });
    storeOAuthTokens("phase2-basic", {
      accessToken: "old-basic-access",
      refreshToken: "old-basic-refresh",
      expiresAt: new Date(Date.now() + 60 * 1000).toISOString(),
    });
    upsertCredentialBinding({
      configKey: "PHASE2_BASIC_OAUTH",
      allowedHosts: ["api.vendor.test"],
      headerTemplate: "Authorization: Bearer [REDACTED:PHASE2_BASIC_OAUTH]",
      authKind: "oauth",
      oauthAuthorizationId: getOAuthTokens("phase2-basic")!.id,
    });

    const config = getOAuthProviderConfig("phase2-basic");
    expect(config?.tokenAuthStyle).toBe("basic");
    expect(config?.tokenBodyFormat).toBe("json");

    const expectedBasic = `Basic ${Buffer.from("phase2-basic-client:phase2-basic-secret").toString("base64")}`;
    const fetchSpy = mock((input: string | URL | Request, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : input.toString();
      if (url !== "https://oauth.example.test/token") {
        return originalFetch(input, init);
      }
      const headers = new Headers(init?.headers);
      expect(headers.get("authorization")).toBe(expectedBasic);
      expect(headers.get("content-type")).toBe("application/json");
      const body = JSON.parse(String(init?.body)) as Record<string, string>;
      expect(body.grant_type).toBe("refresh_token");
      expect(body.refresh_token).toBe("old-basic-refresh");
      // Basic auth carries the client credentials — they must NOT be in the body
      expect(body.client_id).toBeUndefined();
      expect(body.client_secret).toBeUndefined();
      return Promise.resolve(
        Response.json({
          access_token: "new-basic-access",
          token_type: "Bearer",
          expires_in: 3600,
          refresh_token: "new-basic-refresh",
        }),
      );
    });
    globalThis.fetch = fetchSpy as typeof fetch;

    const bindings = await buildScriptCredentialBindings({});

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(bindings).toContainEqual(
      expect.objectContaining({
        configKey: "PHASE2_BASIC_OAUTH",
        value: "new-basic-access",
      }),
    );
  });

  test("generic OAuth authorize URL uses space-separated scopes", async () => {
    upsertOAuthApp("phase2-scopes", testApp("phase2-scopes"));
    const config = getOAuthProviderConfig("phase2-scopes");
    expect(config).not.toBeNull();
    if (!config) throw new Error("missing provider config");
    const { url } = await buildAuthorizationUrl(config);
    expect(url).toContain("scope=read+write");
    expect(url).not.toContain("scope=read%2Cwrite");
  });

  test("metadata actor remains an authorization parameter without lifted extras", () => {
    upsertOAuthApp("phase2-actor", {
      ...testApp("phase2-actor"),
      metadata: JSON.stringify({ actor: "app" }),
    });

    expect(getOAuthProviderConfig("phase2-actor")?.extraParams).toEqual({ actor: "app" });
  });

  test("credential-bindings tool rejects reserved tracker OAuth providers", async () => {
    const result = (await credentialBindingsTool().handler(
      {
        action: "oauth-app-upsert",
        provider: "jira",
        clientId: "jira-client",
        clientSecret: "jira-secret",
        authorizeUrl: "https://oauth.example.test/authorize",
        tokenUrl: "https://oauth.example.test/token",
        scopes: [],
      },
      meta(),
    )) as ToolResult;

    expect(result.structuredContent.success).toBe(false);
    expect(result.structuredContent.message).toContain("dedicated tracker");
    expect(getOAuthApp("jira")).toBeNull();
  });

  test("credential-bindings tool validates OAuth app URLs in production", async () => {
    process.env.NODE_ENV = "production";

    const rejected = (await credentialBindingsTool().handler(
      {
        action: "oauth-app-upsert",
        provider: "phase2-tool-unsafe",
        clientId: "unsafe-client",
        clientSecret: "unsafe-secret",
        authorizeUrl: "https://oauth.example.test/authorize",
        tokenUrl: "http://127.0.0.1/token",
        scopes: [],
      },
      meta(),
    )) as ToolResult;

    expect(rejected.structuredContent.success).toBe(false);
    expect(rejected.structuredContent.message).toMatch(/private IPv4|insecure/);
    expect(getOAuthApp("phase2-tool-unsafe")).toBeNull();

    const accepted = (await credentialBindingsTool().handler(
      {
        action: "oauth-app-upsert",
        provider: "phase2-tool-safe",
        clientId: "safe-client",
        clientSecret: "safe-secret",
        authorizeUrl: "https://oauth.example.test/authorize",
        tokenUrl: "https://oauth.example.test/token",
        scopes: ["read"],
      },
      meta(),
    )) as ToolResult;

    expect(accepted.structuredContent.success).toBe(true);
    expect(getOAuthApp("phase2-tool-safe")?.clientId).toBe("safe-client");
  });

  test("failed OAuth token refresh skips only that binding, others still resolve", async () => {
    upsertOAuthApp("phase2-broken", testApp("phase2-broken"));
    storeOAuthTokens("phase2-broken", {
      accessToken: "stale-access-token",
      refreshToken: "stale-refresh-token",
      expiresAt: new Date(Date.now() + 60 * 1000).toISOString(),
    });
    upsertCredentialBinding({
      configKey: "PHASE2_BROKEN_OAUTH",
      allowedHosts: ["api.vendor.test"],
      headerTemplate: "Authorization: Bearer [REDACTED:PHASE2_BROKEN_OAUTH]",
      authKind: "oauth",
      oauthAuthorizationId: getOAuthTokens("phase2-broken")!.id,
    });
    upsertCredentialBinding({
      configKey: "PHASE2_HEALTHY_CONFIG",
      allowedHosts: ["api.vendor.test"],
      headerTemplate: "Authorization: Bearer [REDACTED:PHASE2_HEALTHY_CONFIG]",
    });
    process.env.PHASE2_HEALTHY_CONFIG = "healthy-config-value";

    const fetchSpy = mock((input: string | URL | Request, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : input.toString();
      if (url !== "https://oauth.example.test/token") {
        return originalFetch(input, init);
      }
      return Promise.resolve(Response.json({ error: "invalid_grant" }, { status: 400 }));
    });
    globalThis.fetch = fetchSpy as typeof fetch;

    const bindings = await buildScriptCredentialBindings({});

    expect(bindings.some((binding) => binding.configKey === "PHASE2_BROKEN_OAUTH")).toBe(false);
    expect(bindings).toContainEqual(
      expect.objectContaining({
        configKey: "PHASE2_HEALTHY_CONFIG",
        value: "healthy-config-value",
      }),
    );
    delete process.env.PHASE2_HEALTHY_CONFIG;
  });

  test("revoked OAuth token skips binding resolution and list reports revoked", async () => {
    upsertOAuthApp("phase2-missing", testApp("phase2-missing"));
    storeOAuthTokens("phase2-missing", {
      accessToken: "soon-deleted",
      expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    });
    const authorizationId = getOAuthTokens("phase2-missing")!.id;
    upsertCredentialBinding({
      configKey: "PHASE2_MISSING_OAUTH",
      allowedHosts: ["api.vendor.test"],
      headerTemplate: "Authorization: Bearer [REDACTED:PHASE2_MISSING_OAUTH]",
      authKind: "oauth",
      oauthAuthorizationId: authorizationId,
    });
    deleteOAuthTokens("phase2-missing");
    process.env.PHASE2_MISSING_OAUTH = "env-must-not-win";

    const bindings = await buildScriptCredentialBindings({});
    expect(bindings.some((binding) => binding.configKey === "PHASE2_MISSING_OAUTH")).toBe(false);

    const result = (await credentialBindingsTool().handler(
      { action: "list" },
      meta(),
    )) as ToolResult;
    const listed = result.structuredContent.bindings.find(
      (binding) => binding.configKey === "PHASE2_MISSING_OAUTH",
    );
    expect(result.structuredContent.success).toBe(true);
    // Disconnect revokes the authorization in place (row kept for referential
    // continuity), so the binding surfaces as `revoked`, not `missing`.
    expect(listed?.tokenStatus).toBe("revoked");
  });

  test("generic OAuth callback exchanges code and stores tokens", async () => {
    const provider = "phase2-callback";
    upsertOAuthApp(provider, testApp(provider));
    const config = getOAuthProviderConfig(provider);
    if (!config) throw new Error("missing test oauth config");
    const { state } = await buildAuthorizationUrl(config);

    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : input.toString();
      if (url !== "https://oauth.example.test/token") {
        return originalFetch(input, init);
      }
      expect(init?.method).toBe("POST");
      expect(String(init?.body)).toContain("grant_type=authorization_code");
      expect(String(init?.body)).toContain("code=callback-code");
      return Response.json({
        access_token: "callback-access-token",
        token_type: "Bearer",
        expires_in: 3600,
        refresh_token: "callback-refresh-token",
        scope: "read write",
      });
    }) as typeof fetch;

    const server = createOAuthServer();
    const port = await listen(server);
    try {
      const res = await fetch(
        `http://localhost:${port}/api/oauth/${provider}/callback?code=callback-code&state=${state}`,
      );

      expect(res.status).toBe(200);
      expect(await res.text()).toContain("You can close this tab.");
      const tokens = getOAuthTokens(provider);
      expect(tokens?.accessToken).toBe("callback-access-token");
      expect(tokens?.refreshToken).toBe("callback-refresh-token");
    } finally {
      server.close();
    }
  });

  test("generic OAuth callback rejects linear", async () => {
    const server = createOAuthServer();
    const port = await listen(server);
    try {
      const res = await fetch(
        `http://localhost:${port}/api/oauth/linear/callback?code=callback-code&state=state`,
      );

      expect(res.status).toBe(409);
      const body = (await res.json()) as { error: string };
      expect(body.error).toContain("/api/trackers/linear/callback");
    } finally {
      server.close();
    }
  });
});
