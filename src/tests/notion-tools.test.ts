import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { closeDb, initDb } from "../be/db";
import { deleteOAuthTokens, storeOAuthTokens, upsertOAuthApp } from "../be/db-queries/oauth";
import { NotionApiError, NotionRateLimitedError } from "../notion/client";
import { registerNotionListDatabasesTool } from "../tools/notion/notion-list-databases";
import { registerNotionQueryDatabaseTool } from "../tools/notion/notion-query-database";
import {
  hasNotionToken,
  notConnectedResult,
  notionErrorToResult,
  shapeDatabaseSummary,
  shapePageProperties,
  shapePageSummary,
  shapeProperty,
} from "../tools/notion/utils";

const TEST_DB_PATH = "./test-notion-tools.sqlite";
const originalFetch = globalThis.fetch;

beforeAll(() => {
  initDb(TEST_DB_PATH);
  upsertOAuthApp("notion", {
    clientId: "id",
    clientSecret: "secret",
    authorizeUrl: "https://api.notion.com/v1/oauth/authorize",
    tokenUrl: "https://api.notion.com/v1/oauth/token",
    redirectUri: "http://localhost:3013/cb",
    scopes: "",
  });
});

afterAll(async () => {
  globalThis.fetch = originalFetch;
  mock.restore();
  closeDb();
  await unlink(TEST_DB_PATH).catch(() => {});
  await unlink(`${TEST_DB_PATH}-wal`).catch(() => {});
  await unlink(`${TEST_DB_PATH}-shm`).catch(() => {});
});

