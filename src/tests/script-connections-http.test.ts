import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { closeDb, createAgent, getDb, initDb, upsertSwarmConfig } from "../be/db";
import {
  getOAuthApp,
  getOAuthTokens,
  storeOAuthTokens,
  upsertOAuthApp,
} from "../be/db-queries/oauth";
import { upsertCredentialBinding } from "../be/script-connections";
import { handleScriptConnections } from "../http/script-connections";
import { getPathSegments, parseQueryParams } from "../http/utils";

const TEST_DB_PATH = "./test-script-connections-http.sqlite";
const SECRET_VALUE = "vendor-secret-should-not-leak";

let leadAgentId: string;
let workerAgentId: string;
const originalFetch = globalThis.fetch;

async function removeDbFiles(path: string): Promise<void> {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      await unlink(path + suffix);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

type TestResponse = {
  status: number;
  text: string;
  json: () => Promise<unknown>;
};

async function dispatch(
  path: string,
  init: { method?: string; body?: unknown; agentId?: string } = {},
): Promise<TestResponse> {
  const req = Readable.from(
    init.body === undefined ? [] : [Buffer.from(JSON.stringify(init.body))],
  ) as IncomingMessage;
  req.method = init.method ?? "GET";
  req.url = path;
  req.headers = init.agentId
    ? {
        "x-agent-id": init.agentId,
        "content-type": "application/json",
      }
    : { "content-type": "application/json" };

  let status = 200;
  let text = "";
  const res = {
    headersSent: false,
    writableEnded: false,
    setHeader() {},
    writeHead(code: number) {
      status = code;
      this.headersSent = true;
      return this;
    },
    end(chunk?: unknown) {
      if (chunk !== undefined) text += String(chunk);
      this.writableEnded = true;
      return this;
    },
  } as unknown as ServerResponse;

  const pathSegments = getPathSegments(req.url || "");
  const queryParams = parseQueryParams(req.url || "");
  if (!(await handleScriptConnections(req, res, pathSegments, queryParams, init.agentId))) {
    res.writeHead(404);
    res.end("Not Found");
  }

  return {
    status,
    text,
    json: async () => JSON.parse(text),
  };
}

function inlineOpenApiSpec(): string {
  return JSON.stringify({
    openapi: "3.0.0",
    info: { title: "Vendor", version: "1.0.0" },
    paths: {
      "/items": {
        get: {
          operationId: "listItems",
          responses: {
            "200": {
              description: "OK",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: { ok: { type: "boolean" } },
                  },
                },
              },
            },
          },
        },
      },
    },
  });
}

beforeAll(async () => {
  await removeDbFiles(TEST_DB_PATH);
  initDb(TEST_DB_PATH);
  leadAgentId = createAgent({ name: "connections-http-lead", isLead: true, status: "idle" }).id;
  workerAgentId = createAgent({
    name: "connections-http-worker",
    isLead: false,
    status: "idle",
  }).id;
});

afterAll(async () => {
  globalThis.fetch = originalFetch;
  closeDb();
  await removeDbFiles(TEST_DB_PATH);
});

beforeEach(() => {
  globalThis.fetch = originalFetch;
  getDb().run("DELETE FROM script_connections");
  getDb().run("DELETE FROM script_credential_bindings");
  getDb().run("DELETE FROM oauth_tokens");
  getDb().run("DELETE FROM oauth_apps");
  getDb().run("DELETE FROM swarm_config");
});

