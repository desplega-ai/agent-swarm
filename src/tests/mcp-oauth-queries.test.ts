import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import {
  closeDb,
  createMcpServer,
  createUser,
  getDbClient,
  getMcpServerById,
  initDb,
  updateMcpServer,
} from "../be/db";
import {
  applyMcpOAuthRefresh,
  consumeMcpOAuthPending,
  deleteMcpOAuthToken,
  findReusableMcpOAuthClient,
  gcMcpOAuthPending,
  getMcpOAuthToken,
  getMcpServerAuthMethod,
  insertMcpOAuthPending,
  invalidateMcpOAuthClient,
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
  test("upsert + read decrypts accessToken, refreshToken, dcrClientSecret", async () => {
    const server = await makeServer("mcp-enc-roundtrip");
    await upsertMcpOAuthToken(base(server.id));
    const token = await getMcpOAuthToken(server.id);

    expect(token).not.toBeNull();
    expect(token!.accessToken).toBe("access-123");
    expect(token!.refreshToken).toBe("refresh-456");
    expect(token!.dcrClientSecret).toBe("dcr-secret-xyz");
    expect(token!.tokenVersion).toBe(1);
    expect(token!.status).toBe("connected");
    const app = await getDbClient().get<{ source: string; metadata: string }>(
      "SELECT source, metadata FROM oauth_apps WHERE mcpServerId = ?",
      [server.id],
    );
    expect(app?.source).toBe("dcr");
    expect(JSON.parse(app?.metadata ?? "{}").clientSource).toBe("dcr");
  });

  test("access token is encrypted at rest (not stored plaintext)", async () => {
    const server = await makeServer("mcp-enc-at-rest");
    await upsertMcpOAuthToken({ ...base(server.id), accessToken: "UNIQUE_PLAINTEXT_TOKEN_ABC" });

    // Use raw SQL to inspect the row bypassing the decrypt helper.
    const row = (await getDbClient().get(
      `
        SELECT auth.accessToken
        FROM oauth_authorizations auth
        JOIN oauth_apps app ON app.id = auth.appId
        WHERE app.mcpServerId = ?
      `,
      [server.id],
    )) as { accessToken: string } | null;

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
      refreshToken: undefined,
      scope: "read",
    });
    const token = await getMcpOAuthToken(server.id);
    expect(token!.accessToken).toBe("access-updated");
    // COALESCE behaviour on refreshToken: not overridden when updater omits it
    // (we re-pass the same refresh above, so expect it intact).
    expect(token!.refreshToken).toBe("refresh-456");
  });

  test("refresh CAS uses the tokenVersion observed before the provider request", async () => {
    const server = await makeServer("mcp-refresh-cas");
    await upsertMcpOAuthToken(base(server.id));
    const observed = (await getMcpOAuthToken(server.id))!;

    await upsertMcpOAuthToken({
      ...base(server.id),
      accessToken: "concurrent-winner",
      refreshToken: "refresh-456",
    });

    await expect(
      applyMcpOAuthRefresh(observed.id, {
        accessToken: "stale-refresh-result",
        refreshToken: "stale-refresh-token",
        expectedTokenVersion: observed.tokenVersion,
      }),
    ).rejects.toThrow(/token version changed during refresh/);
    expect(await getMcpOAuthToken(server.id)).toMatchObject({
      accessToken: "concurrent-winner",
      refreshToken: "refresh-456",
    });
  });
});

