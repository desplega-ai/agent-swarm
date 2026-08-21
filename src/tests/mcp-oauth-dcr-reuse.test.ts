import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { closeDb, createMcpServer, getDbClient, initDb } from "../be/db";
import { findReusableMcpOAuthClient, getMcpOAuthToken } from "../be/db-queries/mcp-oauth";
import { handleCore } from "../http/core";
import { handleMcpOAuth } from "../http/mcp-oauth";
import { getPathSegments, parseQueryParams } from "../http/utils";

// Regression coverage for the "GET /api/mcp-oauth/:id/authorize runs a NEW
// DCR registration on every call" defect. Uses the same dispatch() harness
// as mcp-oauth-manual-client.test.ts.

const API_KEY = "test-secret-key";
const TEST_DB_PATH = "./test-mcp-oauth-dcr-reuse.sqlite";

async function removeDbFiles(): Promise<void> {
  for (const suffix of ["", "-wal", "-shm"]) {
    await unlink(`${TEST_DB_PATH}${suffix}`).catch(() => {});
  }
}

type TestResponse = {
  status: number;
  text: string;
  headers: Record<string, string>;
  json: () => Promise<unknown>;
};

async function dispatch(path: string, init: RequestInit = {}): Promise<TestResponse> {
  const headers: Record<string, string> = {
    ...((init.headers as Record<string, string>) ?? {}),
  };
  if (init.body !== undefined && !headers["Content-Type"])
    headers["Content-Type"] = "application/json";

  const req = Readable.from(init.body ? [Buffer.from(String(init.body))] : []) as IncomingMessage;
  req.method = init.method ?? "GET";
  req.url = path;
  req.headers = Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]),
  );

  let status = 200;
  let text = "";
  const responseHeaders: Record<string, string> = {};
  const res = {
    headersSent: false,
    writableEnded: false,
    setHeader(name: string, value: number | string | readonly string[]) {
      responseHeaders[name.toLowerCase()] = Array.isArray(value) ? value.join(", ") : String(value);
      return this;
    },
    writeHead(code: number, headersArg?: Record<string, number | string | readonly string[]>) {
      status = code;
      if (headersArg) {
        for (const [key, value] of Object.entries(headersArg)) {
          responseHeaders[key.toLowerCase()] = Array.isArray(value)
            ? value.join(", ")
            : String(value);
        }
      }
      this.headersSent = true;
      return this;
    },
    end(chunk?: unknown) {
      if (chunk !== undefined) text += String(chunk);
      this.writableEnded = true;
      return this;
    },
  } as unknown as ServerResponse;

  const handledCore = await handleCore(req, res, undefined, API_KEY);
  if (!handledCore) {
    const pathSegments = getPathSegments(req.url || "");
    const queryParams = parseQueryParams(req.url || "");
    const handled = await handleMcpOAuth(req, res, pathSegments, queryParams);
    if (!handled) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Not found" }));
    }
  }

  return {
    status,
    text,
    headers: responseHeaders,
    json: async () => JSON.parse(text),
  };
}

