import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer as createHttpServer, type Server } from "node:http";
import { closeDb, createAgent, createMcpServer, initDb, installMcpServer } from "../be/db";
import { setMcpServerAuthMethod, upsertMcpOAuthToken } from "../be/db-queries/mcp-oauth";
import { handleMcpServers } from "../http/mcp-servers";

const TEST_DB_PATH = "./test-mcp-oauth-resolve-secrets.sqlite";
const TEST_PORT = 13041;

process.env.SECRETS_ENCRYPTION_KEY = Buffer.alloc(32, 11).toString("base64");

let server: Server;
const originalFetch = globalThis.fetch;

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
  await new Promise<void>((resolve) => {
    server.listen(TEST_PORT, () => resolve());
  });
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  closeDb();
  for (const suffix of ["", "-wal", "-shm"]) {
    await unlink(`${TEST_DB_PATH}${suffix}`).catch(() => {});
  }
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

async function agentMcpServers(
  agentId: string,
  resolveSecrets = true,
): Promise<{
  servers: Array<{
    id: string;
    authMethod: "static" | "oauth" | "auto";
    resolvedEnv?: Record<string, string>;
    resolvedHeaders?: Record<string, string>;
    authError?: string | null;
  }>;
}> {
  const qs = resolveSecrets ? "?resolveSecrets=true" : "";
  const res = await fetch(`http://localhost:${TEST_PORT}/api/agents/${agentId}/mcp-servers${qs}`);
  expect(res.status).toBe(200);
  return (await res.json()) as never;
}

