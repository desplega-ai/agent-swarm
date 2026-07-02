import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { closeDb, createMcpServer, initDb } from "../be/db";
import {
  getMcpOAuthToken,
  type UpsertMcpOAuthTokenInput,
  upsertMcpOAuthToken,
} from "../be/db-queries/mcp-oauth";
import { ensureMcpToken } from "../oauth/ensure-mcp-token";

const TEST_DB_PATH = "./test-mcp-oauth-ensure-token.sqlite";

process.env.SECRETS_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString("base64");

beforeAll(() => {
  initDb(TEST_DB_PATH);
});

afterAll(async () => {
  closeDb();
  for (const suffix of ["", "-wal", "-shm"]) {
    await unlink(`${TEST_DB_PATH}${suffix}`).catch(() => {});
  }
});

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

function makeToken(overrides: Partial<UpsertMcpOAuthTokenInput> = {}): UpsertMcpOAuthTokenInput {
  const server = createMcpServer({
    name: `ens-${Math.random().toString(36).slice(2, 10)}`,
    transport: "http",
    url: "https://mcp.example.com",
    scope: "swarm",
  });
  return {
    mcpServerId: server.id,
    accessToken: "fresh-access",
    refreshToken: "refresh-ok",
    tokenType: "Bearer",
    expiresAt: new Date(Date.now() + 3600_000).toISOString(), // not expiring
    scope: "read",
    resourceUrl: "https://mcp.example.com/",
    authorizationServerIssuer: "https://as.example.com",
    authorizeUrl: "https://as.example.com/authorize",
    tokenUrl: "https://as.example.com/token",
    dcrClientId: "client-abc",
    dcrClientSecret: "secret-xyz",
    clientSource: "dcr",
    status: "connected",
    ...overrides,
  };
}

describe("ensureMcpToken", () => {
  test("returns null when no token row exists", async () => {
    const server = createMcpServer({
      name: "ens-nothing",
      transport: "http",
      url: "https://mcp.example.com",
      scope: "swarm",
    });
    const token = await ensureMcpToken(server.id);
    expect(token).toBeNull();
  });

  test("returns fresh token without calling fetch", async () => {
    const input = makeToken();
    upsertMcpOAuthToken(input);

    let fetchCalled = false;
    globalThis.fetch = async () => {
      fetchCalled = true;
      return new Response("nope", { status: 500 });
    };

    const token = await ensureMcpToken(input.mcpServerId);
    expect(token).not.toBeNull();
    expect(token!.accessToken).toBe("fresh-access");
    expect(fetchCalled).toBe(false);
  });

  test("returns 'revoked' token untouched (never refresh a revoked token)", async () => {
    const input = makeToken({
      status: "revoked",
      expiresAt: new Date(Date.now() - 1000).toISOString(), // expired
    });
    upsertMcpOAuthToken(input);

    globalThis.fetch = async () => {
      throw new Error("should not fetch for revoked tokens");
    };

    const token = await ensureMcpToken(input.mcpServerId);
    expect(token).not.toBeNull();
    expect(token!.status).toBe("revoked");
  });

  test("flips status to 'expired' when no refresh token and access is expiring", async () => {
    const input = makeToken({
      refreshToken: null,
      expiresAt: new Date(Date.now() + 30_000).toISOString(), // within 5-min buffer
    });
    upsertMcpOAuthToken(input);

    const token = await ensureMcpToken(input.mcpServerId);
    expect(token!.status).toBe("expired");

    // Persisted
    const reread = getMcpOAuthToken(input.mcpServerId);
    expect(reread!.status).toBe("expired");
    expect(reread!.lastErrorMessage).toMatch(/reconnect required/i);
  });

  test("refreshes when expiring and refresh succeeds", async () => {
    const input = makeToken({
      expiresAt: new Date(Date.now() + 30_000).toISOString(), // within 5-min buffer
    });
    upsertMcpOAuthToken(input);

    let calls = 0;
    globalThis.fetch = async (_url: string | URL | Request, init?: RequestInit) => {
      calls += 1;
      const params = new URLSearchParams((init?.body as string) ?? "");
      expect(params.get("grant_type")).toBe("refresh_token");
      expect(params.get("refresh_token")).toBe("refresh-ok");
      return new Response(
        JSON.stringify({
          access_token: "refreshed-access",
          expires_in: 3600,
          refresh_token: "refresh-next",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };

    const token = await ensureMcpToken(input.mcpServerId);
    expect(token).not.toBeNull();
    expect(token!.accessToken).toBe("refreshed-access");
    expect(token!.refreshToken).toBe("refresh-next");
    expect(token!.status).toBe("connected");
    expect(calls).toBe(1);
  });

  test("flips status to 'error' on refresh failure", async () => {
    const input = makeToken({
      expiresAt: new Date(Date.now() + 30_000).toISOString(),
    });
    upsertMcpOAuthToken(input);

    globalThis.fetch = async () => new Response('{"error":"invalid_grant"}', { status: 400 });

    const token = await ensureMcpToken(input.mcpServerId);
    expect(token!.status).toBe("error");
    expect(token!.lastErrorMessage).toMatch(/Token refresh failed/);

    const reread = getMcpOAuthToken(input.mcpServerId);
    expect(reread!.status).toBe("error");
  });

  test("concurrent calls dedupe via per-key inflight mutex", async () => {
    const input = makeToken({
      expiresAt: new Date(Date.now() + 30_000).toISOString(),
    });
    upsertMcpOAuthToken(input);

    let calls = 0;
    globalThis.fetch = async () => {
      calls += 1;
      // small delay so second caller piggy-backs on inflight
      await new Promise((r) => setTimeout(r, 25));
      return new Response(JSON.stringify({ access_token: "shared-refreshed", expires_in: 3600 }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };

    const [a, b, c] = await Promise.all([
      ensureMcpToken(input.mcpServerId),
      ensureMcpToken(input.mcpServerId),
      ensureMcpToken(input.mcpServerId),
    ]);
    expect(calls).toBe(1);
    expect(a!.accessToken).toBe("shared-refreshed");
    expect(b!.accessToken).toBe("shared-refreshed");
    expect(c!.accessToken).toBe("shared-refreshed");
  });
});