describe("markMcpOAuthTokenStatus + deleteMcpOAuthToken", () => {
  test("status flip writes status and error message", async () => {
    const server = await makeServer("mcp-status-flip");
    await upsertMcpOAuthToken(base(server.id));
    const original = (await getMcpOAuthToken(server.id))!;
    await markMcpOAuthTokenStatus(original.id, "expired", "refresh token missing");

    const updated = (await getMcpOAuthToken(server.id))!;
    expect(updated.status).toBe("expired");
    expect(updated.lastErrorMessage).toBe("refresh token missing");
  });

  test("disconnect revokes in place and reconnect reuses the authorization id", async () => {
    const server = await makeServer("mcp-revoke-row");
    await upsertMcpOAuthToken(base(server.id));
    const original = (await getMcpOAuthToken(server.id))!;
    expect(await deleteMcpOAuthToken(server.id)).toBe(true);
    expect(await getMcpOAuthToken(server.id)).toMatchObject({
      id: original.id,
      accessToken: "",
      refreshToken: null,
      expiresAt: null,
      scope: null,
      status: "revoked",
    });

    await upsertMcpOAuthToken({
      ...base(server.id),
      accessToken: "reconnected-access",
      refreshToken: "reconnected-refresh",
    });
    expect(await getMcpOAuthToken(server.id)).toMatchObject({
      id: original.id,
      accessToken: "reconnected-access",
      refreshToken: "reconnected-refresh",
      status: "connected",
    });
  });

  test("listMcpOAuthTokensForMcp returns multiple user rows", async () => {
    const server = await makeServer("mcp-multi-user");
    const userA = await createUser({ name: "user-a" });
    const userB = await createUser({ name: "user-b" });
    await upsertMcpOAuthToken({
      ...base(server.id),
      userId: userA.id,
      resourceUrl: "https://user-a.example.com",
    });
    await upsertMcpOAuthToken({
      ...base(server.id),
      userId: userB.id,
      resourceUrl: "https://user-b.example.com",
    });
    const rows = await listMcpOAuthTokensForMcp(server.id);
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
    expect(
      (
        await getDbClient().get<{ count: number }>(
          "SELECT count(*) AS count FROM oauth_apps WHERE mcpServerId = ?",
          [server.id],
        )
      )?.count,
    ).toBe(0);
  });

  test("concurrent pending states preserve independent AS context", async () => {
    const server = await makeServer("mcp-pending-concurrent");
    for (const suffix of ["a", "b"]) {
      await insertMcpOAuthPending({
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

    expect(await consumeMcpOAuthPending("state-b")).toMatchObject({
      resourceUrl: "https://resource-b.example.com",
      tokenUrl: "https://issuer-b.example.com/token",
      dcrClientId: "client-b",
      dcrClientSecret: "secret-b",
    });
    expect(await consumeMcpOAuthPending("state-a")).toMatchObject({
      resourceUrl: "https://resource-a.example.com",
      tokenUrl: "https://issuer-a.example.com/token",
      dcrClientId: "client-a",
      dcrClientSecret: "secret-a",
    });
  });

  test("pending authorization does not mutate a connected app", async () => {
    const server = await makeServer("mcp-pending-connected");
    await upsertMcpOAuthToken(base(server.id));
    await insertMcpOAuthPending({
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

    expect(await getMcpOAuthToken(server.id)).toMatchObject({
      resourceUrl: "https://mcp.example.com/",
      tokenUrl: "https://as.example.com/token",
      dcrClientId: "client-abc",
    });
    expect(await consumeMcpOAuthPending("state-reconnect")).toMatchObject({
      resourceUrl: "https://replacement-resource.example.com",
      tokenUrl: "https://replacement-issuer.example.com/token",
      dcrClientId: "replacement-client",
    });
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
    await getDbClient().run(
      "UPDATE oauth_pending SET createdAt = ? WHERE state = ? AND flow = 'mcp'",
      [new Date(Date.now() - 60 * 60_000).toISOString(), "state-gc-old"],
    );

    const deleted = await gcMcpOAuthPending(10 * 60_000);
    expect(deleted).toBeGreaterThanOrEqual(1);
    expect(await consumeMcpOAuthPending("state-gc-old")).toBeNull();
    expect(
      (
        await getDbClient().get<{ count: number }>(
          "SELECT count(*) AS count FROM oauth_apps WHERE mcpServerId = ?",
          [server.id],
        )
      )?.count,
    ).toBe(0);
  });
});

describe("findReusableMcpOAuthClient / invalidateMcpOAuthClient", () => {
  test("returns null when nothing has ever been registered", async () => {
    const server = await makeServer("mcp-reuse-none");
    expect(await findReusableMcpOAuthClient(server.id)).toBeNull();
  });

  test("reuses a connected token's DCR client (re-authorize case)", async () => {
    const server = await makeServer("mcp-reuse-connected");
    await upsertMcpOAuthToken({
      ...base(server.id),
      authorizationServerIssuer: "https://issuer.example.com",
      registrationEndpoint: "https://issuer.example.com/register",
    });

    const reusable = await findReusableMcpOAuthClient(server.id);
    expect(reusable).toMatchObject({
      clientId: "client-abc",
      clientSecret: "dcr-secret-xyz",
      authorizationServerIssuer: "https://issuer.example.com",
      registrationEndpoint: "https://issuer.example.com/register",
      clientSource: "dcr",
    });
  });

  test("upsertMcpOAuthToken persists redirectUri onto the app row (first-connect reuse case)", async () => {
    const server = await makeServer("mcp-reuse-connected-redirect-uri");
    // Before this fix, upsertMcpOAuthToken never passed redirectUri through
    // to upsertMcpApp, so the FIRST successful connect (which always creates
    // a brand new oauth_apps row here, since the pending row's app was
    // already deleted as an orphan by consumeMcpOAuthPending) left
    // redirectUri as "" — silently failing every subsequent
    // `reusable.redirectUri === callbackRedirectUri()` reuse check and
    // forcing a fresh DCR registration on every re-authorize.
    await upsertMcpOAuthToken({
      ...base(server.id),
      redirectUri: "https://swarm.example.com/api/mcp-oauth/callback",
    });

    const reusable = await findReusableMcpOAuthClient(server.id);
    expect(reusable?.redirectUri).toBe("https://swarm.example.com/api/mcp-oauth/callback");
  });

  test("reuses a still-live pending's client when no token exists yet", async () => {
    const server = await makeServer("mcp-reuse-pending");
    await insertMcpOAuthPending({
      state: "reuse-pending-state",
      mcpServerId: server.id,
      codeVerifier: "verifier",
      resourceUrl: "https://mcp.example.com/",
      authorizationServerIssuer: "https://issuer.example.com",
      registrationEndpoint: "https://issuer.example.com/register",
      authorizeUrl: "https://issuer.example.com/authorize",
      tokenUrl: "https://issuer.example.com/token",
      dcrClientId: "pending-client",
      dcrClientSecret: "pending-secret",
      redirectUri: "https://swarm.example.com/cb",
    });

    // The pending row itself is still live (not consumed/GC'd) — a second
    // authorize attempt before completion must see the same client.
    const reusable = await findReusableMcpOAuthClient(server.id);
    expect(reusable).toMatchObject({
      clientId: "pending-client",
      clientSecret: "pending-secret",
      authorizationServerIssuer: "https://issuer.example.com",
      registrationEndpoint: "https://issuer.example.com/register",
    });

    // A second pending attempt for the same connector+user reuses the same
    // underlying app row instead of creating a new one (row-churn guard).
    const before = (
      await getDbClient().get<{ count: number }>(
        "SELECT count(*) AS count FROM oauth_apps WHERE mcpServerId = ?",
        [server.id],
      )
    )?.count;
    await insertMcpOAuthPending({
      state: "reuse-pending-state-2",
      mcpServerId: server.id,
      codeVerifier: "verifier-2",
      resourceUrl: "https://mcp.example.com/",
      authorizationServerIssuer: "https://issuer.example.com",
      registrationEndpoint: "https://issuer.example.com/register",
      authorizeUrl: "https://issuer.example.com/authorize",
      tokenUrl: "https://issuer.example.com/token",
      dcrClientId: "pending-client",
      dcrClientSecret: "pending-secret",
      redirectUri: "https://swarm.example.com/cb",
    });
    const after = (
      await getDbClient().get<{ count: number }>(
        "SELECT count(*) AS count FROM oauth_apps WHERE mcpServerId = ?",
        [server.id],
      )
    )?.count;
    expect(after).toBe(before);
  });

  test("manual clientSource is never surfaced through the reuse path", async () => {
    const server = await makeServer("mcp-reuse-manual");
    await upsertMcpOAuthToken({ ...base(server.id), clientSource: "manual" });
    expect(await findReusableMcpOAuthClient(server.id)).toBeNull();
  });

  test("invalidate flips the flag; a subsequent lookup misses until the next legitimate write", async () => {
    const server = await makeServer("mcp-reuse-invalidate");
    await upsertMcpOAuthToken(base(server.id));
    expect(await findReusableMcpOAuthClient(server.id)).not.toBeNull();

    await invalidateMcpOAuthClient(server.id);
    expect(await findReusableMcpOAuthClient(server.id)).toBeNull();

    // A fresh legitimate write (e.g. re-registering after invalidation)
    // clears the flag again.
    await upsertMcpOAuthToken({ ...base(server.id), accessToken: "fresh-access" });
    expect(await findReusableMcpOAuthClient(server.id)).not.toBeNull();
  });

  test("invalidate on an unknown connector is a no-op", async () => {
    await expect(
      invalidateMcpOAuthClient("00000000-0000-0000-0000-000000000000"),
    ).resolves.toBeUndefined();
  });

  test("invalidate is idempotent for an already-invalidated client", async () => {
    const server = await makeServer("mcp-reuse-invalidate-idempotent");
    await upsertMcpOAuthToken(base(server.id));

    await invalidateMcpOAuthClient(server.id);
    expect(await findReusableMcpOAuthClient(server.id)).toBeNull();

    // A second invalidate call against the SAME still-invalidated client
    // must not throw and must not disturb the invalidated state (this is
    // what "cap invalidation to once per client_id" means in practice — the
    // other call sites can all observe the same failure and each call this,
    // but only the first one actually does anything).
    await expect(invalidateMcpOAuthClient(server.id)).resolves.toBeUndefined();
    expect(await findReusableMcpOAuthClient(server.id)).toBeNull();
  });

  test("disconnect clears the stored DCR client so Reconnect forces a fresh registration", async () => {
    const server = await makeServer("mcp-disconnect-clears-client");
    await upsertMcpOAuthToken(base(server.id));
    expect(await findReusableMcpOAuthClient(server.id)).not.toBeNull();

    expect(await deleteMcpOAuthToken(server.id)).toBe(true);

    // Disconnect is the canonical user recovery gesture — before this fix,
    // deleteMcpOAuthToken only soft-revoked oauth_authorizations and left
    // oauth_apps untouched, so a Reconnect silently got the same client_id
    // back (rawMcpToken has no status filter).
    expect(await findReusableMcpOAuthClient(server.id)).toBeNull();
  });
});

describe("mcp_servers.extraAuthorizeParams round-trip", () => {
  test("createMcpServer persists extraAuthorizeParams", async () => {
    const server = await createMcpServer({
      name: "bigquery-mcp",
      transport: "http",
      url: "https://bigquery.googleapis.com/",
      scope: "swarm",
      extraAuthorizeParams: '{"access_type":"offline","prompt":"consent"}',
    });
    expect(server.extraAuthorizeParams).toBe('{"access_type":"offline","prompt":"consent"}');

    const fetched = await getMcpServerById(server.id);
    expect(fetched).not.toBeNull();
    expect(fetched!.extraAuthorizeParams).toBe('{"access_type":"offline","prompt":"consent"}');
  });

  test("createMcpServer with no extraAuthorizeParams defaults to null", async () => {
    const server = await createMcpServer({
      name: "hubspot-mcp",
      transport: "http",
      url: "https://api.hubspot.com/",
      scope: "swarm",
    });
    expect(server.extraAuthorizeParams).toBeNull();
  });

  test("updateMcpServer persists extraAuthorizeParams and bumps version", async () => {
    const server = await createMcpServer({
      name: "gdrive-mcp",
      transport: "http",
      url: "https://www.googleapis.com/drive/v3/",
      scope: "swarm",
    });
    const versionBefore = server.version;

    const updated = await updateMcpServer(server.id, {
      extraAuthorizeParams: '{"access_type":"offline","prompt":"consent"}',
    });
    expect(updated).not.toBeNull();
    expect(updated!.extraAuthorizeParams).toBe('{"access_type":"offline","prompt":"consent"}');
    expect(updated!.version).toBe(versionBefore + 1);
  });

  test("updateMcpServer can clear extraAuthorizeParams to null without bumping version twice", async () => {
    const server = await createMcpServer({
      name: "sheets-mcp",
      transport: "http",
      url: "https://sheets.googleapis.com/",
      scope: "swarm",
      extraAuthorizeParams: '{"access_type":"offline"}',
    });

    const cleared = await updateMcpServer(server.id, { extraAuthorizeParams: undefined });
    // No extraAuthorizeParams key → no version bump, field untouched
    expect(cleared!.extraAuthorizeParams).toBe('{"access_type":"offline"}');
    expect(cleared!.version).toBe(server.version);

    const nulled = await updateMcpServer(server.id, {
      extraAuthorizeParams: null as unknown as string,
    });
    expect(nulled!.extraAuthorizeParams).toBeNull();
    expect(nulled!.version).toBe(server.version + 1);
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
