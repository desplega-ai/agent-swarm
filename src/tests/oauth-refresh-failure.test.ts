import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { closeDb, createAgent, getDb, initDb } from "../be/db";
import {
  getAuthorizationById,
  getOAuthApp,
  storeOAuthTokens,
  upsertAuthorization,
  upsertOAuthApp,
} from "../be/db-queries/oauth";
import { upsertCredentialBinding } from "../be/script-connections";
import { buildScriptCredentialBindingsWithFailures } from "../be/script-credential-broker";
import {
  ensureAuthorizationTokenOrThrow,
  forceRefreshAuthorizationOrThrow,
  OAuthRefreshError,
} from "../oauth/ensure-token";
import { patchFetchWithCredentialBroker } from "../scripts-runtime/credential-broker";
import { clearVolatileSecretsForTesting } from "../utils/secret-scrubber";

const TEST_DB_PATH = "./test-oauth-refresh-failure.sqlite";
const LEAD_ID = "aaaa9500-0000-4000-8000-000000000001";
const originalFetch = globalThis.fetch;

function appConfig(provider: string, tokenUrl = `https://oauth.${provider}.test/token`) {
  return {
    clientId: `${provider}-client-id`,
    clientSecret: `${provider}-client-secret`,
    authorizeUrl: `https://oauth.${provider}.test/authorize`,
    tokenUrl,
    redirectUri: "http://localhost:3013/callback",
    scopes: "read,write",
  };
}

/**
 * Mock the token endpoint. Refresh requests whose body carries a refresh token
 * listed in `failFor` get a 400 (invalid_grant); everything else gets a fresh
 * token whose access value is derived from the incoming refresh token so
 * per-authorization isolation is observable.
 */