describe("resolveSecrets integration — OAuth Authorization injection", () => {
  test("OAuth server with connected token gets Bearer header", async () => {
    const agent = createAgent({
      id: crypto.randomUUID(),
      name: "oauth-agent",
      status: "idle",
      isLead: false,
    });
    const mcp = createMcpServer({
      name: "mcp-oauth-ok",
      transport: "http",
      url: "https://mcp.example.com",
      scope: "agent",
      ownerAgentId: agent.id,
    });
    installMcpServer(agent.id, mcp.id);
    setMcpServerAuthMethod(mcp.id, "oauth");
    upsertMcpOAuthToken({
      mcpServerId: mcp.id,
      accessToken: "bearer-live-123",
      refreshToken: null,
      expiresAt: new Date(Date.now() + 3600_000).toISOString(), // fresh, no refresh path
      resourceUrl: "https://mcp.example.com/",
      authorizationServerIssuer: "https://as.example.com",
      authorizeUrl: "https://as.example.com/authorize",
      tokenUrl: "https://as.example.com/token",
      clientSource: "dcr",
      status: "connected",
    });

    const result = await agentMcpServers(agent.id);
    const match = result.servers.find((s) => s.id === mcp.id);
    expect(match).toBeTruthy();
    expect(match!.authMethod).toBe("oauth");
    expect(match!.resolvedHeaders?.Authorization).toBe("Bearer bearer-live-123");
    expect(match!.authError).toBeNull();
  });

  test("lowercase 'bearer' tokenType is normalized to capital 'Bearer' in Authorization header", async () => {
    // Providers that follow RFC 6749 strictly (e.g. Amplitude's MCP) return
    // `token_type: "bearer"`. Some resource servers then reject the lowercase
    // prefix with 401. The fix in src/http/mcp-servers.ts normalizes the
    // scheme to capital "Bearer". See GitHub issue #368.
    const agent = createAgent({
      id: crypto.randomUUID(),
      name: "oauth-agent-lowercase",
      status: "idle",
      isLead: false,
    });
    const mcp = createMcpServer({
      name: "mcp-oauth-lowercase-bearer",
      transport: "http",
      url: "https://mcp.example.com",
      scope: "agent",
      ownerAgentId: agent.id,
    });
    installMcpServer(agent.id, mcp.id);
    setMcpServerAuthMethod(mcp.id, "oauth");
    upsertMcpOAuthToken({
      mcpServerId: mcp.id,
      accessToken: "lowercase-token-xyz",
      refreshToken: null,
      tokenType: "bearer", // lowercase, as RFC 6749 prescribes
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      resourceUrl: "https://mcp.example.com/",
      authorizationServerIssuer: "https://as.example.com",
      authorizeUrl: "https://as.example.com/authorize",
      tokenUrl: "https://as.example.com/token",
      clientSource: "dcr",
      status: "connected",
    });

    const result = await agentMcpServers(agent.id);
    const match = result.servers.find((s) => s.id === mcp.id);
    expect(match).toBeTruthy();
    expect(match!.resolvedHeaders?.Authorization).toBe("Bearer lowercase-token-xyz");
    expect(match!.resolvedHeaders?.Authorization?.startsWith("Bearer ")).toBe(true);
  });

  test("non-bearer tokenType (e.g. 'MAC') is preserved verbatim in Authorization header", async () => {
    // RFC 6749 allows non-bearer token types. The normalization must only
    // touch the bearer scheme and leave others alone.
    const agent = createAgent({
      id: crypto.randomUUID(),
      name: "oauth-agent-mac",
      status: "idle",
      isLead: false,
    });
    const mcp = createMcpServer({
      name: "mcp-oauth-mac",
      transport: "http",
      url: "https://mcp.example.com",
      scope: "agent",
      ownerAgentId: agent.id,
    });
    installMcpServer(agent.id, mcp.id);
    setMcpServerAuthMethod(mcp.id, "oauth");
    upsertMcpOAuthToken({
      mcpServerId: mcp.id,
      accessToken: "mac-token-xyz",
      refreshToken: null,
      tokenType: "MAC",
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      resourceUrl: "https://mcp.example.com/",
      authorizationServerIssuer: "https://as.example.com",
      authorizeUrl: "https://as.example.com/authorize",
      tokenUrl: "https://as.example.com/token",
      clientSource: "dcr",
      status: "connected",
    });

    const result = await agentMcpServers(agent.id);
    const match = result.servers.find((s) => s.id === mcp.id);
    expect(match).toBeTruthy();
    expect(match!.resolvedHeaders?.Authorization).toBe("MAC mac-token-xyz");
  });

  test("OAuth server without token row surfaces authError", async () => {
    const agent = createAgent({
      id: crypto.randomUUID(),
      name: "oauth-agent-missing",
      status: "idle",
      isLead: false,
    });
    const mcp = createMcpServer({
      name: "mcp-oauth-no-token",
      transport: "http",
      url: "https://mcp.example.com",
      scope: "agent",
      ownerAgentId: agent.id,
    });
    installMcpServer(agent.id, mcp.id);
    setMcpServerAuthMethod(mcp.id, "oauth");

    const result = await agentMcpServers(agent.id);
    const match = result.servers.find((s) => s.id === mcp.id);
    expect(match).toBeTruthy();
    expect(match!.resolvedHeaders?.Authorization).toBeUndefined();
    expect(match!.authError).toBe("No OAuth token for this MCP server");
  });

  test("OAuth server with expired token (no refresh) reports lastErrorMessage", async () => {
    const agent = createAgent({
      id: crypto.randomUUID(),
      name: "oauth-agent-expired",
      status: "idle",
      isLead: false,
    });
    const mcp = createMcpServer({
      name: "mcp-oauth-expired",
      transport: "http",
      url: "https://mcp.example.com",
      scope: "agent",
      ownerAgentId: agent.id,
    });
    installMcpServer(agent.id, mcp.id);
    setMcpServerAuthMethod(mcp.id, "oauth");
    upsertMcpOAuthToken({
      mcpServerId: mcp.id,
      accessToken: "stale",
      refreshToken: null, // no refresh available → ensureMcpToken flips to 'expired'
      expiresAt: new Date(Date.now() + 5_000).toISOString(), // within 5-min buffer
      resourceUrl: "https://mcp.example.com/",
      authorizationServerIssuer: "https://as.example.com",
      authorizeUrl: "https://as.example.com/authorize",
      tokenUrl: "https://as.example.com/token",
      clientSource: "dcr",
      status: "connected",
    });

    const result = await agentMcpServers(agent.id);
    const match = result.servers.find((s) => s.id === mcp.id);
    expect(match).toBeTruthy();
    expect(match!.resolvedHeaders?.Authorization).toBeUndefined();
    expect(match!.authError).toMatch(/reconnect required|expired/i);
  });

  test("OAuth branch strips any stale Authorization header from static resolver", async () => {
    // Seed a server that sets a static "Authorization" header via headerConfigKeys,
    // then flip it to authMethod=oauth with a connected token. The oauth branch
    // should OVERRIDE the static header even if the config key resolves.
    const agent = createAgent({
      id: crypto.randomUUID(),
      name: "oauth-agent-strip",
      status: "idle",
      isLead: false,
    });
    const mcp = createMcpServer({
      name: "mcp-oauth-strip",
      transport: "http",
      url: "https://mcp.example.com",
      scope: "agent",
      ownerAgentId: agent.id,
      headerConfigKeys: JSON.stringify({ Authorization: "STATIC_BEARER" }),
    });
    installMcpServer(agent.id, mcp.id);
    setMcpServerAuthMethod(mcp.id, "oauth");
    upsertMcpOAuthToken({
      mcpServerId: mcp.id,
      accessToken: "new-bearer",
      refreshToken: null,
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      resourceUrl: "https://mcp.example.com/",
      authorizationServerIssuer: "https://as.example.com",
      authorizeUrl: "https://as.example.com/authorize",
      tokenUrl: "https://as.example.com/token",
      clientSource: "dcr",
      status: "connected",
    });

    const result = await agentMcpServers(agent.id);
    const match = result.servers.find((s) => s.id === mcp.id);
    expect(match!.resolvedHeaders?.Authorization).toBe("Bearer new-bearer");
  });

  test("static server retains default authError=null in the response shape", async () => {
    const agent = createAgent({
      id: crypto.randomUUID(),
      name: "static-agent",
      status: "idle",
      isLead: false,
    });
    const mcp = createMcpServer({
      name: "mcp-static",
      transport: "http",
      url: "https://mcp.example.com",
      scope: "agent",
      ownerAgentId: agent.id,
    });
    installMcpServer(agent.id, mcp.id);

    const result = await agentMcpServers(agent.id);
    const match = result.servers.find((s) => s.id === mcp.id);
    expect(match!.authMethod).toBe("static");
    expect(match!.authError).toBeNull();
    expect(match!.resolvedHeaders?.Authorization).toBeUndefined();
  });
});
