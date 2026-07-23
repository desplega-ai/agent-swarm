import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import {
  closeDb,
  createMcpServer,
  createUser,
  getDb,
  getMcpServerById,
  initDb,
  updateMcpServer,
} from "../be/db";
import {
  applyMcpOAuthRefresh,
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

beforeAll(() => {
  initDb(TEST_DB_PATH);
});

afterAll(async () => {
  closeDb();
  for (const suffix of ["", "-wal", "-shm"]) {
    await unlink(`${TEST_DB_PATH}${suffix}`).catch(() => {});
  }
});

function makeServer(name: string) {
  return createMcpServer({
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
  test("upsert + read decrypts accessToken, refreshToken, dcrClientSecret", () => {
    const server = makeServer("mcp-enc-roundtrip");
    upsertMcpOAuthToken(base(server.id));
    const token = getMcpOAuthToken(server.id);

    expect(token).not.toBeNull();
    expect(token!.accessToken).toBe("access-123");
    expect(token!.refreshToken).toBe("refresh-456");
    expect(token!.dcrClientSecret).toBe("dcr-secret-xyz");
    expect(token!.tokenVersion).toBe(1);
    expect(token!.status).toBe("connected");
    const app = getDb()
      .query<{ source: string; metadata: string }, []>(
        "SELECT source, metadata FROM oauth_apps WHERE mcpServerId = ?",
      )
      .get(server.id);
    expect(app?.source).toBe("dcr");
    expect(JSON.parse(app?.metadata ?? "{}").clientSource).toBe("dcr");
  });

  test("access token is encrypted at rest (not stored plaintext)", async () => {
    const server = makeServer("mcp-enc-at-rest");
    upsertMcpOAuthToken({ ...base(server.id), accessToken: "UNIQUE_PLAINTEXT_TOKEN_ABC" });

    // Use raw SQL to inspect the row bypassing the decrypt helper.
    const { getDb } = await import("../be/db");
    const row = getDb()
      .query(`
        SELECT auth.accessToken
        FROM oauth_authorizations auth
        JOIN oauth_apps app ON app.id = auth.appId
        WHERE app.mcpServerId = ?
      `)
      .get(server.id) as { accessToken: string } | null;

    expect(row).not.toBeNull();
    expect(row!.accessToken).not.toBe("UNIQUE_PLAINTEXT_TOKEN_ABC");
    expect(row!.accessToken.length).toBeGreaterThan(24);
  });

  test("upsert conflict updates by (mcpServerId, userId)", () => {
    const server = makeServer("mcp-upsert-conflict");
    upsertMcpOAuthToken(base(server.id));
    upsertMcpOAuthToken({
      ...base(server.id),
      accessToken: "access-updated",
      refreshToken: undefined,
      scope: "read",
    });
    const token = getMcpOAuthToken(server.id);
    expect(token!.accessToken).toBe("access-updated");
    // COALESCE behaviour on refreshToken: not overridden when updater omits it
    // (we re-pass the same refresh above, so expect it intact).
    expect(token!.refreshToken).toBe("refresh-456");
  });

  test("refresh CAS uses the tokenVersion observed before the provider request", () => {
    const server = makeServer("mcp-refresh-cas");
    upsertMcpOAuthToken(base(server.id));
    const observed = getMcpOAuthToken(server.id)!;

    upsertMcpOAuthToken({
      ...base(server.id),
      accessToken: "concurrent-winner",
      refreshToken: "refresh-456",
    });

    expect(() =>
      applyMcpOAuthRefresh(observed.id, {
        accessToken: "stale-refresh-result",
        refreshToken: "stale-refresh-token",
        expectedTokenVersion: observed.tokenVersion,
      }),
    ).toThrow(/token version changed during refresh/);
    expect(getMcpOAuthToken(server.id)).toMatchObject({
      accessToken: "concurrent-winner",
      refreshToken: "refresh-456",
    });
  });
});

describe("markMcpOAuthTokenStatus + deleteMcpOAuthToken", () => {
  test("status flip writes status and error message", () => {
    const server = makeServer("mcp-status-flip");
    upsertMcpOAuthToken(base(server.id));
    const original = getMcpOAuthToken(server.id)!;
    markMcpOAuthTokenStatus(original.id, "expired", "refresh token missing");

    const updated = getMcpOAuthToken(server.id)!;
    expect(updated.status).toBe("expired");
    expect(updated.lastErrorMessage).toBe("refresh token missing");
  });

  test("disconnect revokes in place and reconnect reuses the authorization id", () => {
    const server = makeServer("mcp-revoke-row");
    upsertMcpOAuthToken(base(server.id));
    const original = getMcpOAuthToken(server.id)!;
    expect(deleteMcpOAuthToken(server.id)).toBe(true);
    expect(getMcpOAuthToken(server.id)).toMatchObject({
      id: original.id,
      accessToken: "",
      refreshToken: null,
      expiresAt: null,
      scope: null,
      status: "revoked",
    });

    upsertMcpOAuthToken({
      ...base(server.id),
      accessToken: "reconnected-access",
      refreshToken: "reconnected-refresh",
    });
    expect(getMcpOAuthToken(server.id)).toMatchObject({
      id: original.id,
      accessToken: "reconnected-access",
      refreshToken: "reconnected-refresh",
      status: "connected",
    });
  });

  test("listMcpOAuthTokensForMcp returns multiple user rows", () => {
    const server = makeServer("mcp-multi-user");
    const userA = createUser({ name: "user-a" });
    const userB = createUser({ name: "user-b" });
    upsertMcpOAuthToken({
      ...base(server.id),
      userId: userA.id,
      resourceUrl: "https://user-a.example.com",
    });
    upsertMcpOAuthToken({
      ...base(server.id),
      userId: userB.id,
      resourceUrl: "https://user-b.example.com",
    });
    const rows = listMcpOAuthTokensForMcp(server.id);
    expect(rows.length).toBe(2);
    expect(new Set(rows.map((r) => r.userId))).toEqual(new Set([userA.id, userB.id]));
    expect(rows.find((row) => row.userId === userA.id)?.resourceUrl).toBe(
      "https://user-a.example.com",
    );
    expect(rows.find((row) => row.userId === userB.id)?.resourceUrl).toBe(
      "https://user-b.example.com",
    );
  });
});

describe("isMcpTokenExpiringSoon", () => {
  test("expiresAt null → not expiring (long-lived token)", () => {
    const token = {
      expiresAt: null,
    } as Parameters<typeof isMcpTokenExpiringSoon>[0];
    expect(isMcpTokenExpiringSoon(token)).toBe(false);
  });

  test("far future → not expiring", () => {
    const token = {
      expiresAt: new Date(Date.now() + 24 * 3600_000).toISOString(),
    } as Parameters<typeof isMcpTokenExpiringSoon>[0];
    expect(isMcpTokenExpiringSoon(token)).toBe(false);
  });

  test("within default 5-min buffer → expiring", () => {
    const token = {
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    } as Parameters<typeof isMcpTokenExpiringSoon>[0];
    expect(isMcpTokenExpiringSoon(token)).toBe(true);
  });

  test("custom buffer respected", () => {
    const token = {
      expiresAt: new Date(Date.now() + 120_000).toISOString(),
    } as Parameters<typeof isMcpTokenExpiringSoon>[0];
    expect(isMcpTokenExpiringSoon(token, 60_000)).toBe(false);
    expect(isMcpTokenExpiringSoon(token, 180_000)).toBe(true);
  });

  test("invalid date → treat as expiring", () => {
    const token = { expiresAt: "not-a-date" } as Parameters<typeof isMcpTokenExpiringSoon>[0];
    expect(isMcpTokenExpiringSoon(token)).toBe(true);
  });
});

describe("mcp_oauth_pending (state PK)", () => {
  test("insert → consume returns decrypted codeVerifier and deletes row", () => {
    const server = makeServer("mcp-pending-basic");
    insertMcpOAuthPending({
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

    const consumed = consumeMcpOAuthPending("state-1");
    expect(consumed).not.toBeNull();
    expect(consumed!.codeVerifier).toBe("verifier-plain-1");
    expect(consumed!.dcrClientSecret).toBe("secret-xyz");
    expect(consumed!.mcpServerId).toBe(server.id);

    // Second consume returns null (row deleted).
    expect(consumeMcpOAuthPending("state-1")).toBeNull();
    expect(
      getDb()
        .query<{ count: number }, []>(
          "SELECT count(*) AS count FROM oauth_apps WHERE mcpServerId = ?",
        )
        .get(server.id)?.count,
    ).toBe(0);
  });

  test("concurrent pending states preserve independent AS context", () => {
    const server = makeServer("mcp-pending-concurrent");
    for (const suffix of ["a", "b"]) {
      insertMcpOAuthPending({
        state: `state-${suffix}`,
        mcpServerId: server.id,
        codeVerifier: `verifier-${suffix}`,
        resourceUrl: `https://resource-${suffix}.example.com`,
        authorizationServerIssuer: `https://issuer-${suffix}.example.com`,
        authorizeUrl: `https://issuer-${suffix}.example.com/authorize`,
        tokenUrl: `https://issuer-${suffix}.example.com/token`,
        dcrClientId: `client-${suffix}`,
        dcrClientSecret: `secret-${suffix}`,
        redirectUri: "https://swarm.example.com/cb",
      });
    }

    expect(consumeMcpOAuthPending("state-b")).toMatchObject({
      resourceUrl: "https://resource-b.example.com",
      tokenUrl: "https://issuer-b.example.com/token",
      dcrClientId: "client-b",
      dcrClientSecret: "secret-b",
    });
    expect(consumeMcpOAuthPending("state-a")).toMatchObject({
      resourceUrl: "https://resource-a.example.com",
      tokenUrl: "https://issuer-a.example.com/token",
      dcrClientId: "client-a",
      dcrClientSecret: "secret-a",
    });
  });

  test("pending authorization does not mutate a connected app", () => {
    const server = makeServer("mcp-pending-connected");
    upsertMcpOAuthToken(base(server.id));
    insertMcpOAuthPending({
      state: "state-reconnect",
      mcpServerId: server.id,
      codeVerifier: "reconnect-verifier",
      resourceUrl: "https://replacement-resource.example.com",
      authorizationServerIssuer: "https://replacement-issuer.example.com",
      authorizeUrl: "https://replacement-issuer.example.com/authorize",
      tokenUrl: "https://replacement-issuer.example.com/token",
      dcrClientId: "replacement-client",
      dcrClientSecret: "replacement-secret",
      redirectUri: "https://swarm.example.com/cb",
    });

    expect(getMcpOAuthToken(server.id)).toMatchObject({
      resourceUrl: "https://mcp.example.com/",
      tokenUrl: "https://as.example.com/token",
      dcrClientId: "client-abc",
    });
    expect(consumeMcpOAuthPending("state-reconnect")).toMatchObject({
      resourceUrl: "https://replacement-resource.example.com",
      tokenUrl: "https://replacement-issuer.example.com/token",
      dcrClientId: "replacement-client",
    });
  });

  test("gcMcpOAuthPending deletes rows older than TTL", () => {
    const server = makeServer("mcp-pending-gc");
    insertMcpOAuthPending({
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
    getDb()
      .query("UPDATE oauth_pending SET createdAt = ? WHERE state = ? AND flow = 'mcp'")
      .run(new Date(Date.now() - 60 * 60_000).toISOString(), "state-gc-old");

    const deleted = gcMcpOAuthPending(10 * 60_000);
    expect(deleted).toBeGreaterThanOrEqual(1);
    expect(consumeMcpOAuthPending("state-gc-old")).toBeNull();
    expect(
      getDb()
        .query<{ count: number }, []>(
          "SELECT count(*) AS count FROM oauth_apps WHERE mcpServerId = ?",
        )
        .get(server.id)?.count,
    ).toBe(0);
  });
});

describe("mcp_servers.extraAuthorizeParams round-trip", () => {
  test("createMcpServer persists extraAuthorizeParams", () => {
    const server = createMcpServer({
      name: "bigquery-mcp",
      transport: "http",
      url: "https://bigquery.googleapis.com/",
      scope: "swarm",
      extraAuthorizeParams: '{"access_type":"offline","prompt":"consent"}',
    });
    expect(server.extraAuthorizeParams).toBe('{"access_type":"offline","prompt":"consent"}');

    const fetched = getMcpServerById(server.id);
    expect(fetched).not.toBeNull();
    expect(fetched!.extraAuthorizeParams).toBe('{"access_type":"offline","prompt":"consent"}');
  });

  test("createMcpServer with no extraAuthorizeParams defaults to null", () => {
    const server = createMcpServer({
      name: "hubspot-mcp",
      transport: "http",
      url: "https://api.hubspot.com/",
      scope: "swarm",
    });
    expect(server.extraAuthorizeParams).toBeNull();
  });

  test("updateMcpServer persists extraAuthorizeParams and bumps version", () => {
    const server = createMcpServer({
      name: "gdrive-mcp",
      transport: "http",
      url: "https://www.googleapis.com/drive/v3/",
      scope: "swarm",
    });
    const versionBefore = server.version;

    const updated = updateMcpServer(server.id, {
      extraAuthorizeParams: '{"access_type":"offline","prompt":"consent"}',
    });
    expect(updated).not.toBeNull();
    expect(updated!.extraAuthorizeParams).toBe('{"access_type":"offline","prompt":"consent"}');
    expect(updated!.version).toBe(versionBefore + 1);
  });

  test("updateMcpServer can clear extraAuthorizeParams to null without bumping version twice", () => {
    const server = createMcpServer({
      name: "sheets-mcp",
      transport: "http",
      url: "https://sheets.googleapis.com/",
      scope: "swarm",
      extraAuthorizeParams: '{"access_type":"offline"}',
    });

    const cleared = updateMcpServer(server.id, { extraAuthorizeParams: undefined });
    // No extraAuthorizeParams key → no version bump, field untouched
    expect(cleared!.extraAuthorizeParams).toBe('{"access_type":"offline"}');
    expect(cleared!.version).toBe(server.version);

    const nulled = updateMcpServer(server.id, { extraAuthorizeParams: null as unknown as string });
    expect(nulled!.extraAuthorizeParams).toBeNull();
    expect(nulled!.version).toBe(server.version + 1);
  });
});

describe("mcp_servers.authMethod accessor", () => {
  test("default is 'static' for newly created servers", () => {
    const server = makeServer("mcp-auth-default");
    expect(getMcpServerAuthMethod(server.id)).toBe("static");
  });

  test("setMcpServerAuthMethod persists", () => {
    const server = makeServer("mcp-auth-set");
    setMcpServerAuthMethod(server.id, "oauth");
    expect(getMcpServerAuthMethod(server.id)).toBe("oauth");
    setMcpServerAuthMethod(server.id, "static");
    expect(getMcpServerAuthMethod(server.id)).toBe("static");
  });

  test("unknown server returns null", () => {
    expect(getMcpServerAuthMethod("00000000-0000-0000-0000-000000000000")).toBeNull();
  });
});
