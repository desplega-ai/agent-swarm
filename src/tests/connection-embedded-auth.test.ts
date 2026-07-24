import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { migrateLegacyCredentialBindingBlob } from "../be/connection-bindings-blob-migration";
import { deleteSwarmConfig, getDb, getSwarmConfigs, upsertSwarmConfig } from "../be/db";
import { getOAuthApp, upsertAuthorization, upsertOAuthApp } from "../be/db-queries/oauth";
import {
  getScriptApiConnectionDescriptors,
  getScriptConnectionById,
  listRelationalCredentialBindings,
  upsertCredentialBinding,
  upsertScriptConnection,
} from "../be/script-connections";
import { buildScriptCredentialBindings } from "../be/script-credential-broker";
import { runScript } from "../scripts-runtime/loader";
import { clearVolatileSecretsForTesting, scrubSecrets } from "../utils/secret-scrubber";

const resources = { memoryMb: 2048, cpuTimeSec: 20, maxStdoutBytes: 1_048_576 };
const createdConnectionIds: string[] = [];
const createdConfigKeys: string[] = [];

function openapiSpec(port: number): string {
  return JSON.stringify({
    openapi: "3.1.0",
    info: { title: "Vendor", version: "1.0.0" },
    servers: [{ url: `http://127.0.0.1:${port}` }],
    paths: {
      "/me": {
        get: {
          operationId: "getMe",
          responses: {
            "200": {
              description: "ok",
              content: {
                "application/json": {
                  schema: { type: "object", properties: { ok: { type: "boolean" } } },
                },
              },
            },
          },
        },
      },
    },
  });
}

const savedEnv = { ...process.env };

beforeEach(() => {
  clearVolatileSecretsForTesting();
  process.env.AGENT_SWARM_API_KEY = "embedded-auth-test-key";
  delete process.env.API_KEY;
  process.env.MCP_BASE_URL = "http://localhost:3013";
});

