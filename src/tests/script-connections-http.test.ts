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
import {
  getScriptConnectionById,
  setOpenapiSpecFetchForTesting,
  setScriptConnectionEnabled,
  upsertCredentialBinding,
  upsertScriptConnection,
} from "../be/script-connections";
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
  setOpenapiSpecFetchForTesting(null);
  closeDb();
  await removeDbFiles(TEST_DB_PATH);
});

beforeEach(() => {
  globalThis.fetch = originalFetch;
  setOpenapiSpecFetchForTesting(null);
  getDb().run("DELETE FROM script_connections");
  getDb().run("DELETE FROM script_credential_bindings");
  getDb().run("DELETE FROM oauth_authorizations");
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

  test("POST upsert with configKey and queryTemplate creates a query-only binding", async () => {
    const res = await dispatch("/api/script-connections", {
      method: "POST",
      agentId: leadAgentId,
      body: {
        kind: "openapi",
        slug: "queryAuthVendor",
        baseUrl: "https://api.vendor.test",
        allowedHosts: ["api.vendor.test"],
        configKey: "QUERY_AUTH_VENDOR_KEY",
        queryTemplate: "api_key=[REDACTED:QUERY_AUTH_VENDOR_KEY]",
        openapiSpecJson: inlineOpenApiSpec(),
      },
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { connection: { id: string } };
    const bindingRow = getDb()
      .prepare<{ header_template: string | null; query_template: string | null }, [string]>(
        `SELECT b.header_template, b.query_template
         FROM script_credential_bindings b
         JOIN script_connections c ON c.credential_binding_id = b.id
         WHERE c.id = ?`,
      )
      .get(body.connection.id);

    expect(bindingRow?.header_template).toBeNull();
    expect(bindingRow?.query_template).toBe("api_key=[REDACTED:QUERY_AUTH_VENDOR_KEY]");
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

  test("unfiltered dashboard list includes agent-scoped connections", async () => {
    const connection = await upsertScriptConnection({
      slug: "agentScopedVisible",
      kind: "openapi",
      scope: "agent",
      scopeId: workerAgentId,
      baseUrl: "https://api.vendor.test",
      openapiSpecJson: inlineOpenApiSpec(),
    });

    const res = await dispatch("/api/script-connections");

    expect(res.status).toBe(200);
    const body = (await res.json()) as { connections: Array<{ id: string; scope: string }> };
    expect(body.connections).toContainEqual(
      expect.objectContaining({ id: connection.id, scope: "agent" }),
    );
  });

  test("id update preserves omitted scope and disabled state", async () => {
    const connection = await upsertScriptConnection({
      slug: "agentScopedDisabled",
      displayName: "Original",
      kind: "openapi",
      scope: "agent",
      scopeId: workerAgentId,
      baseUrl: "https://api.vendor.test",
      openapiSpecJson: inlineOpenApiSpec(),
      enabled: false,
    });
    setScriptConnectionEnabled(connection.id, false);

    const res = await dispatch("/api/script-connections", {
      method: "POST",
      agentId: leadAgentId,
      body: {
        id: connection.id,
        kind: "openapi",
        slug: connection.slug,
        displayName: "Renamed",
        baseUrl: "https://api.vendor.test",
        allowedHosts: ["api.vendor.test"],
        openapiSpecJson: inlineOpenApiSpec(),
      },
    });

    expect(res.status).toBe(200);
    const stored = getScriptConnectionById(connection.id);
    expect(stored?.displayName).toBe("Renamed");
    expect(stored?.scope).toBe("agent");
    expect(stored?.scopeId).toBe(workerAgentId);
    expect(stored?.enabled).toBe(false);
  });

  test("repo-scoped connection upsert accepts owner/name scope IDs", async () => {
    const res = await dispatch("/api/script-connections", {
      method: "POST",
      agentId: leadAgentId,
      body: {
        kind: "openapi",
        slug: "repoScopedVendor",
        baseUrl: "https://api.vendor.test",
        allowedHosts: ["api.vendor.test"],
        scope: "repo",
        scopeId: "desplega-ai/agent-swarm",
        openapiSpecJson: inlineOpenApiSpec(),
      },
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      connection: { scope: string; scopeId: string | null };
    };
    expect(body.connection.scope).toBe("repo");
    expect(body.connection.scopeId).toBe("desplega-ai/agent-swarm");
  });

  test("id update with a changed OpenAPI spec URL fetches the new URL", async () => {
    const firstUrl = "https://spec.vendor.test/one.json";
    const secondUrl = "https://spec.vendor.test/two.json";
    const requests: string[] = [];
    setOpenapiSpecFetchForTesting((async (input) => {
      const url = input instanceof Request ? input.url : String(input);
      requests.push(url);
      return new Response(inlineOpenApiSpec(), {
        status: 200,
        headers: { etag: url === firstUrl ? '"one"' : '"two"' },
      });
    }) as typeof fetch);

    const created = await dispatch("/api/script-connections", {
      method: "POST",
      agentId: leadAgentId,
      body: {
        kind: "openapi",
        slug: "urlEditVendor",
        baseUrl: "https://api.vendor.test",
        allowedHosts: ["api.vendor.test"],
        openapiSpecUrl: firstUrl,
      },
    });
    expect(created.status).toBe(200);
    const createdBody = (await created.json()) as { connection: { id: string; slug: string } };

    const updated = await dispatch("/api/script-connections", {
      method: "POST",
      agentId: leadAgentId,
      body: {
        id: createdBody.connection.id,
        kind: "openapi",
        slug: createdBody.connection.slug,
        displayName: "URL changed",
        baseUrl: "https://api.vendor.test",
        allowedHosts: ["api.vendor.test"],
        openapiSpecUrl: secondUrl,
      },
    });

    expect(updated.status).toBe(200);
    expect(requests).toEqual([firstUrl, secondUrl]);
    const stored = getScriptConnectionById(createdBody.connection.id);
    expect(stored?.openapiSpecSource).toBe(secondUrl);
    expect(stored?.openapiSpecEtag).toBe('"two"');
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
      {
        name: "listItems",
        method: "GET",
        path: "/items",
        parameters: [],
        hasBody: false,
        successStatus: "200",
        responseSchema: {
          type: "object",
          properties: { ok: { type: "boolean" } },
        },
      },
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

  test("oauth app upsert rejects reserved tracker providers", async () => {
    const res = await dispatch("/api/oauth-apps", {
      method: "POST",
      agentId: leadAgentId,
      body: {
        provider: "linear",
        clientId: "linear-client",
        clientSecret: "linear-secret",
        authorizeUrl: "https://oauth.vendor.test/authorize",
        tokenUrl: "https://oauth.vendor.test/token",
        scopes: [],
      },
    });

    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain("dedicated tracker");
    expect(getOAuthApp("linear")).toBeNull();
  });

  test("oauth app upsert rejects unsafe endpoint URLs in production and accepts public HTTPS", async () => {
    const previousNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      const rejected = await dispatch("/api/oauth-apps", {
        method: "POST",
        agentId: leadAgentId,
        body: {
          provider: "unsafe_vendor",
          clientId: "unsafe-client",
          clientSecret: "unsafe-secret",
          authorizeUrl: "https://oauth.vendor.test/authorize",
          tokenUrl: "http://127.0.0.1/token",
          scopes: [],
        },
      });
      expect(rejected.status).toBe(400);
      expect(((await rejected.json()) as { error: string }).error).toMatch(/private IPv4|insecure/);
      expect(getOAuthApp("unsafe_vendor")).toBeNull();

      const accepted = await dispatch("/api/oauth-apps", {
        method: "POST",
        agentId: leadAgentId,
        body: {
          provider: "safe_vendor",
          clientId: "safe-client",
          clientSecret: "safe-secret",
          authorizeUrl: "https://oauth.vendor.test/authorize",
          tokenUrl: "https://oauth.vendor.test/token",
          scopes: [],
        },
      });
      expect(accepted.status).toBe(200);
      expect(getOAuthApp("safe_vendor")?.clientId).toBe("safe-client");
    } finally {
      if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previousNodeEnv;
    }
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

  test("discover endpoint rejects redirects to unsafe hosts in production", async () => {
    const previousNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    const requested: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      requested.push(url);
      return new Response(null, {
        status: 302,
        headers: { location: "http://127.0.0.1/.well-known/oauth-authorization-server" },
      });
    }) as typeof fetch;

    try {
      const res = await dispatch("/api/oauth-apps/discover", {
        method: "POST",
        agentId: leadAgentId,
        body: { url: "https://issuer.vendor.test" },
      });

      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toMatch(/private IPv4|insecure/);
      expect(requested).toEqual([
        "https://issuer.vendor.test/.well-known/oauth-authorization-server",
      ]);
    } finally {
      if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previousNodeEnv;
    }
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

  // Contract: the surface proxy passes through a TRIMMED shape only —
  // {domain, summary, surfaces: [{type, name, url, docs, spec, auth: {required,
  // credentialIds, mechanics}}], credentials: {id: {type, label, generateUrl,
  // setup}}}. CLI surfaces are filtered out (connections are http/mcp only)
  // and credentials are narrowed to ids referenced by retained surfaces.
  test("integrations surface proxy trims payload and filters cli surfaces", async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      expect(String(input)).toBe("https://integrations.sh/api/stripe.com/surface");
      return new Response(
        JSON.stringify({
          version: 3,
          domain: "stripe.com",
          detect: { probed: ["llms.txt"] },
          summary: "Stripe exposes a REST HTTP API and an MCP server.",
          discoveredAt: "2026-07-08T00:00:00.000Z",
          usedLlm: true,
          surfaces: [
            {
              type: "http",
              name: "Stripe API",
              slug: "stripe-api",
              url: "https://api.stripe.com",
              docs: "https://docs.stripe.com/api",
              spec: "https://raw.githubusercontent.com/stripe/openapi/master/openapi/spec3.yaml",
              basis: { via: "discovered", evidence: ["https://docs.stripe.com/api.md"] },
              auth: {
                status: "required",
                entries: [
                  {
                    use: [
                      {
                        id: "stripe_api_key",
                        mechanics: {
                          source: "http",
                          in: "header",
                          headerName: "Authorization",
                          scheme: "Bearer",
                        },
                      },
                    ],
                    basis: { via: "discovered" },
                  },
                ],
              },
            },
            {
              type: "mcp",
              name: "Stripe MCP server",
              slug: "stripe-mcp-server",
              url: "https://mcp.stripe.com",
              docs: "https://docs.stripe.com/mcp",
              auth: {
                status: "required",
                entries: [
                  { use: [{ id: "stripe_mcp_oauth", mechanics: { source: "well-known" } }] },
                ],
              },
            },
            {
              type: "cli",
              name: "Stripe CLI",
              docs: "https://docs.stripe.com/stripe-cli",
              auth: {
                status: "required",
                entries: [
                  {
                    use: [
                      {
                        id: "stripe_cli_session",
                        mechanics: { source: "cli", command: "stripe login" },
                      },
                    ],
                  },
                ],
              },
            },
          ],
          credentials: {
            stripe_api_key: {
              type: "api_key",
              label: "Stripe API key",
              generateUrl: "https://dashboard.stripe.com/test/apikeys",
              setup: "Create or reveal a key in the API keys page.",
              acquisition: "manual",
            },
            stripe_mcp_oauth: {
              type: "oauth2",
              label: "Stripe MCP OAuth authorization",
              setup: "Use an MCP client that supports OAuth.",
              acquisition: "manual",
            },
            stripe_cli_session: {
              type: "compound",
              label: "Stripe CLI session",
              setup: "Install the CLI, then run stripe login.",
            },
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;

    const res = await dispatch("/api/integrations-catalog/stripe.com/surface");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      domain: "stripe.com",
      summary: "Stripe exposes a REST HTTP API and an MCP server.",
      surfaces: [
        {
          type: "http",
          name: "Stripe API",
          url: "https://api.stripe.com",
          docs: "https://docs.stripe.com/api",
          spec: "https://raw.githubusercontent.com/stripe/openapi/master/openapi/spec3.yaml",
          auth: {
            required: true,
            credentialIds: ["stripe_api_key"],
            mechanics: { in: "header", headerName: "Authorization", scheme: "Bearer" },
          },
        },
        {
          type: "mcp",
          name: "Stripe MCP server",
          url: "https://mcp.stripe.com",
          docs: "https://docs.stripe.com/mcp",
          spec: null,
          auth: { required: true, credentialIds: ["stripe_mcp_oauth"], mechanics: null },
        },
      ],
      credentials: {
        stripe_api_key: {
          type: "api_key",
          label: "Stripe API key",
          generateUrl: "https://dashboard.stripe.com/test/apikeys",
          setup: "Create or reveal a key in the API keys page.",
        },
        stripe_mcp_oauth: {
          type: "oauth2",
          label: "Stripe MCP OAuth authorization",
          generateUrl: null,
          setup: "Use an MCP client that supports OAuth.",
        },
      },
    });
  });

  test("integrations surface proxy caches by domain", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return new Response(
        JSON.stringify({ domain: "cached.example", summary: "hi", surfaces: [], credentials: {} }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;

    expect((await dispatch("/api/integrations-catalog/cached.example/surface")).status).toBe(200);
    expect((await dispatch("/api/integrations-catalog/CACHED.example/surface")).status).toBe(200);
    expect(calls).toBe(1);
  });

  test("integrations surface proxy passes through upstream 404", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: "surface not found" }), {
        status: 404,
      })) as unknown as typeof fetch;

    const res = await dispatch("/api/integrations-catalog/unknown-404.example/surface");
    expect(res.status).toBe(404);
    expect(res.text).toContain("No integration surface found");
  });

  test("integrations surface proxy maps other upstream failures to 502", async () => {
    globalThis.fetch = (async () =>
      new Response("boom", { status: 500 })) as unknown as typeof fetch;

    const res = await dispatch("/api/integrations-catalog/broken-500.example/surface");
    expect(res.status).toBe(502);
    expect(res.text).toContain("Failed to fetch integration surface");
  });

  test("integrations surface proxy rejects invalid domains", async () => {
    let called = false;
    globalThis.fetch = (async () => {
      called = true;
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;

    const res = await dispatch("/api/integrations-catalog/bad_domain/surface");
    expect(res.status).toBe(400);
    expect(called).toBe(false);
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
