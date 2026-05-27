import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { closeDb, createMcpServer, createUser, initDb } from "../be/db";
import {
  consumeMcpOAuthPending,
  deleteMcpOAuthToken,
  gcMcpOAuthPending,
  getMcpOAuthToken,
  getMcpServerAuthMethod,
  insertMcpOAuthPending,
  isMcpTokenExpiringSoon,
  listMcpOAuthTokensForMcp,
  markMcpOAuthTokenStatus,
  setMcpServerAuthMethod,
  upsertMcpOAuthToken,
} from "../be/db-queries/mcp-oauth";

const TEST_DB_PATH = "./test-mcp-oauth-queries.sqlite";

// Deterministic key for tests — doesn't need to match prod.
process.env.SECRETS_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");

beforeAll(async () => {
  await initDb(TEST_DB_PATH);
});

afterAll(async () => {
  closeDb();
  for (const suffix of ["", "-wal", "-shm"]) {
    await unlink(`${TEST_DB_PATH}${suffix}`).catch(() => {});
  }
});

async function makeServer(name: string) {
  return await createMcpServer({
    name,
    transport: "http",
    url: "https://mcp.example.com",
    scope: "swarm",
  });
}

const base = (mcpServerId: string) => ({
  mcpServerId,
  accessToken: "access-123",
  refreshToken: "refresh-456",
  tokenType: "Bearer",
  expiresAt: new Date(Date.now() + 3600_000).toISOString(),
  scope: "read write",
  resourceUrl: "https://mcp.example.com/",
  authorizationServerIssuer: "https://as.example.com",
  authorizeUrl: "https://as.example.com/authorize",
  tokenUrl: "https://as.example.com/token",
  revocationUrl: null,
  dcrClientId: "client-abc",
  dcrClientSecret: "dcr-secret-xyz",
  clientSource: "dcr" as const,
  status: "connected" as const,
});

describe("mcp_oauth_tokens encryption roundtrip", () => {
  test("upsert + read decrypts accessToken, refreshToken, dcrClientSecret", async () => {
    const server = await makeServer("mcp-enc-roundtrip");
    await upsertMcpOAuthToken(base(server.id));
    const token = await getMcpOAuthToken(server.id);

    expect(token).not.toBeNull();
    expect(token!.accessToken).toBe("access-123");
    expect(token!.refreshToken).toBe("refresh-456");
    expect(token!.dcrClientSecret).toBe("dcr-secret-xyz");
    expect(token!.status).toBe("connected");
  });

  test("access token is encrypted at rest (not stored plaintext)", async () => {
    const server = await makeServer("mcp-enc-at-rest");
    await upsertMcpOAuthToken({ ...base(server.id), accessToken: "UNIQUE_PLAINTEXT_TOKEN_ABC" });

    // Use raw SQL to inspect the row bypassing the decrypt helper.
    const { getDb } = await import("../be/db");
    const row = (await getDb())
      .query("SELECT accessToken FROM mcp_oauth_tokens WHERE mcpServerId = ?")
      .get(server.id) as { accessToken: string } | null;

    expect(row).not.toBeNull();
    expect(row!.accessToken).not.toBe("UNIQUE_PLAINTEXT_TOKEN_ABC");
    expect(row!.accessToken.length).toBeGreaterThan(24);
  });

  test("upsert conflict updates by (mcpServerId, userId)", async () => {
    const server = await makeServer("mcp-upsert-conflict");
    await upsertMcpOAuthToken(base(server.id));
    await upsertMcpOAuthToken({
      ...base(server.id),
      accessToken: "access-updated",
      scope: "read",
    });
    const token = await getMcpOAuthToken(server.id);
    expect(token!.accessToken).toBe("access-updated");
    // COALESCE behaviour on refreshToken: not overridden when updater omits it
    // (we re-pass the same refresh above, so expect it intact).
    expect(token!.refreshToken).toBe("refresh-456");
  });
});

describe("markMcpOAuthTokenStatus + deleteMcpOAuthToken", () => {
  test("status flip writes status and error message", async () => {
    const server = await makeServer("mcp-status-flip");
    await upsertMcpOAuthToken(base(server.id));
    const original = await getMcpOAuthToken(server.id)!;
    await markMcpOAuthTokenStatus(original.id, "expired", "refresh token missing");

    const updated = await getMcpOAuthToken(server.id)!;
    expect(updated.status).toBe("expired");
    expect(updated.lastErrorMessage).toBe("refresh token missing");
  });

  test("delete removes the row", async () => {
    const server = await makeServer("mcp-delete-row");
    await upsertMcpOAuthToken(base(server.id));
    expect(await getMcpOAuthToken(server.id)).not.toBeNull();
    expect(await deleteMcpOAuthToken(server.id)).toBe(true);
    expect(await getMcpOAuthToken(server.id)).toBeNull();
  });

  test("listMcpOAuthTokensForMcp returns multiple user rows", async () => {
    const server = await makeServer("mcp-multi-user");
    const userA = await createUser({ name: "user-a" });
    const userB = await createUser({ name: "user-b" });
    await upsertMcpOAuthToken({ ...base(server.id), userId: userA.id });
    await upsertMcpOAuthToken({ ...base(server.id), userId: userB.id });
    const rows = await listMcpOAuthTokensForMcp(server.id);
    expect(rows.length).toBe(2);
    expect(new Set(rows.map((r) => r.userId))).toEqual(new Set([userA.id, userB.id]));
  });
});