afterEach(() => {
  const db = getDb();
  for (const id of createdConnectionIds.splice(0)) {
    db.run("DELETE FROM script_connections WHERE id = ?", id);
  }
  db.run("DELETE FROM script_credential_bindings WHERE source = 'connection'");
  for (const key of createdConfigKeys.splice(0)) {
    for (const row of getSwarmConfigs({ key })) deleteSwarmConfig(row.id);
  }
  db.run("DELETE FROM swarm_config WHERE key = 'SCRIPT_CREDENTIAL_BINDINGS'");
  clearVolatileSecretsForTesting();
  for (const key of Object.keys(process.env)) {
    if (!(key in savedEnv)) delete process.env[key];
  }
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function managedBindingFor(connectionId: string) {
  return getDb()
    .prepare<
      {
        config_key: string;
        header_template: string | null;
        query_template: string | null;
        allowed_hosts_json: string;
        auth_kind: string;
        oauth_authorization_id: string | null;
        source: string;
        managed_by_connection_id: string | null;
      },
      [string]
    >("SELECT * FROM script_credential_bindings WHERE managed_by_connection_id = ?")
    .get(connectionId);
}

describe("embedded connection auth", () => {
  test("bearer inline secret lands encrypted in swarm_config under the derived key", async () => {
    createdConfigKeys.push("connection.bearerVendor.secret");
    const connection = await upsertScriptConnection({
      slug: "bearerVendor",
      kind: "graphql",
      baseUrl: "https://api.vendor.test/graphql",
      allowedHosts: ["api.vendor.test"],
      auth: { type: "bearer", secret: "test-tok-123" },
    });
    createdConnectionIds.push(connection.id);

    expect(connection.authType).toBe("bearer");
    expect(connection.authConfigKey).toBe("connection.bearerVendor.secret");

    const binding = managedBindingFor(connection.id);
    expect(binding?.config_key).toBe("connection.bearerVendor.secret");
    expect(binding?.header_template).toBe(
      "Authorization: Bearer [REDACTED:connection.bearerVendor.secret]",
    );
    expect(binding?.query_template).toBeNull();
    expect(binding?.source).toBe("connection");
    expect(JSON.parse(binding?.allowed_hosts_json ?? "[]")).toEqual(["api.vendor.test"]);

    // Stored encrypted, not plaintext.
    const raw = getDb()
      .prepare<{ value: string; isSecret: number; encrypted: number }, [string]>(
        "SELECT value, isSecret, encrypted FROM swarm_config WHERE key = ?",
      )
      .get("connection.bearerVendor.secret");
    expect(raw?.isSecret).toBe(1);
    expect(raw?.encrypted).toBe(1);
    expect(raw?.value).not.toBe("test-tok-123");
    // Decrypts back to plaintext on read.
    expect(getSwarmConfigs({ key: "connection.bearerVendor.secret" })[0]?.value).toBe(
      "test-tok-123",
    );

    // The broker registers the resolved secret with the scrubber so logs/output
    // only ever show the placeholder — never the raw value.
    await buildScriptCredentialBindings({});
    expect(scrubSecrets("token=test-tok-123")).toContain(
      "[REDACTED:connection.bearerVendor.secret]",
    );
  });

  test("explicit configKey is used as-is (no derived secret write)", async () => {
    const connection = await upsertScriptConnection({
      slug: "sharedVendor",
      kind: "graphql",
      baseUrl: "https://api.vendor.test/graphql",
      allowedHosts: ["api.vendor.test"],
      auth: { type: "bearer", configKey: "SHARED_VENDOR_KEY" },
    });
    createdConnectionIds.push(connection.id);

    expect(connection.authConfigKey).toBe("SHARED_VENDOR_KEY");
    expect(managedBindingFor(connection.id)?.config_key).toBe("SHARED_VENDOR_KEY");
    // No derived secret key was written.
    expect(getSwarmConfigs({ key: "connection.sharedVendor.secret" })).toHaveLength(0);
  });

  test("query auth derives a query template and NO Authorization header", async () => {
    createdConfigKeys.push("connection.queryVendor.secret");
    const connection = await upsertScriptConnection({
      slug: "queryVendor",
      kind: "graphql",
      baseUrl: "https://api.vendor.test/graphql",
      allowedHosts: ["api.vendor.test"],
      auth: { type: "query", paramName: "api_key", secret: "qk-1" },
    });
    createdConnectionIds.push(connection.id);

    const binding = managedBindingFor(connection.id);
    expect(binding?.header_template).toBeNull();
    expect(binding?.query_template).toBe("api_key=[REDACTED:connection.queryVendor.secret]");
    expect(connection.authType).toBe("query");
    expect(connection.authParamName).toBe("api_key");
  });

  test("custom header auth derives a named header template", async () => {
    createdConfigKeys.push("connection.headerVendor.secret");
    const connection = await upsertScriptConnection({
      slug: "headerVendor",
      kind: "graphql",
      baseUrl: "https://api.vendor.test/graphql",
      allowedHosts: ["api.vendor.test"],
      auth: { type: "header", headerName: "X-Api-Key", secret: "hk-1" },
    });
    createdConnectionIds.push(connection.id);

    const binding = managedBindingFor(connection.id);
    expect(binding?.header_template).toBe("X-Api-Key: [REDACTED:connection.headerVendor.secret]");
    expect(binding?.query_template).toBeNull();
    expect(connection.authParamName).toBe("X-Api-Key");
  });

  test("oauth auth validates the authorization and derives a bearer binding", async () => {
    upsertOAuthApp("embeddedvendor", {
      clientId: "cid",
      clientSecret: "csecret",
      authorizeUrl: "https://vendor.test/authorize",
      tokenUrl: "https://vendor.test/token",
      redirectUri: "https://swarm.test/api/oauth/callback",
      scopes: "read",
    });
    const app = getOAuthApp("embeddedvendor");
    if (!app) throw new Error("app not created");
    const authorization = upsertAuthorization({
      appId: app.id,
      accessToken: "oauth-access-token",
      status: "active",
    });

    const connection = await upsertScriptConnection({
      slug: "oauthVendor",
      kind: "graphql",
      baseUrl: "https://api.vendor.test/graphql",
      allowedHosts: ["api.vendor.test"],
      auth: { type: "oauth", authorizationId: authorization.id },
    });
    createdConnectionIds.push(connection.id);

    expect(connection.authType).toBe("oauth");
    expect(connection.authAuthorizationId).toBe(authorization.id);
    const binding = managedBindingFor(connection.id);
    expect(binding?.auth_kind).toBe("oauth");
    expect(binding?.oauth_authorization_id).toBe(authorization.id);
    expect(binding?.header_template).toContain("Authorization: Bearer [REDACTED:");

    // Cleanup: removing the app cascades the authorization (and SET-NULLs the ref).
    getDb().run("DELETE FROM oauth_apps WHERE id = ?", app.id);
  });

  test("oauth auth with an unknown authorization is rejected", async () => {
    await expect(
      upsertScriptConnection({
        slug: "oauthMissing",
        kind: "graphql",
        baseUrl: "https://api.vendor.test/graphql",
        allowedHosts: ["api.vendor.test"],
        auth: { type: "oauth", authorizationId: "does-not-exist" },
      }),
    ).rejects.toThrow(/was not found/);
  });

  test("openapi upsert with an unknown oauth authorization is rejected, not swallowed as a generationError", async () => {
    // A valid inline spec — generation itself would succeed. The bad auth input
    // must fail the upsert with a thrown error rather than being swallowed into
    // `generationError` (which the openapi try/catch previously did, then saved
    // the connection with the managed auth binding cleared).
    const spec = JSON.stringify({
      openapi: "3.0.0",
      info: { title: "t", version: "1" },
      servers: [{ url: "https://api.vendor.test" }],
      paths: {},
    });
    await expect(
      upsertScriptConnection({
        slug: "openapiBadAuth",
        kind: "openapi",
        openapiSpecJson: spec,
        auth: { type: "oauth", authorizationId: "does-not-exist" },
      }),
    ).rejects.toThrow(/was not found/);

    // The rejection happens before any DB write — no connection row is saved.
    const row = getDb()
      .prepare<{ id: string }, [string]>("SELECT id FROM script_connections WHERE slug = ?")
      .get("openapiBadAuth");
    expect(row).toBeNull();
  });

  test("openapi upsert soft-fails a genuine spec-generation problem into generationError", async () => {
    // Valid baseUrl + no auth (so auth derivation is a no-op), but a spec body
    // that is neither JSON nor YAML-mapping parseable. That is a genuine
    // generation problem and must STILL soft-fail (persist with generationError),
    // proving the auth-validation rethrow did not turn every openapi error hard.
    const connection = await upsertScriptConnection({
      slug: "openapiBadSpec",
      kind: "openapi",
      baseUrl: "https://api.vendor.test",
      openapiSpecJson: "::: not : valid : openapi :::",
      auth: { type: "none" },
    });
    createdConnectionIds.push(connection.id);
    expect(connection.generationError).not.toBeNull();
  });

  test("re-upsert with a changed slug re-derives the managed binding", async () => {
    createdConfigKeys.push("connection.rederiveVendor.secret");
    const connection = await upsertScriptConnection({
      slug: "rederiveVendor",
      kind: "graphql",
      baseUrl: "https://api.vendor.test/graphql",
      allowedHosts: ["api.vendor.test"],
      auth: { type: "bearer", configKey: "REDERIVE_KEY" },
    });
    createdConnectionIds.push(connection.id);

    // Metadata-only update (no `auth`) preserves + re-derives the binding.
    const updated = await upsertScriptConnection({
      id: connection.id,
      slug: "rederiveVendor",
      kind: "graphql",
      baseUrl: "https://api2.vendor.test/graphql",
      allowedHosts: ["api2.vendor.test"],
    });
    expect(updated.authConfigKey).toBe("REDERIVE_KEY");
    const binding = managedBindingFor(connection.id);
    expect(JSON.parse(binding?.allowed_hosts_json ?? "[]")).toEqual(["api2.vendor.test"]);
  });

  test("re-upsert changing the slug deletes the orphaned derived inline secret", async () => {
    createdConfigKeys.push("connection.slugOne.secret", "connection.slugTwo.secret");
    const connection = await upsertScriptConnection({
      slug: "slugOne",
      kind: "graphql",
      baseUrl: "https://api.vendor.test/graphql",
      allowedHosts: ["api.vendor.test"],
      auth: { type: "bearer", secret: "slug-secret-1" },
    });
    createdConnectionIds.push(connection.id);
    expect(getSwarmConfigs({ key: "connection.slugOne.secret" })).toHaveLength(1);

    const renamed = await upsertScriptConnection({
      id: connection.id,
      slug: "slugTwo",
      kind: "graphql",
      baseUrl: "https://api.vendor.test/graphql",
      allowedHosts: ["api.vendor.test"],
      auth: { type: "bearer", secret: "slug-secret-2" },
    });
    expect(renamed.authConfigKey).toBe("connection.slugTwo.secret");
    // Old derived secret is gone; the new one holds the new value.
    expect(getSwarmConfigs({ key: "connection.slugOne.secret" })).toHaveLength(0);
    expect(getSwarmConfigs({ key: "connection.slugTwo.secret" })[0]?.value).toBe("slug-secret-2");
    // Stale key no longer scrubbed; new key is.
    await buildScriptCredentialBindings({});
    expect(scrubSecrets("v=slug-secret-2")).toContain("[REDACTED:connection.slugTwo.secret]");
  });

  test("switching an inline-secret connection to oauth deletes the derived inline secret", async () => {
    createdConfigKeys.push("connection.switchVendor.secret");
    upsertOAuthApp("switchvendor", {
      clientId: "cid",
      clientSecret: "csecret",
      authorizeUrl: "https://vendor.test/authorize",
      tokenUrl: "https://vendor.test/token",
      redirectUri: "https://swarm.test/api/oauth/callback",
      scopes: "read",
    });
    const app = getOAuthApp("switchvendor");
    if (!app) throw new Error("app not created");
    const authorization = upsertAuthorization({
      appId: app.id,
      accessToken: "oauth-access-token",
      status: "active",
    });

    const connection = await upsertScriptConnection({
      slug: "switchVendor",
      kind: "graphql",
      baseUrl: "https://api.vendor.test/graphql",
      allowedHosts: ["api.vendor.test"],
      auth: { type: "bearer", secret: "switch-secret" },
    });
    createdConnectionIds.push(connection.id);
    expect(getSwarmConfigs({ key: "connection.switchVendor.secret" })).toHaveLength(1);

    const switched = await upsertScriptConnection({
      id: connection.id,
      slug: "switchVendor",
      kind: "graphql",
      baseUrl: "https://api.vendor.test/graphql",
      allowedHosts: ["api.vendor.test"],
      auth: { type: "oauth", authorizationId: authorization.id },
    });
    expect(switched.authType).toBe("oauth");
    // The derived inline secret is orphaned by the switch and is deleted.
    expect(getSwarmConfigs({ key: "connection.switchVendor.secret" })).toHaveLength(0);

    getDb().run("DELETE FROM oauth_apps WHERE id = ?", app.id);
  });

  test("metadata-only rename preserves the derived inline secret (not deleted)", async () => {
    createdConfigKeys.push("connection.keepVendor.secret");
    const connection = await upsertScriptConnection({
      slug: "keepVendor",
      kind: "graphql",
      baseUrl: "https://api.vendor.test/graphql",
      allowedHosts: ["api.vendor.test"],
      auth: { type: "bearer", secret: "keep-secret" },
    });
    createdConnectionIds.push(connection.id);

    // Metadata-only update (no `auth`): reconstruct keeps referencing the derived
    // key as an explicit configKey, so the secret must survive.
    const updated = await upsertScriptConnection({
      id: connection.id,
      slug: "keepVendor",
      kind: "graphql",
      baseUrl: "https://api2.vendor.test/graphql",
      allowedHosts: ["api2.vendor.test"],
    });
    expect(updated.authConfigKey).toBe("connection.keepVendor.secret");
    expect(getSwarmConfigs({ key: "connection.keepVendor.secret" })[0]?.value).toBe("keep-secret");
  });

  test("clearing auth AFTER a rename deletes the renamed derived inline secret", async () => {
    createdConfigKeys.push("connection.renameOne.secret", "connection.renameTwo.secret");
    const connection = await upsertScriptConnection({
      slug: "renameOne",
      kind: "graphql",
      baseUrl: "https://api.vendor.test/graphql",
      allowedHosts: ["api.vendor.test"],
      auth: { type: "bearer", secret: "rename-secret" },
    });
    createdConnectionIds.push(connection.id);
    expect(getSwarmConfigs({ key: "connection.renameOne.secret" })).toHaveLength(1);

    // Metadata-only rename with a blank secret field (no `auth`): reconstruct
    // keeps referencing `connection.renameOne.secret` even though the slug is now
    // renameTwo, so the secret is preserved.
    const renamed = await upsertScriptConnection({
      id: connection.id,
      slug: "renameTwo",
      kind: "graphql",
      baseUrl: "https://api.vendor.test/graphql",
      allowedHosts: ["api.vendor.test"],
    });
    expect(renamed.authConfigKey).toBe("connection.renameOne.secret");
    expect(getSwarmConfigs({ key: "connection.renameOne.secret" })).toHaveLength(1);

    // Later switch to `none`: the owned key is `connection.renameOne.secret`,
    // NOT the slug-derived `connection.renameTwo.secret`. It must be deleted so
    // the encrypted credential is not orphaned.
    const cleared = await upsertScriptConnection({
      id: connection.id,
      slug: "renameTwo",
      kind: "graphql",
      baseUrl: "https://api.vendor.test/graphql",
      allowedHosts: ["api.vendor.test"],
      auth: { type: "none" },
    });
    expect(cleared.authType).toBe("none");
    expect(getSwarmConfigs({ key: "connection.renameOne.secret" })).toHaveLength(0);
  });

  test("a user configKey may not use the reserved connection.*.secret namespace", async () => {
    await expect(
      upsertScriptConnection({
        slug: "reservedVendor",
        kind: "graphql",
        baseUrl: "https://api.vendor.test/graphql",
        allowedHosts: ["api.vendor.test"],
        auth: { type: "bearer", configKey: "connection.someoneElse.secret" },
      }),
    ).rejects.toThrow(/reserved/);
  });

  test("auth:{type:'none'} clears the managed binding", async () => {
    const connection = await upsertScriptConnection({
      slug: "clearVendor",
      kind: "graphql",
      baseUrl: "https://api.vendor.test/graphql",
      allowedHosts: ["api.vendor.test"],
      auth: { type: "bearer", configKey: "CLEAR_KEY" },
    });
    createdConnectionIds.push(connection.id);
    expect(managedBindingFor(connection.id)).toBeTruthy();

    const cleared = await upsertScriptConnection({
      id: connection.id,
      slug: "clearVendor",
      kind: "graphql",
      baseUrl: "https://api.vendor.test/graphql",
      allowedHosts: ["api.vendor.test"],
      auth: { type: "none" },
    });
    expect(cleared.authType).toBe("none");
    expect(cleared.credentialBindingId).toBeNull();
    expect(managedBindingFor(connection.id)).toBeNull();
  });

  test("deleting a connection cascades its managed binding", async () => {
    const connection = await upsertScriptConnection({
      slug: "cascadeVendor",
      kind: "graphql",
      baseUrl: "https://api.vendor.test/graphql",
      allowedHosts: ["api.vendor.test"],
      auth: { type: "bearer", configKey: "CASCADE_KEY" },
    });
    expect(managedBindingFor(connection.id)).toBeTruthy();
    getDb().run("DELETE FROM script_connections WHERE id = ?", connection.id);
    expect(managedBindingFor(connection.id)).toBeNull();
  });

  test("managed bindings are hidden from the standalone list but visible to the broker", async () => {
    const connection = await upsertScriptConnection({
      slug: "hiddenVendor",
      kind: "graphql",
      baseUrl: "https://api.vendor.test/graphql",
      allowedHosts: ["api.vendor.test"],
      auth: { type: "bearer", configKey: "HIDDEN_KEY" },
    });
    createdConnectionIds.push(connection.id);

    const standalone = listRelationalCredentialBindings({
      includeInactive: true,
      excludeManaged: true,
    });
    expect(standalone.some((b) => b.managedByConnectionId === connection.id)).toBe(false);

    const all = listRelationalCredentialBindings({ includeInactive: true });
    expect(all.some((b) => b.managedByConnectionId === connection.id)).toBe(true);
  });

  test("connection auth upsert does NOT adopt a user's standalone raw-fetch binding", async () => {
    // A binding the user created directly (raw fetch egress) — same configKey /
    // scope / header template a connection would derive, but NOT connection-owned.
    const standalone = upsertCredentialBinding({
      configKey: "SHARED_ADOPT_KEY",
      allowedHosts: ["user.example.test"],
      headerTemplate: "Authorization: Bearer [REDACTED:SHARED_ADOPT_KEY]",
      scope: "global",
    });
    expect(standalone.managedByConnectionId).toBeNull();
    expect(standalone.source).toBe("user");

    // A connection whose derived binding matches that identity (but shares no id)
    // must create its OWN managed row, never adopt the standalone one.
    const connection = await upsertScriptConnection({
      slug: "adoptVendor",
      kind: "graphql",
      baseUrl: "https://api.vendor.test/graphql",
      allowedHosts: ["api.vendor.test"],
      auth: { type: "bearer", configKey: "SHARED_ADOPT_KEY" },
    });
    createdConnectionIds.push(connection.id);

    const managed = managedBindingFor(connection.id);
    expect(managed).toBeTruthy();
    expect(managed?.id).not.toBe(standalone.id);

    // The user's standalone row is untouched: still user-owned, still its hosts.
    const row = getDb()
      .prepare<
        { source: string; managed_by_connection_id: string | null; allowed_hosts_json: string },
        [string]
      >(
        "SELECT source, managed_by_connection_id, allowed_hosts_json FROM script_credential_bindings WHERE id = ?",
      )
      .get(standalone.id);
    expect(row?.source).toBe("user");
    expect(row?.managed_by_connection_id).toBeNull();
    expect(JSON.parse(row?.allowed_hosts_json ?? "[]")).toEqual(["user.example.test"]);

    getDb().run("DELETE FROM script_credential_bindings WHERE id = ?", standalone.id);
  });

  test("openapi metadata/auth-only edit preserves the stored spec (no wipe to {})", async () => {
    const created = await upsertScriptConnection({
      slug: "specVendor",
      kind: "openapi",
      baseUrl: "https://api.vendor.test",
      allowedHosts: ["api.vendor.test"],
      openapiSpecJson: openapiSpec(8080),
    });
    createdConnectionIds.push(created.id);
    expect(Object.keys(JSON.parse(created.openapiSpecJson ?? "{}").paths ?? {})).toContain("/me");

    // A name-only edit that omits every spec source must NOT wipe the operations.
    const edited = await upsertScriptConnection({
      id: created.id,
      slug: "specVendor",
      kind: "openapi",
      displayName: "Renamed Vendor",
    });
    const stored = getScriptConnectionById(created.id);
    expect(edited.displayName).toBe("Renamed Vendor");
    expect(Object.keys(JSON.parse(stored?.openapiSpecJson ?? "{}").paths ?? {})).toContain("/me");
  });

  test("mcp connections reject inline auth", async () => {
    await expect(
      upsertScriptConnection({
        slug: "mcpVendor",
        kind: "mcp",
        mcpServerId: crypto.randomUUID(),
        auth: { type: "bearer", secret: "nope" },
      }),
    ).rejects.toThrow(/MCP connections resolve auth/);
  });

  test("legacy SCRIPT_CREDENTIAL_BINDINGS blob migrates once and is idempotent", () => {
    upsertSwarmConfig({
      scope: "global",
      key: "SCRIPT_CREDENTIAL_BINDINGS",
      value: JSON.stringify({
        bindings: [
          {
            configKey: "BLOB_VENDOR_KEY",
            allowedHosts: ["blob.vendor.test"],
            headerTemplate: "Authorization: Bearer [REDACTED:BLOB_VENDOR_KEY]",
          },
        ],
      }),
    });

    const first = migrateLegacyCredentialBindingBlob(getDb());
    expect(first).toBe(1);
    expect(getSwarmConfigs({ key: "SCRIPT_CREDENTIAL_BINDINGS" })).toHaveLength(0);
    const migrated = listRelationalCredentialBindings({ includeInactive: true }).find(
      (b) => b.configKey === "BLOB_VENDOR_KEY",
    );
    expect(migrated?.source).toBe("migration");
    expect(migrated?.managedByConnectionId).toBeNull();

    // Idempotent second pass.
    expect(migrateLegacyCredentialBindingBlob(getDb())).toBe(0);

    getDb().run("DELETE FROM script_credential_bindings WHERE config_key = 'BLOB_VENDOR_KEY'");
  });

  test("agent-scoped blob entries that omit scope inherit the config row scope (no leak)", () => {
    // Legacy blob stored under an agent-scoped swarm_config row. The first entry
    // omits its own scope (must inherit "agent"); the second pins "global"
    // explicitly (must stay global).
    upsertSwarmConfig({
      scope: "agent",
      scopeId: "agent-scope-owner",
      key: "SCRIPT_CREDENTIAL_BINDINGS",
      value: JSON.stringify({
        bindings: [
          {
            configKey: "SCOPED_VENDOR_KEY",
            allowedHosts: ["scoped.vendor.test"],
            headerTemplate: "Authorization: Bearer [REDACTED:SCOPED_VENDOR_KEY]",
          },
          {
            configKey: "GLOBAL_VENDOR_KEY",
            allowedHosts: ["global.vendor.test"],
            headerTemplate: "Authorization: Bearer [REDACTED:GLOBAL_VENDOR_KEY]",
            scope: "global",
          },
        ],
      }),
    });

    expect(migrateLegacyCredentialBindingBlob(getDb())).toBe(2);

    // Read the relational rows directly — listRelationalCredentialBindings
    // applies scope filtering (an agent-scoped row needs an agentId context),
    // and here we want to assert the persisted scope/scope_id verbatim.
    const rowFor = (configKey: string) =>
      getDb()
        .prepare<{ scope: string; scope_id: string | null }, [string]>(
          "SELECT scope, scope_id FROM script_credential_bindings WHERE config_key = ?",
        )
        .get(configKey);

    const scoped = rowFor("SCOPED_VENDOR_KEY");
    expect(scoped?.scope).toBe("agent");
    expect(scoped?.scope_id).toBe("agent-scope-owner");

    const global = rowFor("GLOBAL_VENDOR_KEY");
    expect(global?.scope).toBe("global");
    expect(global?.scope_id).toBeNull();

    getDb().run(
      "DELETE FROM script_credential_bindings WHERE config_key IN ('SCOPED_VENDOR_KEY', 'GLOBAL_VENDOR_KEY')",
    );
  });

  test("sandbox e2e: ctx.api substitutes the embedded secret toward the allowed host", async () => {
    let observedAuth: string | null = null;
    const server = Bun.serve({
      port: 0,
      fetch(req) {
        observedAuth = req.headers.get("authorization");
        return Response.json({ ok: true });
      },
    });
    createdConfigKeys.push("connection.e2eVendor.secret");
    try {
      const connection = await upsertScriptConnection({
        slug: "e2eVendor",
        kind: "openapi",
        baseUrl: `http://127.0.0.1:${server.port}`,
        openapiSpecJson: openapiSpec(server.port),
        auth: { type: "bearer", secret: "e2e-secret-xyz" },
      });
      createdConnectionIds.push(connection.id);
      expect(connection.generationError).toBeNull();

      const output = await runScript({
        agentId: "agent-e2e",
        resources,
        egressSecrets: await buildScriptCredentialBindings({}),
        apiConnections: getScriptApiConnectionDescriptors(),
        source: `
          export default async (_args, ctx) => {
            return await ctx.api.e2eVendor.getMe({});
          };
        `,
      });

      expect(output.error).toBeUndefined();
      expect(output.result).toEqual({ ok: true });
      expect(observedAuth).toBe("Bearer e2e-secret-xyz");
      // The raw secret never appears in script output/logs — only the placeholder.
      expect(JSON.stringify(output)).not.toContain("e2e-secret-xyz");
    } finally {
      server.stop(true);
    }
  });
});
