import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync, unlinkSync } from "node:fs";
import { getDb } from "../be/db";
import { runMigrations } from "../be/migrations/runner";
import {
  extractSpecBaseUrl,
  refreshScriptConnection,
  setOpenapiSpecFetchForTesting,
  upsertScriptConnection,
} from "../be/script-connections";

const createdConnectionIds: string[] = [];
const MIGRATION_DB_PATH = "./test-base-url-provenance-migration.sqlite";

function openapiSpec(server?: string) {
  return JSON.stringify({
    openapi: "3.0.0",
    info: { title: "Base URL fixture", version: "1.0.0" },
    ...(server ? { servers: [{ url: server }] } : {}),
    paths: {
      "/items": {
        get: {
          operationId: "listItems",
          responses: { "200": { description: "OK" } },
        },
      },
    },
  });
}

function removeDbFiles(path: string) {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      unlinkSync(path + suffix);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
  }
}

afterEach(() => {
  setOpenapiSpecFetchForTesting(null);
  for (const id of createdConnectionIds.splice(0)) {
    getDb().run("DELETE FROM script_connections WHERE id = ?", id);
  }
  removeDbFiles(MIGRATION_DB_PATH);
});

describe("extractSpecBaseUrl", () => {
  test("extracts an absolute OpenAPI 3 server URL", () => {
    expect(extractSpecBaseUrl({ servers: [{ url: "https://api.vendor.test/v1" }] })).toBe(
      "https://api.vendor.test/v1",
    );
  });

  test("resolves a relative OpenAPI 3 server URL against the spec URL", () => {
    expect(
      extractSpecBaseUrl(
        { servers: [{ url: "../api/v1" }] },
        "https://docs.vendor.test/openapi/spec.json",
      ),
    ).toBe("https://docs.vendor.test/api/v1");
  });

  test("substitutes templated OpenAPI 3 server variables only when they have defaults", () => {
    expect(
      extractSpecBaseUrl({
        servers: [
          {
            url: "https://{tenant}.vendor.test/{version}",
            variables: {
              tenant: { default: "api" },
              version: { default: "v2" },
            },
          },
        ],
      }),
    ).toBe("https://api.vendor.test/v2");
    expect(
      extractSpecBaseUrl({
        servers: [{ url: "https://{tenant}.vendor.test", variables: { tenant: {} } }],
      }),
    ).toBeNull();
  });

  test("extracts Swagger 2 host, basePath, and prefers https schemes", () => {
    expect(
      extractSpecBaseUrl({
        swagger: "2.0",
        host: "api.vendor.test",
        basePath: "/v1",
        schemes: ["http", "https"],
      }),
    ).toBe("https://api.vendor.test/v1");
  });
});