describe("isMcpTokenExpiringSoon", () => {
  test("expiresAt null → not expiring (long-lived token)", async () => {
    const token = {
      expiresAt: null,
    } as Parameters<typeof isMcpTokenExpiringSoon>[0];
    expect(await isMcpTokenExpiringSoon(token)).toBe(false);
  });

  test("far future → not expiring", async () => {
    const token = {
      expiresAt: new Date(Date.now() + 24 * 3600_000).toISOString(),
    } as Parameters<typeof isMcpTokenExpiringSoon>[0];
    expect(await isMcpTokenExpiringSoon(token)).toBe(false);
  });

  test("within default 5-min buffer → expiring", async () => {
    const token = {
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    } as Parameters<typeof isMcpTokenExpiringSoon>[0];
    expect(await isMcpTokenExpiringSoon(token)).toBe(true);
  });

  test("custom buffer respected", async () => {
    const token = {
      expiresAt: new Date(Date.now() + 120_000).toISOString(),
    } as Parameters<typeof isMcpTokenExpiringSoon>[0];
    expect(await isMcpTokenExpiringSoon(token, 60_000)).toBe(false);
    expect(await isMcpTokenExpiringSoon(token, 180_000)).toBe(true);
  });

  test("invalid date → treat as expiring", async () => {
    const token = { expiresAt: "not-a-date" } as Parameters<typeof isMcpTokenExpiringSoon>[0];
    expect(await isMcpTokenExpiringSoon(token)).toBe(true);
  });
});

describe("mcp_oauth_pending (state PK)", () => {
  test("insert → consume returns decrypted codeVerifier and deletes row", async () => {
    const server = await makeServer("mcp-pending-basic");
    await insertMcpOAuthPending({
      state: "state-1",
      mcpServerId: server.id,
      codeVerifier: "verifier-plain-1",
      resourceUrl: "https://mcp.example.com/",
      authorizationServerIssuer: "https://as.example.com",
      authorizeUrl: "https://as.example.com/authorize",
      tokenUrl: "https://as.example.com/token",
      redirectUri: "https://swarm.example.com/cb",
      dcrClientId: "client-abc",
      dcrClientSecret: "secret-xyz",
    });

    const consumed = await consumeMcpOAuthPending("state-1");
    expect(consumed).not.toBeNull();
    expect(consumed!.codeVerifier).toBe("verifier-plain-1");
    expect(consumed!.dcrClientSecret).toBe("secret-xyz");
    expect(consumed!.mcpServerId).toBe(server.id);

    // Second consume returns null (row deleted).
    expect(await consumeMcpOAuthPending("state-1")).toBeNull();
  });

  test("gcMcpOAuthPending deletes rows older than TTL", async () => {
    const server = await makeServer("mcp-pending-gc");
    await insertMcpOAuthPending({
      state: "state-gc-old",
      mcpServerId: server.id,
      codeVerifier: "v",
      resourceUrl: "https://mcp.example.com/",
      authorizationServerIssuer: "https://as.example.com",
      authorizeUrl: "https://as.example.com/authorize",
      tokenUrl: "https://as.example.com/token",
      redirectUri: "https://swarm.example.com/cb",
    });

    // Backdate createdAt via direct update.
    const { getDb } = require("../be/db");
    (await getDb())
      .query("UPDATE mcp_oauth_pending SET createdAt = ? WHERE state = ?")
      .run(new Date(Date.now() - 60 * 60_000).toISOString(), "state-gc-old");

    const deleted = await gcMcpOAuthPending(10 * 60_000);
    expect(deleted).toBeGreaterThanOrEqual(1);
    expect(await consumeMcpOAuthPending("state-gc-old")).toBeNull();
  });
});

describe("mcp_servers.authMethod accessor", () => {
  test("default is 'static' for newly created servers", async () => {
    const server = await makeServer("mcp-auth-default");
    expect(await getMcpServerAuthMethod(server.id)).toBe("static");
  });

  test("setMcpServerAuthMethod persists", async () => {
    const server = await makeServer("mcp-auth-set");
    await setMcpServerAuthMethod(server.id, "oauth");
    expect(await getMcpServerAuthMethod(server.id)).toBe("oauth");
    await setMcpServerAuthMethod(server.id, "static");
    expect(await getMcpServerAuthMethod(server.id)).toBe("static");
  });

  test("unknown server returns null", async () => {
    expect(await getMcpServerAuthMethod("00000000-0000-0000-0000-000000000000")).toBeNull();
  });
});
