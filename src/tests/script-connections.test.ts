import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createAgent, deleteSwarmConfig, getDb, upsertSwarmConfig } from "../be/db";
import { runMigrations } from "../be/migrations/runner";
import {
  fetchOpenapiSpec,
  getScriptApiConnectionDescriptors,
  refreshScriptConnection,
  setOpenapiSpecFetchForTesting,
  upsertCredentialBinding,
  upsertScriptConnection,
} from "../be/script-connections";
import { buildScriptCredentialBindings } from "../be/script-credential-broker";
import { typecheckScript } from "../be/scripts/typecheck";
import { runScript } from "../scripts-runtime/loader";
import { registerScriptConnectionsTool } from "../tools/script-connections";

const createdBindingIds: string[] = [];
const createdConnectionIds: string[] = [];
const createdConfigIds: string[] = [];
const originalFetch = globalThis.fetch;
const savedEnv = { ...process.env };
const resources = { memoryMb: 2048, cpuTimeSec: 20, maxStdoutBytes: 1_048_576 };
const MIGRATION_REBUILD_DB_PATH = "./test-script-connections-graphql-migration.sqlite";

type RegisteredTool = {
  handler: (args: unknown, extra: unknown) => Promise<unknown>;
};

function scriptConnectionsTool() {
  const server = new McpServer({ name: "script-connections-test", version: "1.0.0" });
  registerScriptConnectionsTool(server);
  const registered = (server as unknown as { _registeredTools: Record<string, RegisteredTool> })
    ._registeredTools;
  const tool = registered["script-connections"];
  if (!tool) throw new Error("script-connections tool not registered");
  return tool;
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

function migrationsDir() {
  return new URL("../be/migrations", import.meta.url).pathname;
}

function migrationSql(file: string) {
  return readFileSync(join(migrationsDir(), file), "utf-8");
}

function markMigrationsAppliedThrough(database: Database, throughVersion: number) {
  database.run(`
    CREATE TABLE IF NOT EXISTS _migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL,
      checksum TEXT NOT NULL
    )
  `);
  const files = readdirSync(migrationsDir())
    .filter((file) => file.endsWith(".sql"))
    .sort();
  const insert = database.prepare(
    "INSERT INTO _migrations (version, name, applied_at, checksum) VALUES (?, ?, ?, ?)",
  );
  for (const file of files) {
    const version = Number.parseInt(file.split("_")[0] ?? "0", 10);
    if (!version || version > throughVersion) continue;
    const sql = migrationSql(file);
    const checksum = createHash("sha256").update(sql).digest("hex");
    insert.run(version, file.replace(".sql", ""), new Date().toISOString(), checksum);
  }
}

function meta(agentId: string) {
  return {
    sessionId: "script-connections-test-session",
    requestInfo: { headers: { "x-agent-id": agentId } },
  };
}

type OpenapiSpecFixture = {
  body: string;
  etag: string;
  requests: Array<{ accept: string | null; ifNoneMatch: string | null }>;
};

const openapiSpecFixtures = new Map<string, OpenapiSpecFixture>();

const fixtureOpenapiFetch: typeof fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  const fixture = openapiSpecFixtures.get(url.toString());
  if (!fixture) return new Response("not found", { status: 404 });
  const headers = new Headers(input instanceof Request ? input.headers : init?.headers);
  const ifNoneMatch = headers.get("if-none-match");
  fixture.requests.push({
    accept: headers.get("accept"),
    ifNoneMatch,
  });
  if (ifNoneMatch === fixture.etag) {
    return new Response(null, { status: 304, headers: { ETag: fixture.etag } });
  }
  return new Response(fixture.body, {
    headers: { "Content-Type": "application/json", ETag: fixture.etag },
  });
};

const openapiSpec = JSON.stringify({
  openapi: "3.1.0",
  info: { title: "Vendor", version: "1.0.0" },
  paths: {
    "/repos/{owner}/{repo}": {
      get: {
        operationId: "getRepo",
        parameters: [
          { name: "owner", in: "path", required: true, schema: { type: "string" } },
          { name: "repo", in: "path", required: true, schema: { type: "string" } },
          { name: "include", in: "query", schema: { type: "string" } },
        ],
        responses: {
          "200": {
            description: "repo",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["full_name"],
                  properties: {
                    full_name: { type: "string" },
                    private: { type: "boolean" },
                  },
                },
              },
            },
          },
        },
      },
    },
    "/repos": {
      post: {
        operationId: "createRepo",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["name"],
                properties: {
                  name: { type: "string" },
                  private: { type: "boolean" },
                },
              },
            },
          },
        },
        responses: {
          "201": {
            description: "created repo",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["full_name"],
                  properties: {
                    full_name: { type: "string" },
                  },
                },
              },
            },
          },
        },
      },
    },
  },
});