describe("OpenAPI base URL provenance", () => {
  test("requires a caller baseUrl when the spec declares no server", async () => {
    await expect(
      upsertScriptConnection({
        slug: `noServer${crypto.randomUUID().slice(0, 8)}`,
        kind: "openapi",
        openapiSpecJson: openapiSpec(),
      }),
    ).rejects.toThrow(
      "baseUrl is required for OpenAPI connections when the spec has no server URL",
    );
  });

  test("uses a spec URL by default and reports an explicit user override mismatch", async () => {
    const specDerived = await upsertScriptConnection({
      slug: `specDerived${crypto.randomUUID().slice(0, 8)}`,
      kind: "openapi",
      openapiSpecJson: openapiSpec("https://api.vendor.test/v1"),
    });
    createdConnectionIds.push(specDerived.id);
    expect(specDerived.baseUrl).toBe("https://api.vendor.test/v1");
    expect(specDerived.baseUrlSource).toBe("spec");
    expect(specDerived.allowedHosts).toEqual(["api.vendor.test"]);

    const userOverride = await upsertScriptConnection({
      slug: `userOverride${crypto.randomUUID().slice(0, 8)}`,
      kind: "openapi",
      baseUrl: "https://proxy.vendor.test/v1",
      openapiSpecJson: openapiSpec("https://api.vendor.test/v1"),
    });
    createdConnectionIds.push(userOverride.id);
    expect(userOverride.baseUrlSource).toBe("user");
    expect(userOverride.baseUrlMismatch).toEqual({
      specUrl: "https://api.vendor.test/v1",
      effectiveUrl: "https://proxy.vendor.test/v1",
    });
  });

  test("slug-keyed re-upsert preserves a stored user baseUrl when the new spec has no server", async () => {
    const slug = `preserveBase${crypto.randomUUID().slice(0, 8)}`;
    const created = await upsertScriptConnection({
      slug,
      kind: "openapi",
      baseUrl: "https://api.vendor.test/v1",
      openapiSpecJson: openapiSpec(),
    });
    createdConnectionIds.push(created.id);

    const updated = await upsertScriptConnection({
      slug,
      kind: "openapi",
      openapiSpecJson: openapiSpec(),
    });

    expect(updated.id).toBe(created.id);
    expect(updated.baseUrl).toBe("https://api.vendor.test/v1");
    expect(updated.baseUrlSource).toBe("user");
  });

  test("defaults allowedHosts from an explicit user baseUrl", async () => {
    const connection = await upsertScriptConnection({
      slug: `userHostDefault${crypto.randomUUID().slice(0, 8)}`,
      kind: "openapi",
      baseUrl: "https://api.vendor.test/v1",
      openapiSpecJson: openapiSpec(),
    });
    createdConnectionIds.push(connection.id);

    expect(connection.allowedHosts).toEqual(["api.vendor.test"]);
  });

  test("refresh re-derives default allowedHosts and preserves user URL overrides", async () => {
    const specUrl = `http://script-openapi.test/${crypto.randomUUID()}/openapi.json`;
    let responseBody = openapiSpec("https://api.vendor.test/v1");
    let etag = '"v1"';
    setOpenapiSpecFetchForTesting(
      (async () =>
        new Response(responseBody, {
          status: 200,
          headers: { ETag: etag, "Content-Type": "application/json" },
        })) as typeof fetch,
    );

    const specDerived = await upsertScriptConnection({
      slug: `refreshSpec${crypto.randomUUID().slice(0, 8)}`,
      kind: "openapi",
      openapiSpecUrl: specUrl,
    });
    const userSet = await upsertScriptConnection({
      slug: `refreshUser${crypto.randomUUID().slice(0, 8)}`,
      kind: "openapi",
      baseUrl: "https://proxy.vendor.test/v1",
      openapiSpecUrl: specUrl,
    });
    const customAllowedHosts = await upsertScriptConnection({
      slug: `refreshCustomHosts${crypto.randomUUID().slice(0, 8)}`,
      kind: "openapi",
      allowedHosts: ["custom-egress.vendor.test"],
      openapiSpecUrl: specUrl,
    });
    createdConnectionIds.push(specDerived.id, userSet.id, customAllowedHosts.id);

    responseBody = openapiSpec("https://new-api.vendor.test/v2");
    etag = '"v2"';
    const refreshedSpec = await refreshScriptConnection(specDerived.id);
    const refreshedUser = await refreshScriptConnection(userSet.id);
    const refreshedCustomHosts = await refreshScriptConnection(customAllowedHosts.id);

    expect(refreshedSpec?.baseUrl).toBe("https://new-api.vendor.test/v2");
    expect(refreshedSpec?.baseUrlSource).toBe("spec");
    expect(refreshedSpec?.allowedHosts).toEqual(["new-api.vendor.test"]);
    expect(refreshedUser?.baseUrl).toBe("https://proxy.vendor.test/v1");
    expect(refreshedUser?.baseUrlSource).toBe("user");
    expect(refreshedUser?.baseUrlMismatch).toEqual({
      specUrl: "https://new-api.vendor.test/v2",
      effectiveUrl: "https://proxy.vendor.test/v1",
    });
    expect(refreshedCustomHosts?.baseUrl).toBe("https://new-api.vendor.test/v2");
    expect(refreshedCustomHosts?.allowedHosts).toEqual(["custom-egress.vendor.test"]);
  });
});

describe("migration 117 consolidated connections-redesign schema", () => {
  test("gives existing script connection rows the user source default", () => {
    removeDbFiles(MIGRATION_DB_PATH);
    const database = new Database(MIGRATION_DB_PATH, { create: true });
    try {
      database.run(`
        CREATE TABLE _migrations (
          version INTEGER PRIMARY KEY,
          name TEXT NOT NULL,
          applied_at TEXT NOT NULL,
          checksum TEXT NOT NULL
        )
      `);
      const migration117 = readFileSync(
        new URL("../be/migrations/117_unified_oauth.sql", import.meta.url),
        "utf-8",
      );
      database
        .prepare(
          "INSERT INTO _migrations (version, name, applied_at, checksum) VALUES (?, ?, ?, ?)",
        )
        .run(
          117,
          "117_unified_oauth",
          new Date().toISOString(),
          new Bun.CryptoHasher("sha256").update(migration117).digest("hex"),
        );
      runMigrations(database);
      database.run(
        `INSERT INTO script_connections (id, slug, kind, base_url)
         VALUES ('existing', 'existing', 'raw', 'https://api.vendor.test')`,
      );
      database.run("DELETE FROM _migrations WHERE version = 117");
      runMigrations(database);
      expect(
        database
          .prepare<{ base_url_source: string }, []>(
            "SELECT base_url_source FROM script_connections WHERE id = 'existing'",
          )
          .get()?.base_url_source,
      ).toBe("user");
    } finally {
      database.close();
    }
  });
});
