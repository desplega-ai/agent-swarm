import { Database } from "bun:sqlite";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync, unlinkSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { Readable } from "node:stream";
import {
  canonicalJson,
  type Manifest,
  sha256,
  trimOpenapiSpec,
} from "../../scripts/vendored-openapi-utils";
import { closeDb, createAgent, getDb, initDb } from "../be/db";
import { refreshScriptConnection, upsertScriptConnection } from "../be/script-connections";
import {
  handleScriptConnections,
  resetIntegrationsCatalogCacheForTesting,
} from "../http/script-connections";
import { getPathSegments, parseQueryParams } from "../http/utils";

const TEST_DB_PATH = "./test-vendored-openapi.sqlite";
const MIGRATION_DB_PATH = "./test-vendored-openapi-migration.sqlite";
const originalFetch = globalThis.fetch;
let leadAgentId: string;

function removeDbFiles(file: string): void {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      unlinkSync(file + suffix);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

async function dispatch(
  pathname: string,
  init: { method?: string; body?: unknown; agentId?: string } = {},
): Promise<{ status: number; body: unknown }> {
  const req = Readable.from(
    init.body === undefined ? [] : [Buffer.from(JSON.stringify(init.body))],
  ) as IncomingMessage;
  req.method = init.method ?? "GET";
  req.url = pathname;
  req.headers = init.agentId
    ? { "content-type": "application/json", "x-agent-id": init.agentId }
    : { "content-type": "application/json" };
  let status = 200;
  let text = "";
  const res = {
    headersSent: false,
    writableEnded: false,
    setHeader() {},
    writeHead(code: number) {
      status = code;
      this.headersSent = true;
      return this;
    },
    end(chunk?: unknown) {
      if (chunk !== undefined) text += String(chunk);
      this.writableEnded = true;
      return this;
    },
  } as unknown as ServerResponse;
  await handleScriptConnections(
    req,
    res,
    getPathSegments(pathname),
    parseQueryParams(pathname),
    init.agentId,
  );
  return { status, body: JSON.parse(text) as unknown };
}

beforeAll(() => {
  removeDbFiles(TEST_DB_PATH);
  initDb(TEST_DB_PATH);
  leadAgentId = createAgent({ name: "vendored-openapi-lead", isLead: true, status: "idle" }).id;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  resetIntegrationsCatalogCacheForTesting();
  getDb().run("DELETE FROM script_connections");
});

afterAll(() => {
  closeDb();
  removeDbFiles(TEST_DB_PATH);
  removeDbFiles(MIGRATION_DB_PATH);
});

describe("vendored OpenAPI", () => {
  test("manifest entries are canonical blessed trims with matching checksums", () => {
    const directory = path.join(process.cwd(), "vendored-openapi");
    const manifest = JSON.parse(
      readFileSync(path.join(directory, "manifest.json"), "utf-8"),
    ) as Manifest;
    expect(manifest.version).toBe(1);
    expect(manifest.integrations.map((entry) => entry.slug)).toEqual([
      "github",
      "slack",
      "linear",
      "jira",
      "gmail",
    ]);
    for (const entry of manifest.integrations) {
      const specText = readFileSync(path.join(directory, entry.specFile), "utf-8");
      expect(specText).toBe(canonicalJson(trimOpenapiSpec(JSON.parse(specText), entry)));
      expect(sha256(specText)).toBe(entry.specSha256);
      expect(entry.blessedOperations.length).toBeGreaterThan(0);
    }
  });

  test("vendored connections read from disk and refresh without network", async () => {
    globalThis.fetch = (() => {
      throw new Error("vendored refresh must not use the network");
    }) as typeof fetch;
    const connection = await upsertScriptConnection({
      slug: "blessedGithub",
      kind: "openapi",
      openapiSpecSourceKind: "vendored",
      openapiSpecSource: "github",
    });
    expect(connection.openapiSpecSourceKind).toBe("vendored");
    expect(connection.openapiSpecSource).toBe("github");
    expect(connection.baseUrl).toBe("https://api.github.com");
    expect(connection.generatedTypes).toContain("issuesCreate");
    expect(connection.generatedTypes).toMatch(/"full_name"|"html_url"/);

    const refreshed = await refreshScriptConnection(connection.id);
    expect(refreshed?.generationError).toBeNull();
    expect(refreshed?.version).toBe(connection.version + 1);
  });

  test("HTTP upsert accepts a vendored spec source without a caller-provided base URL", async () => {
    const response = await dispatch("/api/script-connections", {
      method: "POST",
      agentId: leadAgentId,
      body: {
        kind: "openapi",
        slug: "blessedSlack",
        specSource: { kind: "vendored", slug: "slack" },
      },
    });
    expect(response.status).toBe(200);
    expect(response.body).toEqual(
      expect.objectContaining({ connection: expect.objectContaining({ slug: "blessedSlack" }) }),
    );
  });

  test("catalog puts blessed entries first and degrades to blessed-only when upstream is down", async () => {
    globalThis.fetch = (async () => new Response("down", { status: 503 })) as typeof fetch;
    const down = (await dispatch("/api/integrations-catalog")).body as {
      entries: Array<{ slug: string; feeds: string[] }>;
      partial: boolean;
    };
    expect(down.partial).toBe(true);
    expect(down.entries).toHaveLength(5);
    expect(down.entries.every((entry) => entry.feeds.includes("blessed"))).toBe(true);

    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify([
          {
            id: "github-upstream",
            kind: "openapi",
            slug: "github",
            name: "GitHub upstream",
            domain: "github.com",
          },
          { id: "stripe", kind: "openapi", slug: "stripe", name: "Stripe", domain: "stripe.com" },
        ]),
        { status: 200, headers: { "content-type": "application/json" } },
      )) as typeof fetch;
    const merged = (await dispatch("/api/integrations-catalog")).body as {
      entries: Array<{ slug: string; feeds: string[] }>;
      partial: boolean;
    };
    expect(merged.partial).toBe(false);
    expect(merged.entries.slice(0, 5).every((entry) => entry.feeds.includes("blessed"))).toBe(true);
    expect(merged.entries.map((entry) => entry.slug)).toEqual([
      "github",
      "slack",
      "linear",
      "jira",
      "gmail",
      "stripe",
    ]);
  });

  test("migration 119 preserves rows while widening the source-kind check", () => {
    removeDbFiles(MIGRATION_DB_PATH);
    const database = new Database(MIGRATION_DB_PATH);
    try {
      database.exec(readFileSync("src/be/migrations/101_script_connections.sql", "utf-8"));
      database.exec(readFileSync("src/be/migrations/111_oauth_credential_bindings.sql", "utf-8"));
      database.exec(readFileSync("src/be/migrations/112_script_connections_graphql.sql", "utf-8"));
      database
        .query(
          "INSERT INTO script_connections (id, slug, kind, openapi_spec_json) VALUES (?, ?, ?, ?)",
        )
        .run("legacy-row", "legacy", "openapi", "{}");
      database.exec(readFileSync("src/be/migrations/119_vendored_spec_source.sql", "utf-8"));
      expect(
        database.query<{ id: string }, []>("SELECT id FROM script_connections").get()?.id,
      ).toBe("legacy-row");
      database
        .query("UPDATE script_connections SET openapi_spec_source_kind = ? WHERE id = ?")
        .run("vendored", "legacy-row");
    } finally {
      database.close();
    }
  });
});