function mockTokenEndpoint(failFor: string[] = []): void {
  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    const body = typeof init?.body === "string" ? init.body : "";
    const failing = failFor.some((token) => body.includes(`refresh_token=${token}`));
    if (failing) {
      return new Response(JSON.stringify({ error: "invalid_grant" }), {
        status: 400,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(
      JSON.stringify({
        access_token: "healed-access-token",
        token_type: "bearer",
        expires_in: 3600,
        refresh_token: "rotated-refresh-token",
        scope: "read,write",
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;
}

beforeAll(async () => {
  await unlink(TEST_DB_PATH).catch(() => {});
  await unlink(`${TEST_DB_PATH}-wal`).catch(() => {});
  await unlink(`${TEST_DB_PATH}-shm`).catch(() => {});
  initDb(TEST_DB_PATH);
  createAgent({ id: LEAD_ID, name: "OAuth Refresh Lead", isLead: true, status: "idle" });
});

beforeEach(() => {
  globalThis.fetch = originalFetch;
  clearVolatileSecretsForTesting();
  getDb().run("DELETE FROM oauth_refresh_locks");
  getDb().run("DELETE FROM script_credential_bindings");
  getDb().run("DELETE FROM oauth_authorizations");
  getDb().run("DELETE FROM oauth_apps");
});

afterAll(async () => {
  globalThis.fetch = originalFetch;
  closeDb();
  for (const suffix of ["", "-wal", "-shm"]) {
    await unlink(TEST_DB_PATH + suffix).catch(() => {});
  }
});

function seedDefault(provider: string, refreshToken: string | null, expiresInMs: number): string {
  storeOAuthTokens(provider, {
    accessToken: `${provider}-access`,
    refreshToken,
    expiresAt: new Date(Date.now() + expiresInMs).toISOString(),
    scope: "read,write",
  });
  const id = getDb()
    .query(
      `SELECT z.id AS id FROM oauth_authorizations z
       JOIN oauth_apps a ON a.id = z.appId
       WHERE a.provider = ? AND a.mcpServerId IS NULL AND z.label = 'default'`,
    )
    .get(provider) as { id: string } | null;
  if (!id) throw new Error("default authorization not seeded");
  return id.id;
}

describe("OAuth refresh failure semantics", () => {
  test("a rejected refresh persists refresh-failed + lastErrorMessage and throws typed error", async () => {
    upsertOAuthApp("acme", appConfig("acme"));
    const authId = seedDefault("acme", "acme-refresh", 60 * 1000);
    mockTokenEndpoint(["acme-refresh"]);

    await expect(forceRefreshAuthorizationOrThrow(authId)).rejects.toBeInstanceOf(
      OAuthRefreshError,
    );

    const after = getAuthorizationById(authId);
    expect(after?.status).toBe("refresh-failed");
    expect(after?.lastErrorMessage).toBeTruthy();
    expect(after?.lastErrorMessage).toContain("400");
  });

  test("a recovered provider flips a refresh-failed authorization back to active", async () => {
    upsertOAuthApp("acme", appConfig("acme"));
    const authId = seedDefault("acme", "acme-refresh", 60 * 1000);

    mockTokenEndpoint(["acme-refresh"]);
    await expect(forceRefreshAuthorizationOrThrow(authId)).rejects.toBeInstanceOf(
      OAuthRefreshError,
    );
    expect(getAuthorizationById(authId)?.status).toBe("refresh-failed");

    // Provider recovers.
    mockTokenEndpoint();
    await forceRefreshAuthorizationOrThrow(authId);
    const healed = getAuthorizationById(authId);
    expect(healed?.status).toBe("active");
    expect(healed?.lastErrorMessage).toBeNull();
    expect(healed?.accessToken).toBe("healed-access-token");
  });

  test("the broker surfaces a failed OAuth binding while other bindings still resolve", async () => {
    upsertOAuthApp("acme", { ...appConfig("acme"), displayName: "Acme Corp" });
    const authId = seedDefault("acme", "acme-refresh", 60 * 1000);
    upsertCredentialBinding({
      configKey: "ACME_OAUTH",
      allowedHosts: ["api.acme.test"],
      headerTemplate: "Authorization: Bearer [REDACTED:ACME_OAUTH]",
      authKind: "oauth",
      oauthAuthorizationId: authId,
    });
    upsertCredentialBinding({
      configKey: "HEALTHY_CONFIG",
      allowedHosts: ["api.acme.test"],
      headerTemplate: "Authorization: Bearer [REDACTED:HEALTHY_CONFIG]",
    });
    process.env.HEALTHY_CONFIG = "healthy-config-value";
    mockTokenEndpoint(["acme-refresh"]);

    try {
      const { egressSecrets, failedBindings } = await buildScriptCredentialBindingsWithFailures({});

      expect(egressSecrets.some((b) => b.configKey === "ACME_OAUTH")).toBe(false);
      expect(egressSecrets).toContainEqual(
        expect.objectContaining({ configKey: "HEALTHY_CONFIG", value: "healthy-config-value" }),
      );
      expect(failedBindings).toContainEqual(
        expect.objectContaining({
          placeholder: "[REDACTED:ACME_OAUTH]",
          allowedHosts: ["api.acme.test"],
          reason: "refresh_rejected",
          authorizationLabel: "Acme Corp",
        }),
      );
      // The authorization is now persisted as broken.
      expect(getAuthorizationById(authId)?.status).toBe("refresh-failed");
    } finally {
      delete process.env.HEALTHY_CONFIG;
    }
  });

  test("the sandbox fetch throws a typed error for a failed binding's host", async () => {
    try {
      // Observer stub so non-blocked requests pass through without real network I/O.
      let observedCalls = 0;
      globalThis.fetch = (async () => {
        observedCalls++;
        return Response.json({ ok: true });
      }) as typeof fetch;

      patchFetchWithCredentialBroker(
        [],
        [
          {
            placeholder: "[REDACTED:ACME_OAUTH]",
            allowedHosts: ["api.acme.test"],
            reason: "refresh_rejected",
            authorizationLabel: "Acme Corp",
          },
        ],
      );

      // Targets the failed binding's host WITH its placeholder → typed throw.
      expect(() =>
        fetch("https://api.acme.test/v1/things", {
          headers: { Authorization: "Bearer [REDACTED:ACME_OAUTH]" },
        }),
      ).toThrow(/OAuth authorization 'Acme Corp' is in refresh-failed state: refresh_rejected/);

      // A request to the same host WITHOUT the placeholder is not blocked.
      await fetch("https://api.acme.test/v1/public", { headers: { "x-foo": "bar" } });
      // A different host is not blocked even with the placeholder present.
      await fetch("https://example.com/leak", {
        headers: { Authorization: "Bearer [REDACTED:ACME_OAUTH]" },
      });
      expect(observedCalls).toBe(2);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("two authorizations under one app refresh independently (per-authorization isolation)", async () => {
    upsertOAuthApp("acme", appConfig("acme"));
    const app = getOAuthApp("acme");
    if (!app) throw new Error("app not created");

    const broken = upsertAuthorization({
      appId: app.id,
      label: "default",
      accessToken: "broken-access",
      refreshToken: "broken-refresh",
      expiresAt: new Date(Date.now() + 60 * 1000).toISOString(),
      status: "active",
    });
    const healthy = upsertAuthorization({
      appId: app.id,
      label: "secondary",
      accessToken: "healthy-access",
      refreshToken: "healthy-refresh",
      expiresAt: new Date(Date.now() + 60 * 1000).toISOString(),
      status: "active",
    });

    mockTokenEndpoint(["broken-refresh"]);

    const [brokenResult, healthyResult] = await Promise.allSettled([
      ensureAuthorizationTokenOrThrow(broken.id),
      ensureAuthorizationTokenOrThrow(healthy.id),
    ]);

    expect(brokenResult.status).toBe("rejected");
    if (brokenResult.status === "rejected") {
      expect(brokenResult.reason).toBeInstanceOf(OAuthRefreshError);
    }
    expect(healthyResult.status).toBe("fulfilled");

    expect(getAuthorizationById(broken.id)?.status).toBe("refresh-failed");
    const healed = getAuthorizationById(healthy.id);
    expect(healed?.status).toBe("active");
    expect(healed?.accessToken).toBe("healed-access-token");
  });
});
