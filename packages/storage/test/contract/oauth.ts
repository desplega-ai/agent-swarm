import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  jsonText,
  type OAuthAppWrite,
  type OAuthAuthorizationWrite,
  type OAuthRepository,
  type Storage,
  sql,
} from "../../src";
import type { ContractEngine } from "./env";

const T0 = "2026-11-21T10:00:00.000Z";
const ISO_MS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function appWrite(overrides: Partial<OAuthAppWrite> = {}): OAuthAppWrite {
  return {
    displayName: null,
    clientId: "cid",
    clientSecretCiphertext: "enc-secret",
    authorizeUrl: "https://p/authorize",
    tokenUrl: "https://p/token",
    revocationUrl: null,
    userinfoUrl: null,
    redirectUri: "https://swarm/cb",
    scopes: '["read"]',
    scopeSeparator: " ",
    tokenAuthStyle: "body",
    tokenBodyFormat: "form",
    requiresRefreshTokenRotation: false,
    extraParamsJson: null,
    source: "manual",
    metadata: "{}",
    ...overrides,
  };
}

function authWrite(overrides: Partial<OAuthAuthorizationWrite> = {}): OAuthAuthorizationWrite {
  return {
    userId: null,
    accountEmail: null,
    identityJson: null,
    accessToken: "enc-access",
    refreshToken: "enc-refresh",
    tokenType: "Bearer",
    expiresAt: null,
    scope: null,
    status: "active",
    lastErrorMessage: null,
    lastRefreshedAt: null,
    connectedByUserId: null,
    ...overrides,
  };
}