function specWithExtraOperation(operationId: string) {
  const spec = JSON.parse(openapiSpec) as {
    paths: Record<string, Record<string, unknown>>;
  };
  spec.paths["/orgs/{org}/repos"] = {
    get: {
      operationId,
      parameters: [{ name: "org", in: "path", required: true, schema: { type: "string" } }],
      responses: {
        "200": {
          description: "repos",
          content: {
            "application/json": {
              schema: {
                type: "array",
                items: {
                  type: "object",
                  required: ["name"],
                  properties: { name: { type: "string" } },
                },
              },
            },
          },
        },
      },
    },
  };
  return JSON.stringify(spec);
}

function serveOpenapiSpec(initialBody: string, initialEtag = '"v1"') {
  const fixtureUrl = `http://script-openapi.test/${crypto.randomUUID()}/openapi.json`;
  const fixture: OpenapiSpecFixture = {
    body: initialBody,
    etag: initialEtag,
    requests: [],
  };
  openapiSpecFixtures.set(fixtureUrl, fixture);
  return {
    requests: fixture.requests,
    url: fixtureUrl,
    baseUrl: new URL(fixtureUrl).origin,
    setBody(nextBody: string, nextEtag: string) {
      fixture.body = nextBody;
      fixture.etag = nextEtag;
    },
    stop() {
      openapiSpecFixtures.delete(fixtureUrl);
    },
  };
}

beforeEach(() => {
  process.env.AGENT_SWARM_API_KEY = "script-connections-test-key";
  delete process.env.API_KEY;
  process.env.MCP_BASE_URL = "http://localhost:3013";
  setOpenapiSpecFetchForTesting(fixtureOpenapiFetch);
});

afterEach(() => {
  setOpenapiSpecFetchForTesting(null);
  openapiSpecFixtures.clear();
  globalThis.fetch = originalFetch;
  for (const key of Object.keys(process.env)) {
    if (!(key in savedEnv)) delete process.env[key];
  }
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  const db = getDb();
  for (const id of createdConnectionIds.splice(0)) {
    db.run("DELETE FROM script_connections WHERE id = ?", id);
  }
  for (const id of createdBindingIds.splice(0)) {
    db.run("DELETE FROM script_credential_bindings WHERE id = ?", id);
  }
  for (const id of createdConfigIds.splice(0)) {
    deleteSwarmConfig(id);
  }
  removeDbFiles(MIGRATION_REBUILD_DB_PATH);
});

