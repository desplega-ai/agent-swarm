import { afterAll, beforeAll, expect, test } from "bun:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ScriptContext } from "swarm-sdk";
import { closeDb, getPageBySlug, initDb } from "../be/db";
import refresh from "../be/seed-scripts/catalog/star-history-refresh";
import { renderChart } from "../be/seed-scripts/catalog/star-history-renderer";
import { registerCreatePageTool } from "../tools/create-page";

const agentId = crypto.randomUUID();
const server = new McpServer({ name: "star-history-test", version: "1" });
registerCreatePageTool(server);
const tool = (server as any)._registeredTools.create_page;
beforeAll(() => initDb(":memory:"));
afterAll(() => closeDb());

function fixture() {
  let cache: unknown;
  let fail = false;
  let calls = 0;
  const ctx = {
    stdlib: {
      fetch: async (url: string, init: RequestInit) => {
        calls++;
        if (fail) return new Response("", { status: 503 });
        const page = Number(new URL(url).searchParams.get("page"));
        if ((init.headers as Record<string, string>)["If-None-Match"]) {
          return new Response(null, { status: 304 });
        }
        return Response.json(
          Array.from({ length: page === 1 ? 100 : 2 }, (_, i) => ({
            starred_at: new Date(Date.UTC(2026, 0, 1) + (page * 100 + i) * 86400000).toISOString(),
          })),
          { headers: { ETag: `"page-${page}"` } },
        );
      },
    },
    swarm: {
      kv_getOrNull: async () => (cache ? { value: cache } : null),
      kv_set: async ({ value }: { value: unknown }) => {
        cache = value;
      },
      page_create: async (args: unknown) => {
        const res = await tool.handler(args, {
          sessionId: "stars",
          requestInfo: { headers: { "x-agent-id": agentId } },
        });
        return res.structuredContent;
      },
    },
  } as unknown as ScriptContext;
  return {
    ctx,
    fail: () => {
      fail = true;
    },
    calls: () => calls,
  };
}

test("paginated refresh, ETags, stable MCP page IDs/URLs, and cached fallback", async () => {
  const f = fixture();
  const first = await refresh({}, f.ctx);
  expect(first.stars).toBe(102);
  expect(f.calls()).toBe(2);
  expect(first.stale).toBe(false);
  const second = await refresh({}, f.ctx);
  expect(second.notModified).toBe(2);
  expect(second.pages).toEqual(first.pages);
  for (const page of second.pages) {
    const stored = await getPageBySlug(agentId, page.slug);
    expect(stored?.contentType).toBe("image/svg+xml");
    expect(stored?.authMode).toBe("public");
    expect(stored?.body).toContain("102 stars");
    expect(stored?.body).not.toContain("NaN");
  }
  f.fail();
  const fallback = await refresh({}, f.ctx);
  expect(fallback.stale).toBe(true);
  expect(fallback.stars).toBe(102);
  expect(fallback.pages).toEqual(first.pages);
  expect(fallback.fetchedAt).toBe(second.fetchedAt);
});

test("a failed first fetch refuses to publish an empty chart", async () => {
  const f = fixture();
  f.fail();
  await expect(refresh({}, f.ctx)).rejects.toThrow("no cached series");
});

test("dry run renders both themes without publishing", async () => {
  const f = fixture();
  const result = await refresh({ dryRun: true, authenticated: false }, f.ctx);
  expect(result.pages).toHaveLength(2);
  expect(result.pages.every((page) => "bytes" in page && page.bytes > 1000)).toBe(true);
});

test("renderer escapes repository text and handles one star", async () => {
  const svg = renderChart("owner/<repo>", [Date.UTC(2026, 0, 1)], "dark");
  expect(svg).toContain("owner/&lt;repo&gt;");
  expect(svg).toContain("1 stars");
  expect(svg).not.toContain("NaN");
});