beforeEach(() => {
  storeOAuthTokens("notion", {
    accessToken: "at",
    refreshToken: "rt",
    expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
  });
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

// ─── hasNotionToken / notConnectedResult ─────────────────────────────────────

describe("hasNotionToken", () => {
  test("true when tokens row exists", () => {
    expect(hasNotionToken()).toBe(true);
  });
  test("false when tokens row missing", () => {
    deleteOAuthTokens("notion");
    expect(hasNotionToken()).toBe(false);
  });
});

describe("notConnectedResult", () => {
  test("structured content + isError true + reason=not_connected", () => {
    const result = notConnectedResult();
    expect(result.isError).toBe(true);
    expect((result.structuredContent as { success: boolean; reason: string }).success).toBe(false);
    expect((result.structuredContent as { reason: string }).reason).toBe("not_connected");
  });
});

// ─── notionErrorToResult dispatch ────────────────────────────────────────────

describe("notionErrorToResult", () => {
  test("rate-limit error → reason=rate_limited + retryAfterSeconds passthrough", () => {
    const result = notionErrorToResult(new NotionRateLimitedError(7, "slow down"));
    const sc = result.structuredContent as Record<string, unknown>;
    expect(sc.reason).toBe("rate_limited");
    expect(sc.retryAfterSeconds).toBe(7);
  });

  test("generic API error → reason=api_error + status/code passthrough", () => {
    const result = notionErrorToResult(new NotionApiError(404, "object_not_found", "page gone"));
    const sc = result.structuredContent as Record<string, unknown>;
    expect(sc.reason).toBe("api_error");
    expect(sc.status).toBe(404);
    expect(sc.code).toBe("object_not_found");
  });

  test("unknown error → reason=unknown_error + raw message", () => {
    const result = notionErrorToResult(new Error("kaboom"));
    const sc = result.structuredContent as Record<string, unknown>;
    expect(sc.reason).toBe("unknown_error");
    expect(sc.message).toBe("kaboom");
  });
});

// ─── shapePageSummary ────────────────────────────────────────────────────────

describe("shapePageSummary", () => {
  test("extracts page title from title-typed property", () => {
    const obj = {
      id: "page-1",
      object: "page",
      url: "https://notion.so/page-1",
      last_edited_time: "2026-05-07T10:00:00.000Z",
      created_time: "2026-04-01T08:00:00.000Z",
      parent: { type: "database_id", database_id: "db-1" },
      properties: {
        Name: {
          type: "title",
          title: [{ plain_text: "Hello " }, { plain_text: "World" }],
        },
        Other: { type: "rich_text", rich_text: [] },
      },
    };
    const summary = shapePageSummary(obj);
    expect(summary.id).toBe("page-1");
    expect(summary.title).toBe("Hello World");
    expect(summary.type).toBe("page");
    expect(summary.url).toBe("https://notion.so/page-1");
    expect(summary.parent).toEqual({ type: "database_id", id: "db-1" });
  });

  test("falls back to (untitled) when no title property", () => {
    const summary = shapePageSummary({
      id: "x",
      object: "page",
      properties: {},
    });
    expect(summary.title).toBe("(untitled)");
  });

  test("classifies database object correctly", () => {
    const summary = shapePageSummary({
      id: "db-1",
      object: "database",
      title: [{ plain_text: "Customers" }],
      properties: {},
    });
    expect(summary.type).toBe("database");
    expect(summary.title).toBe("Customers");
  });

  test("unknown object type", () => {
    const summary = shapePageSummary({ id: "x", object: "block" });
    expect(summary.type).toBe("unknown");
  });
});

// ─── shapeDatabaseSummary ────────────────────────────────────────────────────

describe("shapeDatabaseSummary", () => {
  test("extracts title, description, property→type map, and data sources", () => {
    const obj = {
      id: "db-1",
      object: "database",
      url: "https://notion.so/db-1",
      last_edited_time: "2026-05-07T10:00:00.000Z",
      title: [{ plain_text: "Customers" }],
      description: [{ plain_text: "All " }, { plain_text: "customers" }],
      properties: {
        Name: { type: "title" },
        Email: { type: "email" },
        Status: { type: "select" },
      },
      data_sources: [{ id: "ds-1", name: "Customers data source" }],
    };
    const result = shapeDatabaseSummary(obj);
    expect(result.title).toBe("Customers");
    expect(result.description).toBe("All customers");
    expect(result.properties).toEqual({ Name: "title", Email: "email", Status: "select" });
    expect(result.dataSources).toEqual([{ id: "ds-1", name: "Customers data source" }]);
  });

  test("null description when empty, empty dataSources when missing", () => {
    const result = shapeDatabaseSummary({
      id: "x",
      object: "database",
      title: [],
      description: [],
    });
    expect(result.description).toBeNull();
    expect(result.title).toBe("(untitled)");
    expect(result.dataSources).toEqual([]);
  });

  test("filters out malformed data_sources entries (missing id)", () => {
    const result = shapeDatabaseSummary({
      id: "db-2",
      object: "database",
      data_sources: [
        { id: "ds-keep", name: "Good" },
        { name: "Missing id" },
        { id: "" },
        { id: "ds-also-keep", name: null },
      ],
    });
    expect(result.dataSources).toEqual([
      { id: "ds-keep", name: "Good" },
      { id: "ds-also-keep", name: "" },
    ]);
  });
});

// ─── shapeProperty ───────────────────────────────────────────────────────────

describe("shapeProperty", () => {
  test("title", () => {
    expect(shapeProperty({ type: "title", title: [{ plain_text: "T" }] })).toEqual({
      type: "title",
      preview: "T",
    });
  });
  test("rich_text", () => {
    expect(
      shapeProperty({ type: "rich_text", rich_text: [{ plain_text: "a" }, { plain_text: "b" }] }),
    ).toEqual({ type: "rich_text", preview: "ab" });
  });
  test("number", () => {
    expect(shapeProperty({ type: "number", number: 42 })).toEqual({
      type: "number",
      preview: "42",
    });
    expect(shapeProperty({ type: "number", number: null })).toEqual({
      type: "number",
      preview: "",
    });
  });
  test("select / multi_select", () => {
    expect(shapeProperty({ type: "select", select: { name: "Active" } })).toEqual({
      type: "select",
      preview: "Active",
    });
    expect(
      shapeProperty({ type: "multi_select", multi_select: [{ name: "A" }, { name: "B" }] }),
    ).toEqual({ type: "multi_select", preview: "A, B" });
  });
  test("status", () => {
    expect(shapeProperty({ type: "status", status: { name: "In Progress" } })).toEqual({
      type: "status",
      preview: "In Progress",
    });
  });
  test("date with end", () => {
    expect(
      shapeProperty({ type: "date", date: { start: "2026-05-07", end: "2026-05-08" } }),
    ).toEqual({ type: "date", preview: "2026-05-07..2026-05-08" });
  });
  test("checkbox", () => {
    expect(shapeProperty({ type: "checkbox", checkbox: true })).toEqual({
      type: "checkbox",
      preview: "true",
    });
  });
  test("url / email / phone", () => {
    expect(shapeProperty({ type: "url", url: "https://x.com" })).toEqual({
      type: "url",
      preview: "https://x.com",
    });
    expect(shapeProperty({ type: "email", email: "a@b.co" })).toEqual({
      type: "email",
      preview: "a@b.co",
    });
    expect(shapeProperty({ type: "phone_number", phone_number: "+1" })).toEqual({
      type: "phone_number",
      preview: "+1",
    });
  });
  test("formula (string variant)", () => {
    expect(
      shapeProperty({ type: "formula", formula: { type: "string", string: "computed" } }),
    ).toEqual({ type: "formula", preview: "computed" });
  });
  test("relation", () => {
    expect(shapeProperty({ type: "relation", relation: [{ id: "p1" }, { id: "p2" }] })).toEqual({
      type: "relation",
      preview: "p1,p2",
    });
  });
  test("unknown type falls through to JSON", () => {
    const out = shapeProperty({ type: "files" } as unknown as Parameters<typeof shapeProperty>[0]);
    expect(out.type).toBe("files");
    expect(out.preview).toContain("files");
  });
});

// ─── shapePageProperties ────────────────────────────────────────────────────

describe("shapePageProperties", () => {
  test("flattens all properties to {type, preview} map", () => {
    const result = shapePageProperties({
      id: "p1",
      properties: {
        Name: { type: "title", title: [{ plain_text: "Foo" }] },
        Done: { type: "checkbox", checkbox: false },
      },
    });
    expect(result.Name).toEqual({ type: "title", preview: "Foo" });
    expect(result.Done).toEqual({ type: "checkbox", preview: "false" });
  });
});

// ─── notion-query-database tool — data_sources endpoint ─────────────────────

type RegisteredTool = {
  handler: (args: unknown, extra: unknown) => Promise<unknown>;
};

function registerQueryTool(): RegisteredTool {
  const server = new McpServer({ name: "notion-tools-test", version: "1.0.0" });
  registerNotionQueryDatabaseTool(server);
  const registered = (server as unknown as { _registeredTools: Record<string, RegisteredTool> })
    ._registeredTools;
  const tool = registered["notion-query-database"];
  if (!tool) throw new Error("notion-query-database tool not registered");
  return tool;
}

function registerListTool(): RegisteredTool {
  const server = new McpServer({ name: "notion-tools-test", version: "1.0.0" });
  registerNotionListDatabasesTool(server);
  const registered = (server as unknown as { _registeredTools: Record<string, RegisteredTool> })
    ._registeredTools;
  const tool = registered["notion-list-databases"];
  if (!tool) throw new Error("notion-list-databases tool not registered");
  return tool;
}

describe("notion-query-database — endpoint shape", () => {
  test("with `dataSourceId`, POSTs to /v1/data_sources/{id}/query", async () => {
    const tool = registerQueryTool();
    const calls: string[] = [];
    globalThis.fetch = mock(
      // biome-ignore lint/suspicious/noExplicitAny: fetch typing
      async (url: any) => {
        calls.push(String(url));
        return new Response(
          JSON.stringify({ object: "list", results: [], has_more: false, next_cursor: null }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      },
      // biome-ignore lint/suspicious/noExplicitAny: typeof globalThis.fetch
    ) as any;

    const result = (await tool.handler(
      { dataSourceId: "ds-uuid-1", filter: { property: "Status", status: { equals: "Done" } } },
      {},
    )) as { structuredContent?: { success: boolean; dataSourceId?: string } };

    expect(calls).toHaveLength(1);
    expect(calls[0]).toBe("https://api.notion.com/v1/data_sources/ds-uuid-1/query");
    expect(result.structuredContent?.success).toBe(true);
    expect(result.structuredContent?.dataSourceId).toBe("ds-uuid-1");
  });

  test("with only `databaseId`, resolves via GET /v1/databases/{id} then queries the data source", async () => {
    const tool = registerQueryTool();
    const calls: { url: string; method?: string }[] = [];
    globalThis.fetch = mock(
      // biome-ignore lint/suspicious/noExplicitAny: fetch typing
      async (url: any, init?: any) => {
        const u = String(url);
        calls.push({ url: u, method: init?.method });
        if (u === "https://api.notion.com/v1/databases/db-uuid-1") {
          return new Response(
            JSON.stringify({
              object: "database",
              id: "db-uuid-1",
              data_sources: [{ id: "ds-resolved", name: "Primary" }],
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        if (u === "https://api.notion.com/v1/data_sources/ds-resolved/query") {
          return new Response(
            JSON.stringify({ object: "list", results: [], has_more: false, next_cursor: null }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        return new Response("unexpected", { status: 500 });
      },
      // biome-ignore lint/suspicious/noExplicitAny: typeof globalThis.fetch
    ) as any;

    const result = (await tool.handler({ databaseId: "db-uuid-1" }, {})) as {
      structuredContent?: { success: boolean; dataSourceId?: string };
    };

    expect(calls.map((c) => c.url)).toEqual([
      "https://api.notion.com/v1/databases/db-uuid-1",
      "https://api.notion.com/v1/data_sources/ds-resolved/query",
    ]);
    expect(calls[1]?.method).toBe("POST");
    expect(result.structuredContent?.success).toBe(true);
    expect(result.structuredContent?.dataSourceId).toBe("ds-resolved");
  });

  test("with `databaseId` resolving to multiple data sources, returns api_error reason", async () => {
    const tool = registerQueryTool();
    globalThis.fetch = mock(
      async () =>
        new Response(
          JSON.stringify({
            object: "database",
            id: "db-uuid-multi",
            data_sources: [
              { id: "ds-a", name: "A" },
              { id: "ds-b", name: "B" },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      // biome-ignore lint/suspicious/noExplicitAny: typeof globalThis.fetch
    ) as any;

    const result = (await tool.handler({ databaseId: "db-uuid-multi" }, {})) as {
      isError?: boolean;
      structuredContent?: { reason?: string; message?: string };
    };
    expect(result.isError).toBe(true);
    expect(result.structuredContent?.reason).toBe("unknown_error");
    expect(result.structuredContent?.message).toMatch(/multiple data sources/i);
  });

  test("with neither id, returns invalid_args reason", async () => {
    const tool = registerQueryTool();
    let fetchCalled = false;
    globalThis.fetch = mock(
      async () => {
        fetchCalled = true;
        return new Response("nope", { status: 500 });
      },
      // biome-ignore lint/suspicious/noExplicitAny: typeof globalThis.fetch
    ) as any;

    const result = (await tool.handler({}, {})) as {
      isError?: boolean;
      structuredContent?: { reason?: string };
    };
    expect(fetchCalled).toBe(false);
    expect(result.isError).toBe(true);
    expect(result.structuredContent?.reason).toBe("invalid_args");
  });
});

describe("notion-list-databases — exposes dataSources from /search", () => {
  test("propagates data_sources from each database object", async () => {
    const tool = registerListTool();
    globalThis.fetch = mock(
      async () =>
        new Response(
          JSON.stringify({
            object: "list",
            has_more: false,
            next_cursor: null,
            results: [
              {
                object: "database",
                id: "db-1",
                title: [{ plain_text: "Customers" }],
                properties: { Name: { type: "title" } },
                data_sources: [{ id: "ds-1", name: "Customers data source" }],
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      // biome-ignore lint/suspicious/noExplicitAny: typeof globalThis.fetch
    ) as any;

    const result = (await tool.handler({}, {})) as {
      structuredContent?: {
        success: boolean;
        databases?: Array<{ id: string; dataSources: Array<{ id: string; name: string }> }>;
      };
    };
    expect(result.structuredContent?.success).toBe(true);
    expect(result.structuredContent?.databases?.[0]?.dataSources).toEqual([
      { id: "ds-1", name: "Customers data source" },
    ]);
  });
});
