import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { decryptSecret, encryptSecret, getEncryptionKey } from "../be/crypto";
import { runMigrations } from "../be/migrations/runner";
import { autoEncryptLegacyOAuthSecrets } from "../be/oauth-encryption-backfill";

const NOW = "2026-07-21T12:00:00.000Z";

async function pre117Database(path = ":memory:"): Promise<Database> {
  const database = new Database(path, { create: true });
  const migrationSql = await Bun.file(
    `${import.meta.dir}/../be/migrations/117_unified_oauth.sql`,
  ).text();
  const checksum = new Bun.CryptoHasher("sha256").update(migrationSql).digest("hex");

  // Mark 117 as already applied so the real runner constructs an exact schema
  // through 116. Removing this sentinel later makes the same runner apply 117.
  database.run(`
    CREATE TABLE _migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL,
      checksum TEXT NOT NULL
    )
  `);
  database
    .query("INSERT INTO _migrations (version, name, applied_at, checksum) VALUES (117, ?, ?, ?)")
    .run("117_unified_oauth", NOW, checksum);
  runMigrations(database);

  const appRows = [
    {
      id: "app-linear",
      provider: "linear",
      clientId: "linear-client",
      clientSecret: "linear-client-secret",
      authorizeUrl: "https://linear.test/authorize",
      tokenUrl: "https://linear.test/token",
      redirectUri: "https://swarm.test/api/oauth/linear/callback",
      scopes: "read,write",
      metadata: JSON.stringify({
        actor: "app",
        extraParams: { prompt: "consent" },
        tokenAuthStyle: "body",
        tokenBodyFormat: "form",
      }),
    },
    {
      id: "app-jira",
      provider: "jira",
      clientId: "jira-client",
      clientSecret: "jira-client-secret",
      authorizeUrl: "https://jira.test/authorize",
      tokenUrl: "https://jira.test/token",
      redirectUri: "https://swarm.test/api/oauth/jira/callback",
      scopes: "read:jira-user,offline_access",
      metadata: JSON.stringify({
        cloudId: "cloud-1",
        webhookIds: ["hook-1"],
        revocationUrl: "https://jira.test/revoke",
        tokenAuthStyle: "basic",
        tokenBodyFormat: "json",
      }),
    },
    {
      id: "app-vendor",
      provider: "vendor",
      clientId: "vendor-client",
      clientSecret: "vendor-client-secret",
      authorizeUrl: "https://vendor.test/authorize",
      tokenUrl: "https://vendor.test/token",
      redirectUri: "https://swarm.test/api/oauth/vendor/callback",
      scopes: "profile,email",
      metadata: "{}",
    },
  ];
  const insertApp = database.query(`
    INSERT INTO oauth_apps (
      id, provider, clientId, clientSecret, authorizeUrl, tokenUrl,
      redirectUri, scopes, metadata, createdAt, updatedAt
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const app of appRows) {
    insertApp.run(
      app.id,
      app.provider,
      app.clientId,
      app.clientSecret,
      app.authorizeUrl,
      app.tokenUrl,
      app.redirectUri,
      app.scopes,
      app.metadata,
      NOW,
      NOW,
    );
  }

  const insertToken = database.query(`
    INSERT INTO oauth_tokens (
      id, provider, accessToken, refreshToken, expiresAt, scope, createdAt, updatedAt
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const provider of ["linear", "jira", "vendor"]) {
    insertToken.run(
      `token-${provider}`,
      provider,
      `${provider}-access-token`,
      `${provider}-refresh-token`,
      "2026-08-01T00:00:00.000Z",
      "read write",
      NOW,
      NOW,
    );
  }

  const insertServer = database.query(`
    INSERT INTO mcp_servers (
      id, name, scope, transport, url, isEnabled, version, createdAt, lastUpdatedAt
    ) VALUES (?, ?, 'global', 'http', ?, 1, 1, ?, ?)
  `);
  insertServer.run("mcp-dcr", "Migration DCR", "https://mcp-dcr.test", NOW, NOW);
  insertServer.run("mcp-manual", "Migration Manual", "https://mcp-manual.test", NOW, NOW);

  const key = getEncryptionKey();
  const insertMcpToken = database.query(`
    INSERT INTO mcp_oauth_tokens (
      id, mcpServerId, userId, accessToken, refreshToken, tokenType, expiresAt, scope,
      resourceUrl, authorizationServerIssuer, authorizeUrl, tokenUrl, revocationUrl,
      dcrClientId, dcrClientSecret, clientSource, status, lastErrorMessage,
      lastRefreshedAt, connectedByUserId, createdAt, updatedAt
    ) VALUES (?, ?, NULL, ?, ?, 'Bearer', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, NULL, ?, ?)
  `);
  insertMcpToken.run(
    "mcp-token-dcr",
    "mcp-dcr",
    encryptSecret("mcp-dcr-access", key),
    encryptSecret("mcp-dcr-refresh", key),
    "2026-08-02T00:00:00.000Z",
    "mcp read",
    "https://mcp-dcr.test",
    "https://issuer-dcr.test",
    "https://issuer-dcr.test/authorize",
    "https://issuer-dcr.test/token",
    "https://issuer-dcr.test/revoke",
    "dcr-client",
    encryptSecret("dcr-client-secret", key),
    "dcr",
    "connected",
    NOW,
    NOW,
    NOW,
  );
  insertMcpToken.run(
    "mcp-token-manual",
    "mcp-manual",
    encryptSecret("mcp-manual-access", key),
    null,
    "2026-08-03T00:00:00.000Z",
    "manual read",
    "https://mcp-manual.test",
    "https://issuer-manual.test",
    "https://issuer-manual.test/authorize",
    "https://issuer-manual.test/token",
    null,
    "manual-client",
    encryptSecret("manual-client-secret", key),
    "manual",
    "error",
    NOW,
    NOW,
    NOW,
  );

  database
    .query(`
      INSERT INTO mcp_oauth_pending (
        state, mcpServerId, userId, codeVerifier, nonce, resourceUrl,
        authorizationServerIssuer, authorizeUrl, tokenUrl, revocationUrl, scopes,
        dcrClientId, dcrClientSecret, redirectUri, finalRedirect, createdAt
      ) VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    .run(
      "pending-state",
      "mcp-dcr",
      encryptSecret("pending-verifier", key),
      "pending-nonce",
      "https://pending-resource.test",
      "https://pending-issuer.test",
      "https://pending-issuer.test/authorize",
      "https://pending-issuer.test/token",
      "https://pending-issuer.test/revoke",
      "pending scope",
      "pending-client",
      encryptSecret("pending-client-secret", key),
      "https://swarm.test/api/oauth/callback",
      "/connections",
      NOW,
    );

  const insertBinding = database.query(`
    INSERT INTO script_credential_bindings (
      id, config_key, allowed_hosts_json, header_template, query_template,
      scope, scope_id, active, source, created_at, updated_at,
      auth_kind, oauth_provider
    ) VALUES (?, ?, ?, ?, ?, 'global', NULL, 1, 'user', ?, ?, ?, ?)
  `);
  insertBinding.run(
    "binding-config",
    "PLAIN_SECRET",
    '["api.example.test"]',
    "Authorization: Bearer [REDACTED:PLAIN_SECRET]",
    null,
    NOW,
    NOW,
    "config",
    null,
  );
  insertBinding.run(
    "binding-oauth",
    "VENDOR_OAUTH",
    '["api.vendor.test"]',
    "Authorization: Bearer [REDACTED:VENDOR_OAUTH]",
    null,
    NOW,
    NOW,
    "oauth",
    "vendor",
  );
  insertBinding.run(
    "binding-query",
    "QUERY_SECRET",
    '["query.example.test"]',
    null,
    "token=[REDACTED:QUERY_SECRET]",
    NOW,
    NOW,
    "config",
    null,
  );

  const legacyBlob = JSON.stringify({
    bindings: [
      {
        configKey: "VENDOR_OAUTH",
        allowedHosts: ["api.vendor.test"],
        headerTemplate: "Authorization: Bearer [REDACTED:VENDOR_OAUTH]",
        authKind: "oauth",
        oauthProvider: "vendor",
      },
    ],
  });
  database
    .query(`
      INSERT INTO swarm_config (
        id, scope, scopeId, key, value, isSecret, description,
        createdAt, lastUpdatedAt, encrypted
      ) VALUES (?, 'global', NULL, 'SCRIPT_CREDENTIAL_BINDINGS', ?, 0, ?, ?, ?, 0)
    `)
    .run("legacy-binding-blob", legacyBlob, "migration fixture", NOW, NOW);

  database
    .query(
      "INSERT INTO oauth_refresh_locks (provider, owner, expiresAt, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?)",
    )
    .run("linear", "migration-owner", "2026-08-01T00:00:00.000Z", NOW, NOW);

  return database;
}

const qaFixturePath = process.env.UNIFIED_OAUTH_PRE117_FIXTURE_PATH;

describe("migration 117 unified OAuth storage", () => {
  if (qaFixturePath) {
    test("builds a populated pre-117 file fixture for boot QA", async () => {
      const database = await pre117Database(qaFixturePath);
      try {
        expect(
          database.query<{ count: number }, []>("SELECT count(*) AS count FROM oauth_tokens").get()
            ?.count,
        ).toBe(3);
        expect(
          database
            .query<{ count: number }, []>("SELECT count(*) AS count FROM mcp_oauth_tokens")
            .get()?.count,
        ).toBe(2);
        // The sentinel exists only to make runMigrations stop at 116. Remove
        // it before handing the file to a real boot so migration 117 is pending.
        database.query("DELETE FROM _migrations WHERE version = 117").run();
      } finally {
        database.close();
      }
    });
    return;
  }

  test("carries legacy rows, lifts quirks, re-keys bindings, and encrypts idempotently", async () => {
    const database = await pre117Database();
    try {
      database.query("DELETE FROM _migrations WHERE version = 117").run();
      runMigrations(database);

      expect(
        database.query<{ count: number }, []>("SELECT count(*) AS count FROM oauth_apps").get()
          ?.count,
      ).toBe(5);
      expect(
        database
          .query<{ count: number }, []>("SELECT count(*) AS count FROM oauth_authorizations")
          .get()?.count,
      ).toBe(5);
      expect(
        database.query<{ count: number }, []>("SELECT count(*) AS count FROM oauth_pending").get()
          ?.count,
      ).toBe(1);

      const linear = database
        .query<
          {
            id: string;
            scopeSeparator: string;
            extraParamsJson: string | null;
            metadata: string;
          },
          []
        >(
          "SELECT id, scopeSeparator, extraParamsJson, metadata FROM oauth_apps WHERE provider = 'linear'",
        )
        .get();
      expect(linear?.id).toBe("app-linear");
      expect(linear?.scopeSeparator).toBe(",");
      expect(JSON.parse(linear?.extraParamsJson ?? "{}")).toEqual({ prompt: "consent" });
      expect(JSON.parse(linear?.metadata ?? "{}")).toEqual({ actor: "app" });

      const jira = database
        .query<
          {
            tokenAuthStyle: string;
            tokenBodyFormat: string;
            requiresRefreshTokenRotation: number;
            revocationUrl: string | null;
            metadata: string;
          },
          []
        >(
          `SELECT tokenAuthStyle, tokenBodyFormat, requiresRefreshTokenRotation,
                  revocationUrl, metadata
           FROM oauth_apps WHERE provider = 'jira'`,
        )
        .get();
      expect(jira).toMatchObject({
        tokenAuthStyle: "basic",
        tokenBodyFormat: "json",
        requiresRefreshTokenRotation: 1,
        revocationUrl: "https://jira.test/revoke",
      });
      expect(JSON.parse(jira?.metadata ?? "{}")).toEqual({
        cloudId: "cloud-1",
        webhookIds: ["hook-1"],
      });

      const manualMcp = database
        .query<{ id: string; source: string; metadata: string; status: string }, []>(
          `SELECT a.id, a.source, a.metadata, z.status
           FROM oauth_apps a
           JOIN oauth_authorizations z ON z.appId = a.id
           WHERE a.mcpServerId = 'mcp-manual'`,
        )
        .get();
      expect(manualMcp?.id).toBe("mcp-app-mcp-token-manual");
      expect(manualMcp?.source).toBe("dcr");
      expect(JSON.parse(manualMcp?.metadata ?? "{}").clientSource).toBe("manual");
      expect(manualMcp?.status).toBe("refresh-failed");

      const pendingContext = database
        .query<{ contextJson: string }, []>(
          "SELECT contextJson FROM oauth_pending WHERE state = 'pending-state'",
        )
        .get();
      expect(JSON.parse(pendingContext?.contextJson ?? "{}")).toMatchObject({
        resourceUrl: "https://pending-resource.test",
        authorizationServerIssuer: "https://pending-issuer.test",
        dcrClientId: "pending-client",
      });

      const oauthBinding = database
        .query<{ oauth_authorization_id: string | null }, []>(
          "SELECT oauth_authorization_id FROM script_credential_bindings WHERE id = 'binding-oauth'",
        )
        .get();
      expect(oauthBinding?.oauth_authorization_id).toBe("token-vendor");
      expect(
        database.query<{ lockKey: string }, []>("SELECT lockKey FROM oauth_refresh_locks").get()
          ?.lockKey,
      ).toBe("linear");

      const legacyTables = database
        .query<{ name: string }, []>(
          `SELECT name FROM sqlite_master
           WHERE type = 'table'
             AND name IN ('oauth_tokens', 'mcp_oauth_tokens', 'mcp_oauth_pending')`,
        )
        .all();
      expect(legacyTables).toEqual([]);
      const bindingColumns = database
        .query<{ name: string }, []>("PRAGMA table_info(script_credential_bindings)")
        .all()
        .map((row) => row.name);
      expect(bindingColumns).toContain("oauth_authorization_id");
      expect(bindingColumns).not.toContain("oauth_provider");

      const firstBackfill = autoEncryptLegacyOAuthSecrets(database);
      expect(firstBackfill).toEqual({ appsEncrypted: 3, authorizationsEncrypted: 3 });
      const encryptedLinear = database
        .query<{ clientSecret: string; clientSecretEncrypted: number }, []>(
          "SELECT clientSecret, clientSecretEncrypted FROM oauth_apps WHERE id = 'app-linear'",
        )
        .get();
      expect(encryptedLinear?.clientSecretEncrypted).toBe(1);
      expect(encryptedLinear?.clientSecret).not.toBe("linear-client-secret");
      expect(decryptSecret(encryptedLinear!.clientSecret, getEncryptionKey())).toBe(
        "linear-client-secret",
      );
      const encryptedAuthorization = database
        .query<{ accessToken: string; refreshToken: string | null; tokensEncrypted: number }, []>(
          `SELECT accessToken, refreshToken, tokensEncrypted
           FROM oauth_authorizations WHERE id = 'token-linear'`,
        )
        .get();
      expect(encryptedAuthorization?.tokensEncrypted).toBe(1);
      expect(decryptSecret(encryptedAuthorization!.accessToken, getEncryptionKey())).toBe(
        "linear-access-token",
      );
      expect(decryptSecret(encryptedAuthorization!.refreshToken!, getEncryptionKey())).toBe(
        "linear-refresh-token",
      );
      expect(autoEncryptLegacyOAuthSecrets(database)).toEqual({
        appsEncrypted: 0,
        authorizationsEncrypted: 0,
      });

      expect(database.query("PRAGMA foreign_key_check").all()).toEqual([]);
      expect(
        database.query<{ integrity_check: string }, []>("PRAGMA integrity_check").get(),
      ).toEqual({ integrity_check: "ok" });
    } finally {
      database.close();
    }
  });
});