export function oauthContract(engine: ContractEngine): void {
  describe(`oauth repository [${engine.name}]`, () => {
    let storage: Storage;
    let repo: OAuthRepository;

    beforeEach(async () => {
      storage = await engine.fresh();
      repo = storage.repos.oauth;
    });
    afterEach(async () => {
      await engine.release(storage);
    });

    const setAppCreatedAt = (id: string, createdAt: string) =>
      storage.executor.run(sql`UPDATE oauth_apps SET "createdAt" = ${createdAt} WHERE id = ${id}`);
    const addAuth = (id: string, appId: string, label = "default", extra = {}) =>
      repo.insertAuthorization({ id, appId, label, ...authWrite(extra) });

    test("insertApp stores flags, defaults and the value shape; updateApp rewrites it", async () => {
      const id = await repo.insertApp("linear", appWrite({ requiresRefreshTokenRotation: true }));
      const row = await repo.findAppById(id);
      expect(row).toMatchObject({
        id,
        provider: "linear",
        clientSecret: "enc-secret",
        clientSecretEncrypted: 1,
        requiresRefreshTokenRotation: 1,
        mcpServerId: null,
        metadata: "{}",
      });
      expect(row?.createdAt).toMatch(ISO_MS);
      await repo.updateApp(id, appWrite({ clientId: "c2", requiresRefreshTokenRotation: false }));
      expect(await repo.findProviderAppById(id)).toMatchObject({
        clientId: "c2",
        requiresRefreshTokenRotation: 0,
      });
      expect(await repo.findAppById("missing")).toBeNull();
    });

    test("provider lookups pick the oldest app; metadata reads the first-inserted row", async () => {
      const newer = await repo.insertApp("jira", appWrite({ metadata: '{"n":1}' }));
      const older = await repo.insertApp("jira", appWrite({ metadata: '{"n":2}' }));
      await setAppCreatedAt(newer, "2026-02-01T00:00:00.000Z");
      await setAppCreatedAt(older, "2026-01-01T00:00:00.000Z");
      expect((await repo.findAppByProvider("jira"))?.id).toBe(older);
      expect(await repo.getAppMetadata("jira")).toEqual({ metadata: '{"n":1}' });
      expect(await repo.getAppMetadata("none")).toBeNull();
      await repo.setAppMetadata("jira", '{"x":true}');
      expect((await repo.findAppById(newer))?.metadata).toBe('{"x":true}');
      expect((await repo.findAppById(older))?.metadata).toBe('{"x":true}');
      expect((await repo.listApps()).map((row) => row.id)).toEqual([newer, older]);
      await addAuth("z-new", newer);
      await addAuth("z-old", older);
      expect((await repo.findDefaultAuthorizationForProvider("jira"))?.id).toBe("z-old");
      expect((await repo.findDefaultAuthorizationForApp(newer))?.id).toBe("z-new");
    });

    test("authorization writes: insert, rewrite, refresh with version check, revoke", async () => {
      const appId = await repo.insertApp("github", appWrite());
      await addAuth("a1", appId);
      const row = await repo.findAuthorization("a1");
      expect(row).toMatchObject({
        id: "a1",
        appId,
        label: "default",
        tokensEncrypted: 1,
        tokenVersion: 1,
        status: "active",
      });
      await repo.rewriteAuthorization("a1", authWrite({ accessToken: "enc-2", status: "expired" }));
      expect(await repo.findAuthorization("a1")).toMatchObject({
        accessToken: "enc-2",
        tokenVersion: 2,
        status: "expired",
      });
      const tokens = { accessToken: "enc-3", refreshToken: null, expiresAt: null, scope: "s" };
      expect(await repo.storeRefreshedTokens("a1", 1, tokens)).toBe(false);
      expect(await repo.storeRefreshedTokens("a1", 2, tokens)).toBe(true);
      const refreshed = await repo.findAuthorization("a1");
      expect(refreshed).toMatchObject({ tokenVersion: 3, status: "active", scope: "s" });
      expect(refreshed?.lastRefreshedAt).toMatch(ISO_MS);
      await repo.setAuthorizationIdentity("a1", { accountEmail: "a@b", identityJson: "{}" });
      expect((await repo.findAuthorization("a1"))?.accountEmail).toBe("a@b");
      expect(await repo.markRefreshFailed("a1", "boom")).toBe(true);
      await repo.revokeAuthorization("a1", "enc-empty");
      expect(await repo.findAuthorization("a1")).toMatchObject({
        accessToken: "enc-empty",
        refreshToken: null,
        status: "revoked",
        tokenVersion: 4,
        lastErrorMessage: null,
      });
      expect(await repo.markRefreshFailed("a1", "again")).toBe(false);
      expect(await repo.findAuthorizationIdByLabel(appId, "default")).toBe("a1");
      expect(await repo.findAuthorizationIdByLabel(appId, "other")).toBeNull();
      expect(await repo.deleteAuthorization("a1")).toBe(true);
      expect(await repo.deleteAuthorization("a1")).toBe(false);
    });

    test("authorization lists keep their documented orders", async () => {
      const b = await repo.insertApp("b-prov", appWrite());
      const a1 = await repo.insertApp("a-prov", appWrite({ requiresRefreshTokenRotation: true }));
      const a2 = await repo.insertApp("a-prov", appWrite({ metadata: '{"keepAlive":true}' }));
      await addAuth("z3", a2, "default");
      await addAuth("z1", b, "default");
      await addAuth("z2", a1, "default");
      await addAuth("z4", a1, "alt", { refreshToken: null });
      await storage.executor.run(
        sql`UPDATE oauth_authorizations SET "createdAt" = '2026-01-01T00:00:00.000Z'`,
      );
      expect((await repo.listAuthorizationsForApp(a1)).map((row) => row.id)).toEqual(["z2", "z4"]);
      expect((await repo.listAuthorizationsWithProvider()).map((row) => row.id)).toEqual([
        "z3",
        "z1",
        "z2",
        "z4",
      ]);
      expect(await repo.listAuthorizationProviders()).toEqual([
        "a-prov",
        "a-prov",
        "a-prov",
        "b-prov",
      ]);
      const sweep = await repo.listSweepRows();
      expect(sweep.map((row) => row.authorizationId)).toEqual(["z4", "z2", "z3", "z1"]);
      expect(sweep.find((row) => row.authorizationId === "z4")).toMatchObject({
        hasRefreshToken: 0,
        expiresAt: "",
      });
      expect((await repo.listKeepAliveRows()).map((row) => row.authorizationId)).toEqual([
        "z2",
        "z3",
      ]);
      expect(await repo.deleteAuthorizationsForApp(a1)).toBe(2);
    });

    test("keep-alive metadata values, sweep expiry text and clock-written updatedAt", async () => {
      const kinds: [string, string][] = [
        ["k-true", '{"keepAlive":true}'],
        ["k-one", '{"keepAlive":1}'],
        ["k-text", '{"keepAlive":"true"}'],
        ["k-text-one", '{"keepAlive":"1"}'],
        ["k-false", '{"keepAlive":false}'],
        ["k-none", "{}"],
      ];
      for (const [provider, metadata] of kinds) {
        const appId = await repo.insertApp(provider, appWrite({ metadata }));
        await addAuth(provider, appId, "default", { expiresAt: "2026-11-21T10:00:00.123Z" });
      }
      expect((await repo.listKeepAliveRows()).map((row) => row.authorizationId)).toEqual([
        "k-one",
        "k-text",
        "k-true",
      ]);
      expect((await repo.listSweepRows()).map((row) => row.expiresAt)).toEqual(
        kinds.map(() => "2026-11-21T10:00:00.123Z"),
      );
      await storage.executor.run(sql`UPDATE oauth_authorizations SET "updatedAt" = 'legacy'`);
      await repo.setAuthorizationStatus("k-one", "active", null);
      expect((await repo.findAuthorization("k-one"))?.updatedAt).toMatch(ISO_MS);
      await repo.setAppMetadata("k-none", '{"keepAlive":true}');
      const app = await repo.findAppByProvider("k-none");
      expect(app?.metadata).toBe('{"keepAlive":true}');
      expect(app?.updatedAt).toMatch(ISO_MS);
    });

    test("pending rows: flow filter, single delete and the cutoff sweep", async () => {
      const appId = await repo.insertApp("p", appWrite());
      const pending = {
        appId,
        label: "default",
        codeVerifier: "enc-v",
        nonce: null,
        redirectUri: "https://cb",
        finalRedirect: null,
        userId: null,
        contextJson: "{}",
      };
      await repo.insertPending({ ...pending, state: "s1", flow: "generic" });
      await repo.insertPending({ ...pending, state: "s2", flow: "mcp" });
      const row = await repo.findPending("s1", ["generic", "tracker"]);
      expect(row).toMatchObject({ state: "s1", flow: "generic", codeVerifier: "enc-v" });
      expect(row?.createdAt).toMatch(ISO_MS);
      expect(await repo.findPending("s2", ["generic", "tracker"])).toBeNull();
      await repo.deletePending("s1");
      expect(await repo.findPending("s1", ["generic"])).toBeNull();
      expect(
        await repo.deletePendingBefore(["generic", "tracker"], "9999-12-31T23:59:59.999Z"),
      ).toBe(0);
      expect(await repo.deletePendingBefore(["mcp"], "9999-12-31T23:59:59.999Z")).toBe(1);
    });

    test("refresh locks are taken when free or expired, released by the owner only", async () => {
      expect(
        await repo.acquireRefreshLock(
          "k",
          "o1",
          "2026-01-01T00:10:00.000Z",
          "2026-01-01T00:00:00.000Z",
        ),
      ).toBe("o1");
      expect(
        await repo.acquireRefreshLock(
          "k",
          "o2",
          "2026-01-01T00:20:00.000Z",
          "2026-01-01T00:05:00.000Z",
        ),
      ).toBe("o1");
      expect(
        await repo.acquireRefreshLock(
          "k",
          "o2",
          "2026-01-01T00:20:00.000Z",
          "2026-01-01T00:10:00.000Z",
        ),
      ).toBe("o2");
      await repo.releaseRefreshLock("k", "o1");
      expect(
        await repo.acquireRefreshLock(
          "k",
          "o3",
          "2026-01-01T00:30:00.000Z",
          "2026-01-01T00:11:00.000Z",
        ),
      ).toBe("o2");
      await repo.releaseRefreshLock("k", "o2");
      expect(
        await repo.acquireRefreshLock(
          "k",
          "o3",
          "2026-01-01T00:30:00.000Z",
          "2026-01-01T00:11:00.000Z",
        ),
      ).toBe("o3");
    });

    test("codex device flows upsert and expire", async () => {
      await repo.upsertCodexDeviceFlow("f1", "enc-1", 100, 10);
      await repo.upsertCodexDeviceFlow("f1", "enc-2", 200, 20);
      await repo.upsertCodexDeviceFlow("f2", "enc-3", 50, 20);
      expect(await repo.getCodexDeviceFlow("f1")).toEqual({ state: "enc-2", expires_at: 200 });
      await repo.deleteExpiredCodexDeviceFlows(50);
      expect(await repo.getCodexDeviceFlow("f2")).toBeNull();
      await repo.deleteCodexDeviceFlow("f1");
      expect(await repo.getCodexDeviceFlow("f1")).toBeNull();
    });

    test("MCP apps, tokens and pending attempts", async () => {
      await storage.executor.run(sql`
        INSERT INTO mcp_servers (id, name, scope, transport, "createdAt", "lastUpdatedAt")
        VALUES ('srv', 'srv', 'global', 'http', ${"2026-01-01T00:00:00.000Z"}, ${"2026-01-01T00:00:00.000Z"})`);
      await storage.executor.run(sql`INSERT INTO users (id, name) VALUES ('u1', 'U')`);
      const app = {
        provider: "mcp-srv",
        clientId: "dcr-1",
        clientSecretCiphertext: null,
        authorizeUrl: "https://as/authorize",
        tokenUrl: "https://as/token",
        revocationUrl: null,
        redirectUri: "https://cb",
        scopes: "[]",
        source: "dcr",
        metadata: "{}",
      };
      await repo.insertMcpApp("app-1", "srv", app);
      expect(await repo.findAppById("app-1")).toMatchObject({
        provider: "mcp-srv",
        mcpServerId: "srv",
        clientSecretEncrypted: 1,
        requiresRefreshTokenRotation: 0,
        scopeSeparator: " ",
        tokenAuthStyle: "body",
        tokenBodyFormat: "form",
      });
      expect(await repo.findProviderAppById("app-1")).toBeNull();
      await repo.updateMcpApp("app-1", {
        ...app,
        clientId: "dcr-2",
        clientSecretCiphertext: "enc",
      });
      await repo.setAppMetadataById("app-1", '{"invalidated":true}');
      expect(await repo.findAppById("app-1")).toMatchObject({
        clientId: "dcr-2",
        clientSecret: "enc",
        metadata: '{"invalidated":true}',
      });

      await addAuth("tok-b", "app-1", "default");
      await addAuth("tok-a", "app-1", "user:u1", { userId: "u1" });
      await storage.executor.run(
        sql`UPDATE oauth_authorizations SET "createdAt" = '2026-01-01T00:00:00.000Z'`,
      );
      const shared = await repo.findMcpToken("srv", null);
      expect(shared).toMatchObject({
        id: "tok-b",
        appId: "app-1",
        mcpServerId: "srv",
        userId: null,
        clientId: "dcr-2",
        tokenVersion: 1,
      });
      expect((await repo.findMcpToken("srv", "u1"))?.id).toBe("tok-a");
      expect((await repo.findMcpTokenById("tok-a"))?.userId).toBe("u1");
      expect((await repo.listMcpTokens("srv")).map((row) => row.id)).toEqual(["tok-a", "tok-b"]);
      await repo.setAuthorizationStatus("tok-a", "expired", "gone");
      expect(await repo.findAuthorization("tok-a")).toMatchObject({
        status: "expired",
        lastErrorMessage: "gone",
      });
      expect(await repo.revokeAuthorization("tok-a", "enc-empty")).toBe(true);
      expect(await repo.revokeAuthorization("missing", "enc-empty")).toBe(false);

      await repo.insertMcpApp("app-2", "srv", app);
      await repo.insertMcpApp("app-3", "srv", app);
      const pending = {
        label: "default",
        flow: "mcp",
        codeVerifier: "enc-v",
        nonce: null,
        redirectUri: "https://cb",
        finalRedirect: null,
        userId: null,
        contextJson: "{}",
      };
      await repo.insertPending({ ...pending, state: "p-old", appId: "app-3" });
      await repo.insertPending({ ...pending, state: "p-tie-1", appId: "app-2" });
      await repo.insertPending({ ...pending, state: "p-tie-2", appId: "app-3" });
      await repo.insertPending({ ...pending, state: "p-user", appId: "app-1", userId: "u1" });
      const at = (state: string, createdAt: string) =>
        storage.executor.run(
          sql`UPDATE oauth_pending SET "createdAt" = ${createdAt} WHERE state = ${state}`,
        );
      await at("p-old", "2026-01-01T00:00:00.000Z");
      await at("p-tie-1", "2026-01-02T00:00:00.000Z");
      await at("p-tie-2", "2026-01-02T00:00:00.000Z");
      await at("p-user", "2026-01-03T00:00:00.000Z");
      expect(await repo.findLatestMcpPendingAppId("srv", null)).toBe("app-2");
      expect(await repo.findLatestMcpPendingAppId("srv", "u1")).toBe("app-1");
      expect(await repo.findLatestMcpPendingAppId("other", null)).toBeNull();
      expect(await repo.findMcpPending("p-old")).toMatchObject({
        state: "p-old",
        mcpServerId: "srv",
        appId: "app-3",
        codeVerifier: "enc-v",
        contextJson: "{}",
      });
      expect(await repo.listPendingAppIdsBefore("mcp", "2026-01-02T12:00:00.000Z")).toEqual([
        "app-2",
        "app-3",
      ]);
      await repo.deletePending("p-old", "generic");
      expect(await repo.findMcpPending("p-old")).not.toBeNull();
      await repo.deletePending("p-old", "mcp");
      expect(await repo.findMcpPending("p-old")).toBeNull();

      // app-1 has authorizations, app-2 and app-3 have pending rows.
      await repo.deleteOrphanMcpApp("app-1");
      await repo.deleteOrphanMcpApp("app-2");
      expect(await repo.findAppById("app-1")).not.toBeNull();
      expect(await repo.findAppById("app-2")).not.toBeNull();
      await repo.deletePending("p-tie-1");
      await repo.deleteOrphanMcpApp("app-2");
      expect(await repo.findAppById("app-2")).toBeNull();
    });

    test("oauth app listing: non-MCP apps by provider then insertion, with the default authorization", async () => {
      const app = (id: string, provider: string, mcpServerId: string | null = null) =>
        storage.executor.run(sql`
          INSERT INTO oauth_apps (id, provider, "clientId", "clientSecret", "authorizeUrl", "tokenUrl",
            "redirectUri", scopes, "mcpServerId", "createdAt", "updatedAt")
          VALUES (${id}, ${provider}, 'c', 's', 'https://a', 'https://t', 'https://r', ${jsonText('["x"]')},
            ${mcpServerId}, ${T0}, ${T0})`);
      await app("z2", "zeta");
      await app("b1", "beta");
      await app("z1", "zeta");
      await storage.executor.run(sql`
        INSERT INTO mcp_servers (id, name, scope, transport, "createdAt", "lastUpdatedAt")
        VALUES ('m1', 'm1', 'global', 'http', ${T0}, ${T0})`);
      await app("mcp", "alpha", "m1");
      const rows = await repo.listProviderAppsWithDefaultToken();
      expect(rows.map((r) => r.id)).toEqual(["b1", "z2", "z1"]);
      expect(rows[0]).toMatchObject({
        provider: "beta",
        clientId: "c",
        authorizationId: null,
        tokenExpiresAt: null,
        tokenUpdatedAt: null,
      });
      expect(Object.keys(rows[0] as object)).not.toContain("clientSecret");
      await repo.deleteAppById("z2");
      expect((await repo.listProviderAppsWithDefaultToken()).map((r) => r.id)).toEqual([
        "b1",
        "z1",
      ]);
    });
  });
}