describe("/api/script-connections HTTP", () => {
  test("POST upsert openapi inline spec succeeds as lead agent", async () => {
    const res = await dispatch("/api/script-connections", {
      method: "POST",
      agentId: leadAgentId,
      body: {
        kind: "openapi",
        slug: "vendor",
        displayName: "Vendor",
        baseUrl: "https://api.vendor.test",
        allowedHosts: ["api.vendor.test"],
        openapiSpecJson: inlineOpenApiSpec(),
      },
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      connection: { slug: string; kind: string; operationCount: number };
    };
    expect(body.connection.slug).toBe("vendor");
    expect(body.connection.kind).toBe("openapi");
    expect(body.connection.operationCount).toBe(1);
  });

  test("POST upsert is forbidden for non-lead agent principal", async () => {
    const res = await dispatch("/api/script-connections", {
      method: "POST",
      agentId: workerAgentId,
      body: {
        kind: "openapi",
        slug: "blockedVendor",
        baseUrl: "https://api.vendor.test",
        allowedHosts: ["api.vendor.test"],
        openapiSpecJson: inlineOpenApiSpec(),
      },
    });

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "Only the lead can manage script connections." });
  });

  test("list returns connections without secrets", async () => {
    upsertSwarmConfig({
      scope: "global",
      key: "VENDOR_TOKEN",
      value: SECRET_VALUE,
      isSecret: true,
    });
    const binding = upsertCredentialBinding({
      configKey: "VENDOR_TOKEN",
      allowedHosts: ["api.vendor.test"],
      headerTemplate: "Authorization: Bearer [REDACTED:VENDOR_TOKEN]",
    });

    await dispatch("/api/script-connections", {
      method: "POST",
      agentId: leadAgentId,
      body: {
        kind: "openapi",
        slug: "vendor",
        baseUrl: "https://api.vendor.test",
        allowedHosts: ["api.vendor.test"],
        credentialBindingId: binding.id,
        openapiSpecJson: inlineOpenApiSpec(),
      },
    });

    const res = await dispatch("/api/script-connections");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      connections: Array<{
        credentialBinding: { configKey: string } | null;
        openapiSpecJson?: string;
        generatedRuntimeJson?: string;
        generatedTypes?: string;
      }>;
    };
    expect(body.connections).toHaveLength(1);
    expect(body.connections[0]?.credentialBinding?.configKey).toBe("VENDOR_TOKEN");
    expect(body.connections[0]?.openapiSpecJson).toBeUndefined();
    expect(body.connections[0]?.generatedRuntimeJson).toBeUndefined();
    expect(body.connections[0]?.generatedTypes).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain(SECRET_VALUE);
    expect(JSON.stringify(body)).not.toContain("[REDACTED:VENDOR_TOKEN]");
  });

  test("oauth-apps GET never includes clientSecret", async () => {
    upsertOAuthApp("vendor_oauth", {
      clientId: "vendor-client",
      clientSecret: "oauth-client-secret-should-not-leak",
      authorizeUrl: "https://oauth.vendor.test/authorize",
      tokenUrl: "https://oauth.vendor.test/token",
      redirectUri: "https://api.public.test/api/oauth/vendor_oauth/callback",
      scopes: "read,write",
      metadata: JSON.stringify({
        extraParams: { audience: "vendor" },
        tokenAuthStyle: "basic",
        tokenBodyFormat: "json",
      }),
    });

    const res = await dispatch("/api/oauth-apps");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { oauthApps: Array<Record<string, unknown>> };
    expect(body.oauthApps).toHaveLength(1);
    expect(body.oauthApps[0]?.provider).toBe("vendor_oauth");
    expect(body.oauthApps[0]?.clientId).toBe("vendor-client");
    expect(body.oauthApps[0]).not.toHaveProperty("clientSecret");
    expect(body.oauthApps[0]?.lastRefreshedAt).toBeNull();
    expect(JSON.stringify(body)).not.toContain("oauth-client-secret-should-not-leak");
  });

  test("oauth-apps GET includes lastRefreshedAt when tokens are stored", async () => {
    upsertOAuthApp("vendor_oauth", {
      clientId: "vendor-client",
      clientSecret: "oauth-client-secret-should-not-leak",
      authorizeUrl: "https://oauth.vendor.test/authorize",
      tokenUrl: "https://oauth.vendor.test/token",
      redirectUri: "https://api.public.test/api/oauth/vendor_oauth/callback",
      scopes: "read,write",
    });
    storeOAuthTokens("vendor_oauth", {
      accessToken: "access-token-should-not-leak",
      refreshToken: "refresh-token-should-not-leak",
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      scope: "read,write",
    });

    const res = await dispatch("/api/oauth-apps");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { oauthApps: Array<Record<string, unknown>> };
    expect(body.oauthApps).toHaveLength(1);
    expect(typeof body.oauthApps[0]?.lastRefreshedAt).toBe("string");
    expect(body.oauthApps[0]?.lastRefreshedAt).toBe(getOAuthTokens("vendor_oauth")?.updatedAt);
    expect(res.text).not.toContain("access-token-should-not-leak");
    expect(res.text).not.toContain("refresh-token-should-not-leak");
  });

  test("detail returns operations and generated types without secrets", async () => {
    upsertSwarmConfig({
      scope: "global",
      key: "VENDOR_TOKEN",
      value: SECRET_VALUE,
      isSecret: true,
    });
    const binding = upsertCredentialBinding({
      configKey: "VENDOR_TOKEN",
      allowedHosts: ["api.vendor.test"],
      headerTemplate: "Authorization: Bearer [REDACTED:VENDOR_TOKEN]",
    });

    const create = await dispatch("/api/script-connections", {
      method: "POST",
      agentId: leadAgentId,
      body: {
        kind: "openapi",
        slug: "vendor",
        baseUrl: "https://api.vendor.test",
        allowedHosts: ["api.vendor.test"],
        credentialBindingId: binding.id,
        openapiSpecJson: inlineOpenApiSpec(),
      },
    });
    expect(create.status).toBe(200);
    const created = (await create.json()) as { connection: { id: string } };

    const res = await dispatch(`/api/script-connections/${created.connection.id}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      connection: {
        operations: Array<{ name: string; method: string; path: string }>;
        generatedTypes: string;
        specSummary?: { title?: string; version?: string; pathCount: number };
        openapiSpecJson?: string;
        generatedRuntimeJson?: string;
      };
    };
    expect(body.connection.operations).toEqual([
      { name: "listItems", method: "GET", path: "/items" },
    ]);
    expect(body.connection.generatedTypes).toContain("listItems");
    expect(body.connection.specSummary).toEqual({
      title: "Vendor",
      version: "1.0.0",
      pathCount: 1,
    });
    expect(body.connection.openapiSpecJson).toBeUndefined();
    expect(body.connection.generatedRuntimeJson).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain(SECRET_VALUE);
    expect(JSON.stringify(body)).not.toContain("[REDACTED:VENDOR_TOKEN]");
  });

  test("DELETE oauth app removes app and tokens", async () => {
    upsertOAuthApp("vendor_oauth", {
      clientId: "vendor-client",
      clientSecret: "oauth-client-secret",
      authorizeUrl: "https://oauth.vendor.test/authorize",
      tokenUrl: "https://oauth.vendor.test/token",
      redirectUri: "https://api.public.test/api/oauth/vendor_oauth/callback",
      scopes: "read,write",
    });
    storeOAuthTokens("vendor_oauth", {
      accessToken: "access-token",
      refreshToken: "refresh-token",
      expiresAt: "2035-01-01T00:00:00.000Z",
      scope: "read write",
    });

    const res = await dispatch("/api/oauth-apps/vendor_oauth", {
      method: "DELETE",
      agentId: leadAgentId,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });
    expect(getOAuthApp("vendor_oauth")).toBeNull();
    expect(getOAuthTokens("vendor_oauth")).toBeNull();
  });

  test("oauth app upsert without clientSecret keeps existing secret", async () => {
    upsertOAuthApp("vendor_oauth", {
      clientId: "vendor-client",
      clientSecret: "existing-client-secret",
      authorizeUrl: "https://oauth.vendor.test/authorize",
      tokenUrl: "https://oauth.vendor.test/token",
      redirectUri: "https://api.public.test/api/oauth/vendor_oauth/callback",
      scopes: "read",
    });

    const res = await dispatch("/api/oauth-apps", {
      method: "POST",
      agentId: leadAgentId,
      body: {
        provider: "vendor_oauth",
        clientId: "updated-client",
        authorizeUrl: "https://oauth.vendor.test/oauth2/authorize",
        tokenUrl: "https://oauth.vendor.test/oauth2/token",
        scopes: [],
      },
    });
    expect(res.status).toBe(200);
    const app = getOAuthApp("vendor_oauth");
    expect(app?.clientId).toBe("updated-client");
    expect(app?.clientSecret).toBe("existing-client-secret");
    expect(app?.scopes).toBe("");
    expect(JSON.stringify(await res.json())).not.toContain("existing-client-secret");
  });

  test("discover endpoint parses mocked well-known OAuth JSON", async () => {
    const requested: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      requested.push(url);
      if (url === "https://issuer.vendor.test/.well-known/oauth-authorization-server") {
        return new Response(
          JSON.stringify({
            authorization_endpoint: "https://issuer.vendor.test/oauth/authorize",
            token_endpoint: "https://issuer.vendor.test/oauth/token",
            scopes_supported: ["read", "write"],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    const res = await dispatch("/api/oauth-apps/discover", {
      method: "POST",
      agentId: leadAgentId,
      body: { url: "https://issuer.vendor.test" },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      authorizeUrl: "https://issuer.vendor.test/oauth/authorize",
      tokenUrl: "https://issuer.vendor.test/oauth/token",
      scopes: ["read", "write"],
      sourceUrl: "https://issuer.vendor.test/.well-known/oauth-authorization-server",
    });
    expect(requested).toEqual([
      "https://issuer.vendor.test/.well-known/oauth-authorization-server",
    ]);
  });

  test("integrations catalog proxy filters cli entries", async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      expect(String(input)).toBe("https://integrations.sh/api.json");
      return new Response(
        JSON.stringify([
          {
            id: "stripe",
            kind: "openapi",
            slug: "stripe",
            name: "Stripe",
            description: "Payments API",
            url: "https://stripe.com",
            icon: "https://stripe.com/icon.png",
            domain: "stripe.com",
            categories: ["payments"],
          },
          {
            id: "stripe-cli",
            kind: "cli",
            slug: "stripeCli",
            name: "Stripe CLI",
          },
        ]),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;

    const res = await dispatch("/api/integrations-catalog");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      entries: Array<{ id: string; kind: string; slug: string; name: string }>;
    };
    expect(body.entries).toEqual([
      {
        id: "stripe",
        kind: "openapi",
        slug: "stripe",
        name: "Stripe",
        description: "Payments API",
        url: "https://stripe.com",
        icon: "https://stripe.com/icon.png",
        domain: "stripe.com",
        categories: ["payments"],
        feeds: [],
      },
    ]);
  });
});

describe("DELETE /api/oauth-apps/{provider}/tokens", () => {
  const ACCESS_TOKEN = "access-token-should-not-leak";
  const realFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  function seedOAuthApp(metadata?: Record<string, unknown>) {
    upsertOAuthApp("vendor_oauth", {
      clientId: "vendor-client",
      clientSecret: "oauth-client-secret-should-not-leak",
      authorizeUrl: "https://oauth.vendor.test/authorize",
      tokenUrl: "https://oauth.vendor.test/token",
      redirectUri: "https://api.public.test/api/oauth/vendor_oauth/callback",
      scopes: "read,write",
      ...(metadata ? { metadata: JSON.stringify(metadata) } : {}),
    });
  }

  function seedTokens() {
    storeOAuthTokens("vendor_oauth", {
      accessToken: ACCESS_TOKEN,
      refreshToken: "refresh-token-should-not-leak",
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      scope: "read,write",
    });
  }

  test("404 for unknown provider", async () => {
    const res = await dispatch("/api/oauth-apps/unknown_provider/tokens", {
      method: "DELETE",
      agentId: leadAgentId,
    });
    expect(res.status).toBe(404);
  });

  test("returns disconnected:false when no stored tokens", async () => {
    seedOAuthApp();
    const res = await dispatch("/api/oauth-apps/vendor_oauth/tokens", {
      method: "DELETE",
      agentId: leadAgentId,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ disconnected: false, message: "no stored tokens" });
  });

  test("deletes the oauth_tokens row and returns disconnected:true", async () => {
    seedOAuthApp();
    seedTokens();
    const res = await dispatch("/api/oauth-apps/vendor_oauth/tokens", {
      method: "DELETE",
      agentId: leadAgentId,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ disconnected: true, revocationAttempted: false });
    expect(getOAuthTokens("vendor_oauth")).toBeNull();
    expect(res.text).not.toContain(ACCESS_TOKEN);
  });

  test("attempts remote revocation when metadata.revocationUrl is set", async () => {
    seedOAuthApp({ revocationUrl: "https://oauth.vendor.test/revoke" });
    seedTokens();

    let captured: { url: string; method?: string; body?: string } | null = null;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      captured = {
        url: String(input),
        method: init?.method,
        body: typeof init?.body === "string" ? init.body : undefined,
      };
      return new Response("", { status: 200 });
    }) as typeof fetch;

    const res = await dispatch("/api/oauth-apps/vendor_oauth/tokens", {
      method: "DELETE",
      agentId: leadAgentId,
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ disconnected: true, revocationAttempted: true });
    expect(getOAuthTokens("vendor_oauth")).toBeNull();

    expect(captured).not.toBeNull();
    expect(captured?.url).toBe("https://oauth.vendor.test/revoke");
    expect(captured?.method).toBe("POST");
    expect(captured?.body).toContain("token_type_hint=access_token");
    expect(captured?.body).toContain(`token=${ACCESS_TOKEN}`);
    // Tokens and secrets must never leak into the HTTP response.
    expect(res.text).not.toContain(ACCESS_TOKEN);
    expect(res.text).not.toContain("oauth-client-secret-should-not-leak");
  });
});

describe("POST /api/oauth-apps/{provider}/refresh", () => {
  const ACCESS_TOKEN = "access-token-should-not-leak";
  const REFRESH_TOKEN = "refresh-token-should-not-leak";
  const realFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  function seedOAuthApp() {
    upsertOAuthApp("vendor_oauth", {
      clientId: "vendor-client",
      clientSecret: "oauth-client-secret-should-not-leak",
      authorizeUrl: "https://oauth.vendor.test/authorize",
      tokenUrl: "https://oauth.vendor.test/token",
      redirectUri: "https://api.public.test/api/oauth/vendor_oauth/callback",
      scopes: "read,write",
    });
  }

  function seedTokens(refreshToken: string | null) {
    storeOAuthTokens("vendor_oauth", {
      accessToken: ACCESS_TOKEN,
      refreshToken,
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      scope: "read,write",
    });
  }

  test("404 for unknown provider", async () => {
    const res = await dispatch("/api/oauth-apps/unknown_provider/refresh", {
      method: "POST",
      agentId: leadAgentId,
    });
    expect(res.status).toBe(404);
  });

  test("400 when no tokens are stored", async () => {
    seedOAuthApp();
    const res = await dispatch("/api/oauth-apps/vendor_oauth/refresh", {
      method: "POST",
      agentId: leadAgentId,
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Nothing to refresh — authorize first." });
  });

  test("400 when no refresh token is stored", async () => {
    seedOAuthApp();
    seedTokens(null);
    const res = await dispatch("/api/oauth-apps/vendor_oauth/refresh", {
      method: "POST",
      agentId: leadAgentId,
    });
    expect(res.status).toBe(400);
    expect(res.text).toContain("does not support refresh");
  });

  test("forces a refresh regardless of expiry and never leaks token values", async () => {
    seedOAuthApp();
    seedTokens(REFRESH_TOKEN); // token still valid for an hour — refresh is forced anyway

    let captured: { url: string; body?: string } | null = null;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      captured = {
        url: String(input),
        body: typeof init?.body === "string" ? init.body : undefined,
      };
      return new Response(
        JSON.stringify({
          access_token: "new-access-token-should-not-leak",
          token_type: "bearer",
          expires_in: 7200,
          refresh_token: "new-refresh-token-should-not-leak",
          scope: "read,write",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;

    const res = await dispatch("/api/oauth-apps/vendor_oauth/refresh", {
      method: "POST",
      agentId: leadAgentId,
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      refreshed: boolean;
      tokenStatus: string;
      expiresAt: string | null;
    };
    expect(body.refreshed).toBe(true);
    expect(body.tokenStatus).toBe("ok");

    // The token endpoint was hit with a refresh_token grant.
    expect(captured).not.toBeNull();
    expect(captured?.url).toBe("https://oauth.vendor.test/token");
    expect(captured?.body).toContain("grant_type=refresh_token");

    // Response carries the NEW expiry from the mocked expires_in=7200.
    const stored = getOAuthTokens("vendor_oauth");
    expect(stored?.accessToken).toBe("new-access-token-should-not-leak");
    expect(body.expiresAt).toBe(stored?.expiresAt ?? "");
    expect(new Date(body.expiresAt ?? 0).getTime()).toBeGreaterThan(Date.now() + 3_600_000);

    // No token values in the HTTP response.
    expect(res.text).not.toContain(ACCESS_TOKEN);
    expect(res.text).not.toContain(REFRESH_TOKEN);
    expect(res.text).not.toContain("new-access-token-should-not-leak");
    expect(res.text).not.toContain("new-refresh-token-should-not-leak");
    expect(res.text).not.toContain("oauth-client-secret-should-not-leak");
  });

  test("502 when the provider token endpoint rejects the refresh", async () => {
    seedOAuthApp();
    seedTokens(REFRESH_TOKEN);
    globalThis.fetch = (async () =>
      new Response("nope", { status: 400 })) as unknown as typeof fetch;

    const res = await dispatch("/api/oauth-apps/vendor_oauth/refresh", {
      method: "POST",
      agentId: leadAgentId,
    });
    expect(res.status).toBe(502);
    expect(res.text).toContain("Token refresh failed");
  });

  test("403 for non-lead agent", async () => {
    seedOAuthApp();
    seedTokens(REFRESH_TOKEN);
    const res = await dispatch("/api/oauth-apps/vendor_oauth/refresh", {
      method: "POST",
      agentId: workerAgentId,
    });
    expect(res.status).toBe(403);
  });
});
