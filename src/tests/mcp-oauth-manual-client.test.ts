import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { closeDb, createMcpServer, initDb } from "../be/db";
import { getMcpOAuthToken } from "../be/db-queries/mcp-oauth";
import { handleCore } from "../http/core";
import { handleMcpOAuth } from "../http/mcp-oauth";
import { getPathSegments, parseQueryParams } from "../http/utils";

const API_KEY = "test-secret-key";
const TEST_DB_PATH = "./test-mcp-oauth-manual-client.sqlite";

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

describe("MCP OAuth manual client flow", () => {
  let originalFetch: typeof fetch;
  let capturedTokenBody: string | null;
  let originalPublicMcpBaseUrl: string | undefined;
  let originalAppUrl: string | undefined;
  let originalDashboardUrl: string | undefined;

  beforeEach(async () => {
    originalFetch = globalThis.fetch;
    capturedTokenBody = null;
    originalPublicMcpBaseUrl = process.env.PUBLIC_MCP_BASE_URL;
    originalAppUrl = process.env.APP_URL;
    originalDashboardUrl = process.env.DASHBOARD_URL;
    process.env.SECRETS_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString("base64");

    await removeDbFiles();
    initDb(TEST_DB_PATH);
    process.env.PUBLIC_MCP_BASE_URL = "https://swarm.example.test";
    process.env.APP_URL = "https://dashboard.example.test";
    delete process.env.DASHBOARD_URL;

    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const href = input.toString();
      if (href === "https://login.salesforce.com/services/oauth2/token") {
        capturedTokenBody = init?.body?.toString() ?? null;
        return new Response(
          JSON.stringify({
            access_token: "sf-access-token",
            token_type: "Bearer",
            expires_in: 3600,
            refresh_token: "sf-refresh-token",
            scope: "mcp_api refresh_token",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    closeDb();
    await removeDbFiles();
    if (originalPublicMcpBaseUrl === undefined) delete process.env.PUBLIC_MCP_BASE_URL;
    else process.env.PUBLIC_MCP_BASE_URL = originalPublicMcpBaseUrl;
    if (originalAppUrl === undefined) delete process.env.APP_URL;
    else process.env.APP_URL = originalAppUrl;
    if (originalDashboardUrl === undefined) delete process.env.DASHBOARD_URL;
    else process.env.DASHBOARD_URL = originalDashboardUrl;
  });

  test("authorize-url uses a stored manual client when DCR is not available", async () => {
    const mcpServer = createMcpServer({
      name: "salesforce-sobjects",
      transport: "http",
      url: "https://api.salesforce.com/platform/mcp/v1/platform/sobject-all",
      scope: "swarm",
    });

    const manualRes = await dispatch(`/api/mcp-oauth/${mcpServer.id}/manual-client`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${API_KEY}`,
      },
      body: JSON.stringify({
        clientId: "sf-client-id",
        clientSecret: "sf-client-secret",
        authorizationServerIssuer: "https://login.salesforce.com",
        authorizeUrl: "https://login.salesforce.com/services/oauth2/authorize",
        tokenUrl: "https://login.salesforce.com/services/oauth2/token",
        scopes: ["mcp_api", "refresh_token"],
      }),
    });
    expect(manualRes.status).toBe(200);

    const provisionalToken = getMcpOAuthToken(mcpServer.id);
    expect(provisionalToken?.clientSource).toBe("manual");
    expect(provisionalToken?.status).toBe("error");

    const authorizeRes = await dispatch(`/api/mcp-oauth/${mcpServer.id}/authorize-url`, {
      headers: { Authorization: `Bearer ${API_KEY}` },
    });
    expect(authorizeRes.status).toBe(200);
    const { providerUrl } = (await authorizeRes.json()) as { providerUrl: string };
    const provider = new URL(providerUrl);

    expect(provider.origin + provider.pathname).toBe(
      "https://login.salesforce.com/services/oauth2/authorize",
    );
    expect(provider.searchParams.get("client_id")).toBe("sf-client-id");
    expect(provider.searchParams.get("scope")).toBe("mcp_api refresh_token");
    expect(provider.searchParams.get("resource")).toBe(mcpServer.url);
    expect(provider.searchParams.get("redirect_uri")).toBe(
      "https://swarm.example.test/api/mcp-oauth/callback",
    );

    const state = provider.searchParams.get("state");
    expect(state).toBeTruthy();

    const callbackRes = await dispatch(
      `/api/mcp-oauth/callback?state=${encodeURIComponent(state!)}&code=sf-auth-code`,
    );
    expect(callbackRes.status).toBe(302);
    expect(callbackRes.headers.location).toBe(
      `${process.env.APP_URL}/mcp-servers/${mcpServer.id}?oauth=success`,
    );

    const tokenRequest = new URLSearchParams(capturedTokenBody ?? "");
    expect(tokenRequest.get("client_id")).toBe("sf-client-id");
    expect(tokenRequest.get("client_secret")).toBe("sf-client-secret");
    expect(tokenRequest.get("resource")).toBe(mcpServer.url);
    expect(tokenRequest.get("redirect_uri")).toBe(
      "https://swarm.example.test/api/mcp-oauth/callback",
    );

    const connectedToken = getMcpOAuthToken(mcpServer.id);
    expect(connectedToken?.clientSource).toBe("manual");
    expect(connectedToken?.status).toBe("connected");
    expect(connectedToken?.accessToken).toBe("sf-access-token");
    expect(connectedToken?.refreshToken).toBe("sf-refresh-token");
    expect(connectedToken?.dcrClientId).toBe("sf-client-id");
    expect(connectedToken?.dcrClientSecret).toBe("sf-client-secret");
  });
});