describe("script connections", () => {
  test("relational credential bindings are resolved before legacy JSON config", async () => {
    const binding = upsertCredentialBinding({
      configKey: "REL_VENDOR_KEY",
      allowedHosts: ["api.vendor.test"],
      headerTemplate: "Authorization: Bearer [REDACTED:REL_VENDOR_KEY]",
    });
    createdBindingIds.push(binding.id);
    const secretConfig = upsertSwarmConfig({
      scope: "global",
      key: "REL_VENDOR_KEY",
      value: "rel-secret",
      isSecret: true,
    });
    createdConfigIds.push(secretConfig.id);

    const egressSecrets = await buildScriptCredentialBindings({});

    expect(egressSecrets).toContainEqual(
      expect.objectContaining({
        configKey: "REL_VENDOR_KEY",
        allowedHosts: ["api.vendor.test"],
        value: "rel-secret",
      }),
    );
  });

  test("credential binding upsert is idempotent by binding identity", () => {
    const first = upsertCredentialBinding({
      configKey: "IDEMPOTENT_VENDOR_KEY",
      allowedHosts: ["old.vendor.test"],
      headerTemplate: "Authorization: Bearer [REDACTED:IDEMPOTENT_VENDOR_KEY]",
    });
    createdBindingIds.push(first.id);

    const second = upsertCredentialBinding({
      configKey: "IDEMPOTENT_VENDOR_KEY",
      allowedHosts: ["new.vendor.test"],
      headerTemplate: "Authorization: Bearer [REDACTED:IDEMPOTENT_VENDOR_KEY]",
    });

    expect(second.id).toBe(first.id);
    expect(second.allowedHosts).toEqual(["new.vendor.test"]);
  });

  test("OpenAPI connections generate full ctx.api method, args, and response types", async () => {
    const binding = upsertCredentialBinding({
      configKey: "TYPE_VENDOR_KEY",
      allowedHosts: ["api.vendor.test"],
      headerTemplate: "Authorization: Bearer [REDACTED:TYPE_VENDOR_KEY]",
    });
    createdBindingIds.push(binding.id);
    const connection = await upsertScriptConnection({
      slug: "vendorApi",
      kind: "openapi",
      baseUrl: "https://api.vendor.test",
      credentialBindingId: binding.id,
      openapiSpecJson: openapiSpec,
    });
    createdConnectionIds.push(connection.id);

    expect(connection.generationError).toBeNull();
    const source = `
      import type { ScriptMain } from "swarm-sdk";
      const main: ScriptMain = async (_args, ctx) => {
        const repo = await ctx.api.vendorApi.getRepo({
          path: { owner: "desplega-ai", repo: "agent-swarm" },
          query: { include: "stats" },
        });
        const created = await ctx.api.vendorApi.createRepo({
          body: { name: "agent-swarm", private: false },
        });
        const raw = await ctx.api.vendorApi.getRepo({
          path: { owner: "desplega-ai", repo: "agent-swarm" },
        }, { raw: true });
        const name: string = repo.full_name;
        const createdName: string = created.full_name;
        const isPrivate: boolean | undefined = repo.private;
        const rawStatus: number = raw.status;
        const rawBody: ArrayBuffer = await raw.response.arrayBuffer();
        return { name, createdName, isPrivate, rawStatus, rawBody };
      };
      export default main;
    `;

    expect(typecheckScript(source)).toEqual({ ok: true });
    expect(connection.generatedTypes).toContain(
      "getRepo(args: VendorApiGetRepoArgs, options: ScriptApiRawOptions): Promise<ScriptApiRawResult>;",
    );
    const descriptor = getScriptApiConnectionDescriptors().find(
      (candidate) => candidate.slug === "vendorApi",
    );
    const getRepo = descriptor?.operations.find((operation) => operation.name === "getRepo");
    expect(getRepo?.parameters).toContainEqual({
      name: "owner",
      in: "path",
      required: true,
      schema: { type: "string" },
    });
    expect(getRepo?.responseSchema).toEqual({
      type: "object",
      required: ["full_name"],
      properties: {
        full_name: { type: "string" },
        private: { type: "boolean" },
      },
    });
    const createRepo = descriptor?.operations.find((operation) => operation.name === "createRepo");
    expect(createRepo?.requestBodySchema).toEqual({
      type: "object",
      required: ["name"],
      properties: {
        name: { type: "string" },
        private: { type: "boolean" },
      },
    });
  });

  test("GET operations never generate a body even when the spec declares one", async () => {
    // readme.io-exported specs (e.g. Notion on apis.guru) declare form-encoded
    // requestBody on GET operations; fetch() rejects GET bodies.
    const spec = JSON.stringify({
      openapi: "3.0.0",
      info: { title: "Readmeio", version: "1.0.0" },
      paths: {
        "/v1/users/{id}": {
          get: {
            operationId: "retrieveAUser",
            parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
            requestBody: {
              content: {
                "application/x-www-form-urlencoded": { schema: { type: "object" } },
              },
            },
            responses: { "200": { description: "ok" } },
          },
          post: {
            operationId: "updateAUser",
            parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
            requestBody: {
              content: { "application/json": { schema: { type: "object" } } },
            },
            responses: { "200": { description: "ok" } },
          },
        },
      },
    });
    const connection = await upsertScriptConnection({
      slug: "readmeio",
      kind: "openapi",
      baseUrl: "https://api.readmeio.test",
      openapiSpecJson: spec,
    });
    createdConnectionIds.push(connection.id);

    expect(connection.generationError).toBeNull();
    const runtime = JSON.parse(connection.generatedRuntimeJson ?? "{}") as {
      operations: Array<{ name: string; hasBody: boolean }>;
    };
    const byName = new Map(runtime.operations.map((op) => [op.name, op]));
    expect(byName.get("retrieveAUser")?.hasBody).toBe(false);
    expect(byName.get("updateAUser")?.hasBody).toBe(true);
    // the generated GET args type must not demand a body either
    expect(connection.generatedTypes).not.toMatch(/RetrieveAUserArgs = \{[^}]*body/);
  });

  test("GraphQL connections generate ctx.api descriptor and graphql method types", async () => {
    const binding = upsertCredentialBinding({
      configKey: "GRAPHQL_VENDOR_KEY",
      allowedHosts: ["countries.vendor.test"],
      headerTemplate: "Authorization: Bearer [REDACTED:GRAPHQL_VENDOR_KEY]",
    });
    createdBindingIds.push(binding.id);

    const connection = await upsertScriptConnection({
      slug: "countries",
      kind: "graphql",
      baseUrl: "https://countries.vendor.test/graphql",
      allowedHosts: ["countries.vendor.test"],
      credentialBindingId: binding.id,
    });
    createdConnectionIds.push(connection.id);

    expect(connection.generationError).toBeNull();
    expect(connection.generatedRuntimeJson).toBe(
      JSON.stringify({
        slug: "countries",
        kind: "graphql",
        baseUrl: "https://countries.vendor.test/graphql",
        credential: {
          configKey: "GRAPHQL_VENDOR_KEY",
          headerTemplate: "Authorization: Bearer [REDACTED:GRAPHQL_VENDOR_KEY]",
        },
      }),
    );
    expect(connection.generatedTypes).toContain("interface CountriesApi");
    expect(connection.generatedTypes).toContain(
      "graphql<T = JsonValue>(query: string, variables?: Record<string, JsonValue>): Promise<T>;",
    );

    const descriptor = getScriptApiConnectionDescriptors().find(
      (candidate) => candidate.slug === "countries",
    );
    expect(descriptor).toEqual({
      slug: "countries",
      kind: "graphql",
      baseUrl: "https://countries.vendor.test/graphql",
      credential: {
        configKey: "GRAPHQL_VENDOR_KEY",
        headerTemplate: "Authorization: Bearer [REDACTED:GRAPHQL_VENDOR_KEY]",
      },
    });

    const source = `
      import type { ScriptMain } from "swarm-sdk";
      const main: ScriptMain = async (_args, ctx) => {
        const result = await ctx.api.countries.graphql<{ country: { name: string; capital: string } }>(
          "query Country($code: ID!) { country(code: $code) { name capital } }",
          { code: "UA" },
        );
        const name: string = result.country.name;
        const capital: string = result.country.capital;
        return { name, capital };
      };
      export default main;
    `;

    expect(typecheckScript(source)).toEqual({ ok: true });
  });

  test("migration 112 rebuild preserves existing script connection rows", () => {
    removeDbFiles(MIGRATION_REBUILD_DB_PATH);
    const database = new Database(MIGRATION_REBUILD_DB_PATH, { create: true });
    try {
      database.run("CREATE TABLE users (id TEXT PRIMARY KEY)");
      database.run("CREATE TABLE mcp_servers (id TEXT PRIMARY KEY)");
      database.exec(migrationSql("101_script_connections.sql"));
      database.exec(migrationSql("111_oauth_credential_bindings.sql"));
      markMigrationsAppliedThrough(database, 111);

      const id = crypto.randomUUID();
      const now = new Date().toISOString();
      database.run(
        `INSERT INTO script_connections (
          id, slug, display_name, kind, scope, scope_id, base_url, allowed_hosts_json,
          credential_binding_id, openapi_spec_source_kind, openapi_spec_source,
          openapi_spec_json, openapi_spec_etag, openapi_spec_fetched_at, mcp_server_id,
          generated_types, generated_runtime_json, generated_at, generation_error, enabled,
          version, created_at, updated_at, created_by, updated_by
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          "preGraphql",
          "Pre GraphQL",
          "raw",
          "global",
          null,
          "https://api.vendor.test",
          JSON.stringify(["api.vendor.test"]),
          null,
          null,
          null,
          null,
          null,
          null,
          null,
          "export interface PreGraphqlApi {}",
          JSON.stringify({ slug: "preGraphql", baseUrl: "https://api.vendor.test" }),
          now,
          null,
          1,
          7,
          now,
          now,
          null,
          null,
        ],
      );

      runMigrations(database);

      const preserved = database
        .prepare<
          {
            slug: string;
            kind: string;
            allowed_hosts_json: string;
            generated_runtime_json: string | null;
            version: number;
          },
          [string]
        >(
          `SELECT slug, kind, allowed_hosts_json, generated_runtime_json, version
           FROM script_connections WHERE id = ?`,
        )
        .get(id);
      expect(preserved).toEqual({
        slug: "preGraphql",
        kind: "raw",
        allowed_hosts_json: JSON.stringify(["api.vendor.test"]),
        generated_runtime_json: JSON.stringify({
          slug: "preGraphql",
          baseUrl: "https://api.vendor.test",
        }),
        version: 7,
      });

      const indexes = database
        .prepare<{ name: string }, []>(
          "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'script_connections'",
        )
        .all()
        .map((row) => row.name);
      expect(indexes).toContain("idx_script_connections_slug_scope");
      expect(indexes).toContain("idx_script_connections_kind_enabled");

      expect(() => {
        database.run(
          `INSERT INTO script_connections (
            id, slug, kind, scope, base_url, allowed_hosts_json, generated_types,
            generated_runtime_json, generated_at, created_at, updated_at
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            crypto.randomUUID(),
            "postGraphql",
            "graphql",
            "global",
            "https://graphql.vendor.test",
            JSON.stringify(["graphql.vendor.test"]),
            "export interface PostGraphqlApi {}",
            JSON.stringify({ slug: "postGraphql", kind: "graphql" }),
            now,
            now,
            now,
          ],
        );
      }).not.toThrow();
    } finally {
      database.close();
    }
  });

  test("OpenAPI connections can be registered from a spec URL", async () => {
    const server = serveOpenapiSpec(openapiSpec);
    try {
      const suffix = crypto.randomUUID().replace(/-/g, "");
      const connection = await upsertScriptConnection({
        slug: `urlVendor${suffix}`,
        kind: "openapi",
        baseUrl: server.baseUrl,
        openapiSpecUrl: server.url,
      });
      createdConnectionIds.push(connection.id);

      expect(connection.generationError).toBeNull();
      expect(connection.openapiSpecSourceKind).toBe("url");
      expect(connection.openapiSpecSource).toBe(server.url);
      expect(connection.openapiSpecJson).toBe(JSON.stringify(JSON.parse(openapiSpec)));
      expect(connection.openapiSpecEtag).toBe('"v1"');
      expect(connection.openapiSpecFetchedAt).toBeString();
      expect(server.requests).toEqual([
        {
          accept: "application/json, application/yaml;q=0.9, text/yaml;q=0.8, */*;q=0.5",
          ifNoneMatch: null,
        },
      ]);
      expect(connection.generatedTypes).toContain("getRepo");
    } finally {
      server.stop();
    }
  });

  test("OpenAPI spec fetch rejects redirects to unsafe hosts in production", async () => {
    process.env.NODE_ENV = "production";
    const requests: Array<{ url: string; redirect?: RequestRedirect }> = [];
    setOpenapiSpecFetchForTesting((async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      requests.push({ url, redirect: init?.redirect });
      if (url === "https://spec.vendor.test/openapi.json") {
        return new Response(null, {
          status: 302,
          headers: { location: "http://127.0.0.1/spec.json" },
        });
      }
      return new Response(openapiSpec, { status: 200 });
    }) as typeof fetch);

    await expect(fetchOpenapiSpec("https://spec.vendor.test/openapi.json")).rejects.toThrow(
      /private IPv4|insecure/,
    );
    expect(requests).toEqual([
      { url: "https://spec.vendor.test/openapi.json", redirect: "manual" },
    ]);
  });

  test("OpenAPI spec fetch fails closed when NODE_ENV is unset", async () => {
    // Production images often run with NODE_ENV undefined — the SSRF guard
    // must NOT treat that as development.
    delete process.env.NODE_ENV;
    delete process.env.ALLOW_PRIVATE_NETWORK_URLS;
    setOpenapiSpecFetchForTesting((async () => {
      throw new Error("fetch should not be reached for unsafe URLs");
    }) as unknown as typeof fetch);

    await expect(fetchOpenapiSpec("http://127.0.0.1/openapi.json")).rejects.toThrow(
      /private IPv4|insecure/,
    );

    // ...and the explicit override re-enables local fetches for dev setups.
    process.env.ALLOW_PRIVATE_NETWORK_URLS = "true";
    setOpenapiSpecFetchForTesting(
      (async () => new Response(openapiSpec, { status: 200 })) as unknown as typeof fetch,
    );
    const fetched = await fetchOpenapiSpec("http://127.0.0.1/openapi.json");
    expect(fetched.status).toBe("fetched");
  });

  test("YAML specs are accepted from a URL and canonicalized to JSON", async () => {
    const yamlSpec = [
      "openapi: 3.0.0",
      "info:",
      "  title: YamlVendor",
      "  version: 1.0.0",
      "paths:",
      "  /things/{id}:",
      "    get:",
      "      operationId: getThing",
      "      parameters:",
      "        - name: id",
      "          in: path",
      "          required: true",
      "          schema:",
      "            type: string",
      "      responses:",
      '        "200":',
      "          description: ok",
      "",
    ].join("\n");
    const server = serveOpenapiSpec(yamlSpec);
    try {
      const suffix = crypto.randomUUID().replace(/-/g, "");
      const connection = await upsertScriptConnection({
        slug: `yamlVendor${suffix}`,
        kind: "openapi",
        baseUrl: server.baseUrl,
        openapiSpecUrl: server.url,
      });
      createdConnectionIds.push(connection.id);

      expect(connection.generationError).toBeNull();
      // stored canonically as JSON regardless of the fetched format
      expect(JSON.parse(connection.openapiSpecJson ?? "{}")).toMatchObject({
        openapi: "3.0.0",
        info: { title: "YamlVendor" },
      });
      expect(connection.generatedTypes).toContain("getThing");
    } finally {
      server.stop();
    }
  });

  test("inline YAML specs are accepted and canonicalized to JSON", async () => {
    const suffix = crypto.randomUUID().replace(/-/g, "");
    const connection = await upsertScriptConnection({
      slug: `yamlInline${suffix}`,
      kind: "openapi",
      baseUrl: "https://api.yaml-inline.test",
      openapiSpecJson: [
        "openapi: 3.0.0",
        "info: { title: InlineYaml, version: 1.0.0 }",
        "paths:",
        "  /ping:",
        "    get:",
        "      operationId: ping",
        "      responses:",
        '        "200": { description: ok }',
      ].join("\n"),
    });
    createdConnectionIds.push(connection.id);

    expect(connection.generationError).toBeNull();
    expect(JSON.parse(connection.openapiSpecJson ?? "{}")).toMatchObject({
      info: { title: "InlineYaml" },
    });
    expect(connection.generatedTypes).toContain("ping");
  });

  test("refresh sends If-None-Match and only bumps fetched_at on 304", async () => {
    const server = serveOpenapiSpec(openapiSpec);
    try {
      const suffix = crypto.randomUUID().replace(/-/g, "");
      const connection = await upsertScriptConnection({
        slug: `etagVendor${suffix}`,
        kind: "openapi",
        baseUrl: server.baseUrl,
        openapiSpecUrl: server.url,
      });
      createdConnectionIds.push(connection.id);
      await Bun.sleep(5);

      const refreshed = await refreshScriptConnection(connection.id);

      expect(refreshed).toBeDefined();
      expect(refreshed?.version).toBe(connection.version);
      expect(refreshed?.openapiSpecEtag).toBe('"v1"');
      expect(refreshed?.generatedRuntimeJson).toBe(connection.generatedRuntimeJson);
      expect(refreshed?.openapiSpecFetchedAt).not.toBe(connection.openapiSpecFetchedAt);
      const specAccept = "application/json, application/yaml;q=0.9, text/yaml;q=0.8, */*;q=0.5";
      expect(server.requests).toEqual([
        { accept: specAccept, ifNoneMatch: null },
        { accept: specAccept, ifNoneMatch: '"v1"' },
      ]);
    } finally {
      server.stop();
    }
  });

  test("refresh updates changed URL specs and regenerates types", async () => {
    const server = serveOpenapiSpec(openapiSpec);
    try {
      const suffix = crypto.randomUUID().replace(/-/g, "");
      const connection = await upsertScriptConnection({
        slug: `changedVendor${suffix}`,
        kind: "openapi",
        baseUrl: server.baseUrl,
        openapiSpecUrl: server.url,
      });
      createdConnectionIds.push(connection.id);
      expect(connection.generatedTypes).not.toContain("listOrgRepos");

      server.setBody(specWithExtraOperation("listOrgRepos"), '"v2"');
      const refreshed = await refreshScriptConnection(connection.id);

      expect(refreshed?.version).toBe(connection.version + 1);
      expect(refreshed?.openapiSpecEtag).toBe('"v2"');
      expect(refreshed?.generationError).toBeNull();
      expect(refreshed?.generatedTypes).toContain("listOrgRepos");
      const descriptor = getScriptApiConnectionDescriptors().find(
        (candidate) => candidate.slug === connection.slug,
      );
      expect(descriptor?.operations.some((operation) => operation.name === "listOrgRepos")).toBe(
        true,
      );
    } finally {
      server.stop();
    }
  });

  test("invalid fetched OpenAPI specs are stored with generation_error", async () => {
    const invalidSpec = JSON.stringify({
      openapi: "3.1.0",
      info: { title: "Invalid", version: "1.0.0" },
      paths: {},
    });
    const server = serveOpenapiSpec(invalidSpec);
    try {
      const suffix = crypto.randomUUID().replace(/-/g, "");
      const connection = await upsertScriptConnection({
        slug: `invalidVendor${suffix}`,
        kind: "openapi",
        baseUrl: server.baseUrl,
        openapiSpecUrl: server.url,
      });
      createdConnectionIds.push(connection.id);

      expect(connection.openapiSpecSourceKind).toBe("url");
      expect(connection.generationError).toContain("supported operations");
      expect(connection.generatedTypes).toBeNull();
    } finally {
      server.stop();
    }
  });

  test("invalid fetched spec content is rejected before storing a connection", async () => {
    const server = serveOpenapiSpec("{not-valid-json");
    try {
      const suffix = crypto.randomUUID().replace(/-/g, "");

      await expect(
        upsertScriptConnection({
          slug: `badContentVendor${suffix}`,
          kind: "openapi",
          baseUrl: server.baseUrl,
          openapiSpecUrl: server.url,
        }),
      ).rejects.toThrow(/valid JSON|valid YAML|JSON specs only/);

      const stored = getDb()
        .prepare<{ count: number }, [string]>(
          "SELECT COUNT(*) AS count FROM script_connections WHERE slug = ?",
        )
        .get(`badContentVendor${suffix}`);
      expect(stored?.count).toBe(0);
    } finally {
      server.stop();
    }
  });

  test("script-connections tool registers OpenAPI connections from an agent header without FK failures", async () => {
    const suffix = crypto.randomUUID().replace(/-/g, "");
    const slug = `agentHeaderVendor${suffix}`;
    const configKey = `AGENT_HEADER_VENDOR_KEY_${suffix}`;
    const lead = createAgent({
      name: `script-connections-lead-${crypto.randomUUID()}`,
      isLead: true,
      status: "idle",
    });
    const tool = scriptConnectionsTool();

    const result = (await tool.handler(
      {
        action: "upsert-openapi",
        slug,
        displayName: "Agent Header Vendor",
        baseUrl: "https://api.vendor.test",
        allowedHosts: ["api.vendor.test"],
        configKey,
        openapiSpecJson: openapiSpec,
      },
      meta(lead.id),
    )) as {
      structuredContent: { success: boolean; message: string; connections: Array<{ id: string }> };
    };

    expect(result.structuredContent.success).toBe(true);

    const db = getDb();
    const connectionRow = db
      .prepare<
        {
          id: string;
          credential_binding_id: string | null;
          created_by: string | null;
          updated_by: string | null;
        },
        [string]
      >(
        "SELECT id, credential_binding_id, created_by, updated_by FROM script_connections WHERE slug = ?",
      )
      .get(slug);
    expect(connectionRow).toBeDefined();
    expect(connectionRow?.created_by).toBeNull();
    expect(connectionRow?.updated_by).toBeNull();
    createdConnectionIds.push(connectionRow!.id);

    const bindingRow = db
      .prepare<{ id: string; created_by: string | null; updated_by: string | null }, [string]>(
        "SELECT id, created_by, updated_by FROM script_credential_bindings WHERE config_key = ?",
      )
      .get(configKey);
    expect(bindingRow).toBeDefined();
    expect(bindingRow?.id).toBe(connectionRow?.credential_binding_id);
    expect(bindingRow?.created_by).toBeNull();
    expect(bindingRow?.updated_by).toBeNull();
    createdBindingIds.push(bindingRow!.id);
  });

  test("script-connections tool can upsert OpenAPI connections by URL and refresh them", async () => {
    const server = serveOpenapiSpec(openapiSpec);
    try {
      const suffix = crypto.randomUUID().replace(/-/g, "");
      const slug = `toolUrlVendor${suffix}`;
      const lead = createAgent({
        name: `script-connections-tool-url-lead-${crypto.randomUUID()}`,
        isLead: true,
        status: "idle",
      });
      const tool = scriptConnectionsTool();

      const upsertResult = (await tool.handler(
        {
          action: "upsert-openapi",
          slug,
          displayName: "Tool URL Vendor",
          baseUrl: server.baseUrl,
          openapiSpecUrl: server.url,
        },
        meta(lead.id),
      )) as {
        structuredContent: { success: boolean; message: string };
      };

      expect(upsertResult.structuredContent.success).toBe(true);
      const row = getDb()
        .prepare<{ id: string }, [string]>("SELECT id FROM script_connections WHERE slug = ?")
        .get(slug);
      expect(row).toBeDefined();
      createdConnectionIds.push(row!.id);

      server.setBody(specWithExtraOperation("toolListOrgRepos"), '"v2"');
      const refreshResult = (await tool.handler(
        { action: "refresh", id: row!.id },
        meta(lead.id),
      )) as {
        structuredContent: { success: boolean; message: string };
      };

      expect(refreshResult.structuredContent.success).toBe(true);
      const refreshed = getDb()
        .prepare<{ openapi_spec_etag: string | null; generated_types: string | null }, [string]>(
          "SELECT openapi_spec_etag, generated_types FROM script_connections WHERE id = ?",
        )
        .get(row!.id);
      expect(refreshed?.openapi_spec_etag).toBe('"v2"');
      expect(refreshed?.generated_types).toContain("toolListOrgRepos");
    } finally {
      server.stop();
    }
  });

  test("script-connections tool can upsert GraphQL connections", async () => {
    const suffix = crypto.randomUUID().replace(/-/g, "");
    const slug = `toolGraphql${suffix}`;
    const configKey = `TOOL_GRAPHQL_KEY_${suffix}`;
    const lead = createAgent({
      name: `script-connections-tool-graphql-lead-${crypto.randomUUID()}`,
      isLead: true,
      status: "idle",
    });
    const tool = scriptConnectionsTool();

    const result = (await tool.handler(
      {
        action: "upsert-graphql",
        slug,
        displayName: "Tool GraphQL",
        baseUrl: "https://graphql.vendor.test/query",
        allowedHosts: ["graphql.vendor.test"],
        configKey,
      },
      meta(lead.id),
    )) as {
      structuredContent: { success: boolean; message: string };
    };

    expect(result.structuredContent.success).toBe(true);
    const row = getDb()
      .prepare<
        {
          id: string;
          kind: string;
          credential_binding_id: string | null;
          generated_types: string | null;
        },
        [string]
      >(
        `SELECT id, kind, credential_binding_id, generated_types
         FROM script_connections WHERE slug = ?`,
      )
      .get(slug);
    expect(row?.kind).toBe("graphql");
    expect(row?.generated_types).toContain("graphql<T = JsonValue>");
    createdConnectionIds.push(row!.id);

    const bindingRow = getDb()
      .prepare<{ id: string; allowed_hosts_json: string }, [string]>(
        "SELECT id, allowed_hosts_json FROM script_credential_bindings WHERE config_key = ?",
      )
      .get(configKey);
    expect(bindingRow?.id).toBe(row?.credential_binding_id);
    expect(bindingRow?.allowed_hosts_json).toBe(JSON.stringify(["graphql.vendor.test"]));
    createdBindingIds.push(bindingRow!.id);
  });

  test("ctx.api runtime emits plain fetch with credential placeholders", async () => {
    let observed: { url: string; authorization: string | null } | null = null;
    const server = Bun.serve({
      port: 0,
      fetch(req) {
        observed = {
          url: req.url,
          authorization: req.headers.get("authorization"),
        };
        return Response.json({ full_name: "desplega-ai/agent-swarm", private: false });
      },
    });
    const binding = upsertCredentialBinding({
      configKey: "RUNTIME_VENDOR_KEY",
      allowedHosts: [`127.0.0.1:${server.port}`],
      headerTemplate: "Authorization: Bearer [REDACTED:RUNTIME_VENDOR_KEY]",
    });
    createdBindingIds.push(binding.id);
    const connection = await upsertScriptConnection({
      slug: "runtimeVendor",
      kind: "openapi",
      baseUrl: `http://127.0.0.1:${server.port}`,
      credentialBindingId: binding.id,
      openapiSpecJson: openapiSpec,
    });
    createdConnectionIds.push(connection.id);

    try {
      const output = await runScript({
        agentId: "agent-1",
        resources,
        apiConnections: getScriptApiConnectionDescriptors(),
        source: `
          export default async (_args, ctx) => {
            return await ctx.api.runtimeVendor.getRepo({
              path: { owner: "desplega-ai", repo: "agent-swarm" },
              query: { include: "stats" },
            });
          };
        `,
      });

      expect(output.error).toBeUndefined();
      expect(output.result).toEqual({ full_name: "desplega-ai/agent-swarm", private: false });
      expect(observed).toEqual({
        url: `http://127.0.0.1:${server.port}/repos/desplega-ai/agent-swarm?include=stats`,
        authorization: "Bearer [REDACTED:RUNTIME_VENDOR_KEY]",
      });
    } finally {
      server.stop(true);
    }
  });
});
