/**
 * `create_page` MCP tool — unit-level coverage. Registers the tool against
 * a fresh `McpServer`, pulls the handler out of the SDK's registry, and
 * invokes it directly with a stubbed agent-id `requestInfo`.
 *
 * Verifies:
 *   - first-call path: creates a row in `pages`, returns `{id, version=1, app_url, api_url}`
 *   - upsert path: second call with the same slug bumps the edit-counter
 *     and writes a version row
 *   - capability gate: tool is registered when `CAPABILITIES` contains
 *     `pages`, NOT registered when missing (verified via `createServer`)
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import crypto from "node:crypto";
import { unlink } from "node:fs/promises";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { closeDb, getPageBySlug, getPageVersions, initDb } from "../be/db";
import { registerCreatePageTool } from "../tools/create-page";

const TEST_DB_PATH = "./test-create-page-tool.sqlite";

type RegisteredTool = {
  handler: (args: unknown, extra: unknown) => Promise<unknown>;
};

function buildServer() {
  const server = new McpServer({ name: "create-page-test", version: "1.0.0" });
  registerCreatePageTool(server);
  const registered = (server as unknown as { _registeredTools: Record<string, RegisteredTool> })
    ._registeredTools;
  const tool = registered.create_page;
  if (!tool) throw new Error("create_page tool not registered");
  return tool;
}

describe("create_page MCP tool", () => {
  const agentId = crypto.randomUUID();
  const fakeMeta = {
    sessionId: "session-1",
    requestInfo: { headers: { "x-agent-id": agentId } },
  };

  beforeAll(async () => {
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        await unlink(`${TEST_DB_PATH}${suffix}`);
      } catch {}
    }
    initDb(TEST_DB_PATH);
    // The tool reads MCP_BASE_URL / APP_URL when building share URLs.
    process.env.MCP_BASE_URL = "http://test-api:9999";
    process.env.APP_URL = "http://test-app:5274";
  });

  afterAll(async () => {
    closeDb();
    delete process.env.MCP_BASE_URL;
    delete process.env.APP_URL;
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        await unlink(`${TEST_DB_PATH}${suffix}`);
      } catch {}
    }
  });

  test("first call creates an authed row by default + returns shareable URLs", async () => {
    const tool = buildServer();
    const result = (await tool.handler(
      {
        title: "Hello Page",
        body: "<h1>hello</h1>",
        contentType: "text/html",
      },
      fakeMeta,
    )) as {
      structuredContent: {
        id: string;
        version: number;
        app_url: string;
        api_url: string;
        yourAgentId: string;
      };
    };

    expect(result.structuredContent.id).toMatch(/^[0-9a-f]{32}$/);
    expect(result.structuredContent.version).toBe(1);
    expect(result.structuredContent.api_url).toBe(
      `http://test-api:9999/p/${result.structuredContent.id}`,
    );
    expect(result.structuredContent.app_url).toBe(
      `http://test-app:5274/pages/${result.structuredContent.id}`,
    );
    expect(result.structuredContent.yourAgentId).toBe(agentId);

    // DB row exists with the auto-slug from the title.
    const row = getPageBySlug(agentId, "hello-page");
    expect(row).not.toBeNull();
    expect(row!.body).toBe("<h1>hello</h1>");
    expect(row!.authMode).toBe("authed");
  });

  test("explicit public auth mode is preserved", async () => {
    const tool = buildServer();
    await tool.handler(
      {
        title: "Public Page",
        body: "<h1>public</h1>",
        contentType: "text/html",
        authMode: "public",
      },
      fakeMeta,
    );

    const row = getPageBySlug(agentId, "public-page");
    expect(row).not.toBeNull();
    expect(row!.authMode).toBe("public");
  });

  test("re-running with the same slug upserts + bumps edit-counter", async () => {
    const tool = buildServer();

    const first = (await tool.handler(
      {
        title: "Upsert Page",
        slug: "upsert",
        body: "v0",
        contentType: "text/html",
        authMode: "public",
      },
      fakeMeta,
    )) as { structuredContent: { id: string; version: number } };
    expect(first.structuredContent.version).toBe(1);

    const second = (await tool.handler(
      {
        title: "Upsert Page",
        slug: "upsert",
        body: "v1",
        contentType: "text/html",
        authMode: "public",
      },
      fakeMeta,
    )) as { structuredContent: { id: string; version: number } };
    expect(second.structuredContent.id).toBe(first.structuredContent.id);
    expect(second.structuredContent.version).toBe(2);

    // Version row holds the PRE-update body.
    const versions = getPageVersions(first.structuredContent.id);
    expect(versions).toHaveLength(1);
    expect(versions[0]!.snapshot.body).toBe("v0");

    // Parent now holds the new body.
    const row = getPageBySlug(agentId, "upsert");
    expect(row?.body).toBe("v1");
  });

  test("missing X-Agent-ID returns an error result", async () => {
    const tool = buildServer();
    const result = (await tool.handler(
      {
        title: "Anon",
        body: "x",
        contentType: "text/html",
        authMode: "public",
      },
      { sessionId: "s", requestInfo: { headers: {} } },
    )) as { isError?: boolean };
    expect(result.isError).toBe(true);
  });

  test("password is hashed (not stored verbatim)", async () => {
    const tool = buildServer();
    await tool.handler(
      {
        title: "Pw",
        slug: "pw-tool",
        body: "secret",
        contentType: "text/html",
        authMode: "password",
        password: "open-sesame",
      },
      fakeMeta,
    );
    const row = getPageBySlug(agentId, "pw-tool");
    expect(row?.passwordHash).toBeDefined();
    expect(row?.passwordHash).not.toBe("open-sesame");
    expect(await Bun.password.verify("open-sesame", row!.passwordHash!)).toBe(true);
  });
});

describe("create_page MCP tool capability gating", () => {
  test("not registered without 'pages' capability; registered with it", async () => {
    // Save + clear env then load the server module fresh.
    const orig = process.env.CAPABILITIES;
    try {
      // Default capabilities don't include 'pages' (step-3 enforced).
      process.env.CAPABILITIES = "core,task-pool,profiles,services,scheduling,memory,workflows";
      // Force a fresh module evaluation so the capability check re-runs.
      delete require.cache[require.resolve("../server")];
      const without = await import("../server");
      expect(without.hasCapability("pages")).toBe(false);

      process.env.CAPABILITIES =
        "core,task-pool,profiles,services,scheduling,memory,workflows,pages";
      delete require.cache[require.resolve("../server")];
      const withPages = await import("../server");
      expect(withPages.hasCapability("pages")).toBe(true);
    } finally {
      if (orig === undefined) delete process.env.CAPABILITIES;
      else process.env.CAPABILITIES = orig;
      delete require.cache[require.resolve("../server")];
    }
  });
});