describe("MCP OAuth DCR client reuse", () => {
  let originalFetch: typeof fetch;
  let dcrCallCount = 0;
  let issuerHost = "as-1.example.test";
  let registrationPath = "/register-1";
  let tokenShouldFail: "" | "invalid_client" = "";
  let capturedTokenBody = "";
  let capturedTokenHeaders: Record<string, string> = {};
  let asScopesSupported: string[] = [];

  const MCP_URL = "https://mcp.example.test/mcp";

  beforeEach(async () => {
    originalFetch = globalThis.fetch;
    dcrCallCount = 0;
    issuerHost = "as-1.example.test";
    registrationPath = "/register-1";
    tokenShouldFail = "";
    asScopesSupported = [];
    process.env.SECRETS_ENCRYPTION_KEY = Buffer.alloc(32, 11).toString("base64");
    process.env.MCP_OAUTH_ALLOW_PRIVATE_HOSTS = "false";
    process.env.PUBLIC_MCP_BASE_URL = "https://swarm.example.test";
    process.env.APP_URL = "https://dashboard.example.test";

    await removeDbFiles();
    initDb(TEST_DB_PATH);

    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const href = input.toString();

      if (href === `${MCP_URL}/.well-known/oauth-protected-resource`) {
        // Not present on the resource itself for this fixture — force the
        // WWW-Authenticate probe path is skipped by just 404ing, and instead
        // answer PRMD directly under the resource base.
        return new Response("not found", { status: 404 });
      }
      if (href === "https://mcp.example.test/.well-known/oauth-protected-resource") {
        return Response.json({
          resource: MCP_URL,
          authorization_servers: [`https://${issuerHost}`],
        });
      }
      if (href === `https://${issuerHost}/.well-known/oauth-authorization-server`) {
        return Response.json({
          issuer: `https://${issuerHost}`,
          authorization_endpoint: `https://${issuerHost}/authorize`,
          token_endpoint: `https://${issuerHost}/token`,
          registration_endpoint: `https://${issuerHost}${registrationPath}`,
          scopes_supported: asScopesSupported,
        });
      }
      if (href === `https://${issuerHost}${registrationPath}` && init?.method === "POST") {
        dcrCallCount += 1;
        return Response.json(
          {
            client_id: `client-${issuerHost}-${dcrCallCount}`,
            client_secret: `secret-${issuerHost}-${dcrCallCount}`,
          },
          { status: 201 },
        );
      }
      if (href === `https://${issuerHost}/token` && init?.method === "POST") {
        capturedTokenBody = (init?.body as string) ?? "";
        capturedTokenHeaders = (init?.headers as Record<string, string>) ?? {};
        if (tokenShouldFail === "invalid_client") {
          return Response.json(
            { error: "invalid_client", error_description: "client no longer recognized" },
            { status: 401 },
          );
        }
        return Response.json({
          access_token: "mock-access-token",
          token_type: "Bearer",
          expires_in: 3600,
          refresh_token: "mock-refresh-token",
          scope: "read",
        });
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    closeDb();
    await removeDbFiles();
    delete process.env.MCP_OAUTH_ALLOW_PRIVATE_HOSTS;
    delete process.env.PUBLIC_MCP_BASE_URL;
    delete process.env.APP_URL;
  });

  async function authorizeUrl(mcpServerId: string, scopes?: string) {
    const qs = scopes ? `?scopes=${encodeURIComponent(scopes)}` : "";
    const res = await dispatch(`/api/mcp-oauth/${mcpServerId}/authorize-url${qs}`, {
      headers: { Authorization: `Bearer ${API_KEY}` },
    });
    expect(res.status).toBe(200);
    const { providerUrl } = (await res.json()) as { providerUrl: string };
    return new URL(providerUrl);
  }

  test("two authorize calls before any callback completes reuse one DCR client_id", async () => {
    const server = await createMcpServer({
      name: "reuse-basic",
      transport: "http",
      url: MCP_URL,
      scope: "swarm",
    });

    const first = await authorizeUrl(server.id);
    const second = await authorizeUrl(server.id);

    expect(dcrCallCount).toBe(1);
    expect(first.searchParams.get("client_id")).toBe(second.searchParams.get("client_id"));
    expect(first.searchParams.get("client_id")).toBe("client-as-1.example.test-1");
  });

  test("a changed issuer/registration endpoint forces re-registration", async () => {
    const server = await createMcpServer({
      name: "reuse-issuer-change",
      transport: "http",
      url: MCP_URL,
      scope: "swarm",
    });

    const first = await authorizeUrl(server.id);
    expect(dcrCallCount).toBe(1);

    // Provider migrated to a new AS entirely.
    issuerHost = "as-2.example.test";
    registrationPath = "/register-2";

    const second = await authorizeUrl(server.id);
    expect(dcrCallCount).toBe(2);
    expect(first.searchParams.get("client_id")).not.toBe(second.searchParams.get("client_id"));
    expect(second.searchParams.get("client_id")).toMatch(/^client-as-2\.example\.test-/);
  });

  test("an invalidated stored client re-registers exactly once on the next authorize call (no loop)", async () => {
    const server = await createMcpServer({
      name: "reuse-invalidate",
      transport: "http",
      url: MCP_URL,
      scope: "swarm",
    });

    const first = await authorizeUrl(server.id);
    expect(dcrCallCount).toBe(1);
    const state = first.searchParams.get("state")!;

    const callbackRes = await dispatch(
      `/api/mcp-oauth/callback?state=${encodeURIComponent(state)}&code=auth-code`,
    );
    expect(callbackRes.status).toBe(302);
    expect((await getMcpOAuthToken(server.id))?.status).toBe("connected");
    expect((await getMcpOAuthToken(server.id))?.dcrClientId).toBe("client-as-1.example.test-1");

    // Provider now rejects the stored client at the token endpoint (e.g. a
    // subsequent refresh). Simulate via the refresh route.
    tokenShouldFail = "invalid_client";
    const refreshRes = await dispatch(`/api/mcp-oauth/${server.id}/refresh`, {
      method: "POST",
      headers: { Authorization: `Bearer ${API_KEY}` },
      body: JSON.stringify({}),
    });
    expect(refreshRes.status).toBe(500);
    expect((await getMcpOAuthToken(server.id))?.status).toBe("error");

    // The next /authorize call must register fresh exactly once (not reuse
    // the now-invalidated client, and not loop).
    tokenShouldFail = "";
    const third = await authorizeUrl(server.id);
    expect(dcrCallCount).toBe(2);
    expect(third.searchParams.get("client_id")).toBe("client-as-1.example.test-2");
    expect(third.searchParams.get("client_id")).not.toBe(first.searchParams.get("client_id"));

    // And a further call reuses THAT new client — invalidation doesn't loop.
    const fourth = await authorizeUrl(server.id);
    expect(dcrCallCount).toBe(2);
    expect(fourth.searchParams.get("client_id")).toBe(third.searchParams.get("client_id"));
  });

  test("two concurrent first authorize calls for the same connector+user register exactly one DCR client (no TOCTOU race)", async () => {
    const server = await createMcpServer({
      name: "reuse-concurrent",
      transport: "http",
      url: MCP_URL,
      scope: "swarm",
    });

    // Delay the DCR registration response so two concurrent callers are
    // guaranteed to overlap inside the check-reusable-then-register critical
    // section if it isn't serialized.
    const baseFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const href = input.toString();
      if (href === `https://${issuerHost}${registrationPath}` && init?.method === "POST") {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      return baseFetch(input, init);
    }) as typeof fetch;

    const [a, b] = await Promise.all([authorizeUrl(server.id), authorizeUrl(server.id)]);

    expect(dcrCallCount).toBe(1);
    expect(a.searchParams.get("client_id")).toBe(b.searchParams.get("client_id"));

    // The persisted app row must not have been split/corrupted by the race —
    // a subsequent call keeps reusing the same single client.
    const third = await authorizeUrl(server.id);
    expect(dcrCallCount).toBe(1);
    expect(third.searchParams.get("client_id")).toBe(a.searchParams.get("client_id"));
  });

  test("a requested scope not covered by the stored client forces re-registration", async () => {
    const server = await createMcpServer({
      name: "reuse-scope-change",
      transport: "http",
      url: MCP_URL,
      scope: "swarm",
    });

    // First call has no explicit scope request — the fixture's PRMD/AS
    // metadata advertises no scopes_supported, so the client registers with
    // no scope restriction recorded.
    const first = await authorizeUrl(server.id);
    expect(dcrCallCount).toBe(1);
    expect(first.searchParams.has("scope")).toBe(false);

    // A caller now explicitly requests scopes the stored client was never
    // registered with. Reusing it would silently send an authorize request
    // for a scope the provider never granted the client — must re-register.
    const second = await authorizeUrl(server.id, "read write");
    expect(dcrCallCount).toBe(2);
    expect(second.searchParams.get("client_id")).not.toBe(first.searchParams.get("client_id"));
    expect(second.searchParams.get("scope")).toBe("read write");

    // A further call requesting that SAME now-covered scope set reuses the
    // new client instead of registering yet again.
    const third = await authorizeUrl(server.id, "read write");
    expect(dcrCallCount).toBe(2);
    expect(third.searchParams.get("client_id")).toBe(second.searchParams.get("client_id"));
  });

  test("a granted scope narrower than the registered set is still reused, not re-registered", async () => {
    // The AS advertises a real catalogue, so the client is registered with
    // "read write" — but the provider's token response only GRANTS "read"
    // (the fixture's fixed mock). Comparing against the granted scope instead
    // of the registered scope would make every subsequent /authorize believe
    // the stored client was never registered with "write" and re-register on
    // every call.
    asScopesSupported = ["read", "write"];
    const server = await createMcpServer({
      name: "granted-narrower-than-registered",
      transport: "http",
      url: MCP_URL,
      scope: "swarm",
    });

    const first = await authorizeUrl(server.id);
    expect(first.searchParams.get("scope")).toBe("read write");
    const state = first.searchParams.get("state")!;
    await dispatch(`/api/mcp-oauth/callback?state=${encodeURIComponent(state)}&code=auth-code`);
    expect((await getMcpOAuthToken(server.id))?.status).toBe("connected");
    expect((await getMcpOAuthToken(server.id))?.scope).toBe("read");
    const clientId = (await getMcpOAuthToken(server.id))?.dcrClientId;
    expect(dcrCallCount).toBe(1);

    const second = await authorizeUrl(server.id);
    expect(dcrCallCount).toBe(1);
    expect(second.searchParams.get("client_id")).toBe(clientId);

    const third = await authorizeUrl(server.id);
    expect(dcrCallCount).toBe(1);
    expect(third.searchParams.get("client_id")).toBe(clientId);
  });

  test("completing a reused authorize call (not the one that registered) still records the real registered scope set", async () => {
    // Two overlapping /authorize calls: #1 freshly registers, #2 reuses that
    // client before #1's flow ever completes. The user then finishes flow
    // #2, not #1 — the reuse branch left `registeredScopes` undefined, so
    // the pending row backing #2 recorded a literal `null` for the
    // connector's registered scope set even though the reuse check just
    // above already knew the true value (`reusable.registeredScopes`).
    asScopesSupported = ["read", "write"];
    const server = await createMcpServer({
      name: "reuse-completes-not-register",
      transport: "http",
      url: MCP_URL,
      scope: "swarm",
    });

    const first = await authorizeUrl(server.id);
    expect(dcrCallCount).toBe(1);
    expect(first.searchParams.get("scope")).toBe("read write");

    const second = await authorizeUrl(server.id);
    expect(dcrCallCount).toBe(1);
    const stateB = second.searchParams.get("state")!;

    const callbackRes = await dispatch(
      `/api/mcp-oauth/callback?state=${encodeURIComponent(stateB)}&code=auth-code`,
    );
    expect(callbackRes.status).toBe(302);
    expect((await getMcpOAuthToken(server.id))?.status).toBe("connected");

    const stored = await findReusableMcpOAuthClient(server.id);
    expect(stored?.registeredScopes).toEqual(["read", "write"]);
  });

  test("an invalid_client from a freshly-registered client's callback does not invalidate the different, connected client", async () => {
    const server = await createMcpServer({
      name: "invalidate-wrong-target",
      transport: "http",
      url: MCP_URL,
      scope: "swarm",
    });

    // Connect once — client A.
    const first = await authorizeUrl(server.id);
    const stateA = first.searchParams.get("state")!;
    await dispatch(`/api/mcp-oauth/callback?state=${encodeURIComponent(stateA)}&code=auth-code`);
    expect((await getMcpOAuthToken(server.id))?.status).toBe("connected");
    const clientA = (await getMcpOAuthToken(server.id))?.dcrClientId;
    expect(dcrCallCount).toBe(1);

    // A second flow requests a scope the connected client wasn't registered
    // with — forces a FRESH registration (client B) while client A stays
    // connected and untouched.
    const second = await authorizeUrl(server.id, "read write");
    expect(dcrCallCount).toBe(2);
    const stateB = second.searchParams.get("state")!;
    const clientB = second.searchParams.get("client_id");
    expect(clientB).not.toBe(clientA);

    // The provider rejects client B (the one actually used) at the token
    // endpoint.
    tokenShouldFail = "invalid_client";
    const callbackRes = await dispatch(
      `/api/mcp-oauth/callback?state=${encodeURIComponent(stateB)}&code=auth-code-2`,
    );
    expect(callbackRes.status).toBe(302);
    expect(callbackRes.headers.location).toContain("oauth=error");

    // Client A must still be connected with its ORIGINAL client_id — the bug
    // resolved the invalidation target via rawMcpToken(...)?.appId (the
    // connected app) regardless of which client actually failed, silently
    // corrupting it on the next /authorize call.
    tokenShouldFail = "";
    const afterFailure = await getMcpOAuthToken(server.id);
    expect(afterFailure?.status).toBe("connected");
    expect(afterFailure?.dcrClientId).toBe(clientA);

    // Reusing client A's original (no-explicit-scope) conditions must still
    // work without a fresh registration — proving the connected app wasn't
    // flagged invalid by the unrelated client-B failure.
    const third = await authorizeUrl(server.id);
    expect(dcrCallCount).toBe(2);
    expect(third.searchParams.get("client_id")).toBe(clientA);
    expect((await getMcpOAuthToken(server.id))?.dcrClientId).toBe(clientA);
  });

  test("authorize-endpoint rejection (query.error) invalidates the reused client instead of waiting for GC", async () => {
    const server = await createMcpServer({
      name: "authorize-endpoint-reject",
      transport: "http",
      url: MCP_URL,
      scope: "swarm",
    });

    const first = await authorizeUrl(server.id);
    const stateA = first.searchParams.get("state")!;
    await dispatch(`/api/mcp-oauth/callback?state=${encodeURIComponent(stateA)}&code=auth-code`);
    expect((await getMcpOAuthToken(server.id))?.status).toBe("connected");
    expect(dcrCallCount).toBe(1);

    // Re-authorize reuses the connected client (no new registration yet) —
    // but the provider rejects it at the AUTHORIZE endpoint, redirecting
    // back with an error instead of a code.
    const second = await authorizeUrl(server.id);
    expect(dcrCallCount).toBe(1);
    const stateB = second.searchParams.get("state")!;
    const rejectRes = await dispatch(
      `/api/mcp-oauth/callback?state=${encodeURIComponent(stateB)}&error=unauthorized_client`,
    );
    expect(rejectRes.status).toBe(302);
    expect(rejectRes.headers.location).toContain("error=unauthorized_client");

    // The next authorize call must register fresh — not keep offering the
    // client the provider just rejected at the authorize endpoint.
    const third = await authorizeUrl(server.id);
    expect(dcrCallCount).toBe(2);
    expect(third.searchParams.get("client_id")).not.toBe(first.searchParams.get("client_id"));
  });

  test("a legacy connector with no recorded registrationEndpoint reuses instead of re-registering forever", async () => {
    const server = await createMcpServer({
      name: "legacy-null-registration-endpoint",
      transport: "http",
      url: MCP_URL,
      scope: "swarm",
    });

    const first = await authorizeUrl(server.id);
    const state = first.searchParams.get("state")!;
    await dispatch(`/api/mcp-oauth/callback?state=${encodeURIComponent(state)}&code=auth-code`);
    expect((await getMcpOAuthToken(server.id))?.status).toBe("connected");
    const clientId = (await getMcpOAuthToken(server.id))?.dcrClientId;
    expect(dcrCallCount).toBe(1);

    // Simulate a pre-this-PR row: registrationEndpoint was never recorded.
    const appRow = (await getDbClient().get<{ id: string; metadata: string }>(
      `SELECT a.id, a.metadata FROM oauth_apps a
         JOIN oauth_authorizations z ON z.appId = a.id
         WHERE a.mcpServerId = ?`,
      [server.id],
    ))!;
    const metadata = JSON.parse(appRow.metadata);
    metadata.registrationEndpoint = null;
    await getDbClient().run("UPDATE oauth_apps SET metadata = ? WHERE id = ?", [
      JSON.stringify(metadata),
      appRow.id,
    ]);

    // An abandoned/retried flow must NOT force a fresh registration just
    // because the legacy row predates this field.
    const second = await authorizeUrl(server.id);
    expect(dcrCallCount).toBe(1);
    expect(second.searchParams.get("client_id")).toBe(clientId);
  });

  test("a legacy connector with unknown (null) registeredScopes forces re-registration once a non-empty scope is needed", async () => {
    // Migration 117 backfilled every pre-existing MCP app row without a
    // `registeredScopes` value at all — a stored `null` here must mean
    // "we don't know what this client is registered for", not "compatible
    // with anything". Treating it as universally compatible would let a
    // client actually registered for a narrow scope be reused for a
    // provider-advertised (or caller-requested) broader one, which the
    // provider may reject or silently narrow.
    asScopesSupported = ["read"];
    const server = await createMcpServer({
      name: "legacy-null-registered-scopes",
      transport: "http",
      url: MCP_URL,
      scope: "swarm",
    });

    const first = await authorizeUrl(server.id);
    expect(first.searchParams.get("scope")).toBe("read");
    const state = first.searchParams.get("state")!;
    await dispatch(`/api/mcp-oauth/callback?state=${encodeURIComponent(state)}&code=auth-code`);
    expect((await getMcpOAuthToken(server.id))?.status).toBe("connected");
    const originalClientId = (await getMcpOAuthToken(server.id))?.dcrClientId;
    expect(dcrCallCount).toBe(1);

    // Simulate a pre-this-series row: registeredScopes was never recorded
    // (migration 117's backfill, or a connect from before that field existed).
    const appRow = (await getDbClient().get<{ id: string; metadata: string }>(
      `SELECT a.id, a.metadata FROM oauth_apps a
         JOIN oauth_authorizations z ON z.appId = a.id
         WHERE a.mcpServerId = ?`,
      [server.id],
    ))!;
    const metadata = JSON.parse(appRow.metadata);
    delete metadata.registeredScopes;
    await getDbClient().run("UPDATE oauth_apps SET metadata = ? WHERE id = ?", [
      JSON.stringify(metadata),
      appRow.id,
    ]);
    expect((await findReusableMcpOAuthClient(server.id))?.registeredScopes).toBeNull();

    // The provider now advertises a wider scope set than the unknown
    // registered client might actually support — must NOT infer coverage
    // from the null and reuse; must do the one fresh DCR needed to establish
    // a known registered set.
    asScopesSupported = ["read", "write"];
    const second = await authorizeUrl(server.id);
    expect(dcrCallCount).toBe(2);
    expect(second.searchParams.get("client_id")).not.toBe(originalClientId);
    expect(second.searchParams.get("scope")).toBe("read write");
    const secondState = second.searchParams.get("state")!;
    await dispatch(
      `/api/mcp-oauth/callback?state=${encodeURIComponent(secondState)}&code=auth-code-2`,
    );
    expect((await getMcpOAuthToken(server.id))?.dcrClientId).toBe(
      second.searchParams.get("client_id"),
    );

    // The new client's registeredScopes is now known — later calls for the
    // same scope set reuse it without ever falling back to the granted
    // token scope.
    const third = await authorizeUrl(server.id);
    expect(dcrCallCount).toBe(2);
    expect(third.searchParams.get("client_id")).toBe(second.searchParams.get("client_id"));
  });

  test("no explicit scopes + an empty registered scope set does not reuse with the full discovery scope set", async () => {
    const server = await createMcpServer({
      name: "empty-registered-scope",
      transport: "http",
      url: MCP_URL,
      scope: "swarm",
    });

    // The fixture's default asScopesSupported ([]) means this client is
    // registered with an empty scope set — registeredScopes naturally ends
    // up `[]`, no DB fixture hack needed.
    const first = await authorizeUrl(server.id);
    const state = first.searchParams.get("state")!;
    await dispatch(`/api/mcp-oauth/callback?state=${encodeURIComponent(state)}&code=auth-code`);
    expect((await getMcpOAuthToken(server.id))?.status).toBe("connected");
    const originalClientId = (await getMcpOAuthToken(server.id))?.dcrClientId;
    expect(dcrCallCount).toBe(1);

    // The provider now advertises real scopes.
    asScopesSupported = ["read", "write"];

    // No explicit ?scopes= — must NOT silently reuse the unscoped client
    // with the AS's full advertised scope set. Must re-register properly
    // scoped instead.
    const second = await authorizeUrl(server.id);
    expect(dcrCallCount).toBe(2);
    expect(second.searchParams.get("client_id")).not.toBe(originalClientId);
    expect(second.searchParams.get("scope")).toBe("read write");
  });

  test("a legacy connector with no recorded redirectUri reuses instead of re-registering forever", async () => {
    const server = await createMcpServer({
      name: "legacy-empty-redirect-uri",
      transport: "http",
      url: MCP_URL,
      scope: "swarm",
    });

    const first = await authorizeUrl(server.id);
    const state = first.searchParams.get("state")!;
    await dispatch(`/api/mcp-oauth/callback?state=${encodeURIComponent(state)}&code=auth-code`);
    expect((await getMcpOAuthToken(server.id))?.status).toBe("connected");
    const clientId = (await getMcpOAuthToken(server.id))?.dcrClientId;
    expect(dcrCallCount).toBe(1);

    // Simulate a pre-349b691c row: redirectUri was never persisted (migration
    // 117's backfill sentinel, or a connect from before that fix).
    const appRow = (await getDbClient().get<{ id: string }>(
      `SELECT a.id FROM oauth_apps a JOIN oauth_authorizations z ON z.appId = a.id WHERE a.mcpServerId = ?`,
      [server.id],
    ))!;
    await getDbClient().run("UPDATE oauth_apps SET redirectUri = '' WHERE id = ?", [appRow.id]);

    // An abandoned/retried flow must NOT force a fresh registration just
    // because the legacy row predates this field being recorded.
    const second = await authorizeUrl(server.id);
    expect(dcrCallCount).toBe(1);
    expect(second.searchParams.get("client_id")).toBe(clientId);
  });

  test("a failing exchange leaks no credential into the dashboard redirect or the log", async () => {
    const server = await createMcpServer({
      name: "callback-redaction",
      transport: "http",
      url: MCP_URL,
      scope: "swarm",
    });

    const first = await authorizeUrl(server.id);
    const state = first.searchParams.get("state")!;

    // The provider echoes every credential the exchange transmitted. Both
    // callback sinks (console.error and error_description on the redirect)
    // receive the thrown message verbatim, so none of these may survive.
    const clientSecret = "secret-as-1.example.test-1";
    const encodedSecret = new URLSearchParams({ v: clientSecret }).toString().slice(2);
    const basicBlob = Buffer.from(
      `${new URLSearchParams({ v: "client-as-1.example.test-1" }).toString().slice(2)}:${encodedSecret}`,
    ).toString("base64");
    const echoed = `${clientSecret} ${encodedSecret} ${basicBlob} auth-code`;

    const priorFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const href = input.toString();
      if (href === `https://${issuerHost}/token` && init?.method === "POST") {
        return new Response(`{"error":"invalid_request","detail":"${echoed}"}`, { status: 400 });
      }
      return priorFetch(input as string, init);
    }) as typeof fetch;

    const errors: string[] = [];
    const priorError = console.error;
    console.error = (...args: unknown[]) => {
      errors.push(args.map(String).join(" "));
    };

    try {
      const callbackRes = await dispatch(
        `/api/mcp-oauth/callback?state=${encodeURIComponent(state)}&code=auth-code`,
      );
      expect(callbackRes.status).toBe(302);

      const location = callbackRes.headers.location ?? "";
      const description = new URL(location).searchParams.get("error_description") ?? "";
      expect(description).toContain("Token exchange failed (400)");

      for (const leak of [clientSecret, encodedSecret, basicBlob]) {
        expect(description).not.toContain(leak);
        expect(errors.join("\n")).not.toContain(leak);
      }
    } finally {
      console.error = priorError;
      globalThis.fetch = priorFetch;
    }
  });

  test("a callback in flight across the deploy exchanges with body-post, not Basic", async () => {
    const server = await createMcpServer({
      name: "inflight-legacy-pending",
      transport: "http",
      url: MCP_URL,
      scope: "swarm",
    });

    const first = await authorizeUrl(server.id);
    const state = first.searchParams.get("state")!;

    // Simulate a pending row written before tokenEndpointAuthMethod existed:
    // the user started consent on the old build and the callback lands on the
    // new one. Its client was registered under the old body-post behavior.
    await getDbClient().run(
      "UPDATE oauth_pending SET contextJson = json_remove(contextJson, '$.tokenEndpointAuthMethod') WHERE state = ?",
      [state],
    );

    const callbackRes = await dispatch(
      `/api/mcp-oauth/callback?state=${encodeURIComponent(state)}&code=auth-code`,
    );
    expect(callbackRes.status).toBe(302);
    expect((await getMcpOAuthToken(server.id))?.status).toBe("connected");

    const body = new URLSearchParams(capturedTokenBody);
    expect(capturedTokenHeaders.Authorization).toBeUndefined();
    expect(body.get("client_id")).toBe("client-as-1.example.test-1");
    expect(body.get("client_secret")).toBe("secret-as-1.example.test-1");

    // And the resolution is persisted, so later refreshes stay consistent.
    expect((await getMcpOAuthToken(server.id))?.tokenEndpointAuthMethod).toBe("client_secret_post");
  });
});
