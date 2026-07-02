import { describe, expect, test } from "bun:test";
import { buildWorkflowCtx } from "../script-workflows/workflow-ctx";

describe("workflow-ctx: ctx.swarm proxy tool name resolution", () => {
  test("non-mechanical SDK→MCP mappings are routed correctly", async () => {
    const captured: string[] = [];
    const origFetch = globalThis.fetch;

    globalThis.fetch = async (url: unknown, init?: RequestInit) => {
      if (typeof url === "string" && url.includes("/api/mcp-bridge")) {
        const body = JSON.parse((init?.body as string) ?? "{}");
        captured.push(body.tool);
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      return origFetch(url as URL, init);
    };

    try {
      const ctx = buildWorkflowCtx({
        runId: "test-run",
        agentId: "test-agent",
        apiKey: "test-key",
        baseUrl: "http://localhost:9999",
        args: {},
      });

      // Non-mechanical: SDK method name ≠ kebab-cased MCP name
      await ctx.swarm.workflow_trigger({ id: "wf-1" }); // → "trigger-workflow" (not "workflow-trigger")
      await ctx.swarm.page_create({ title: "T" }); // → "create_page"       (not "page-create")
      await ctx.swarm.memory_rate({ id: "x" }); // → "memory_rate"       (not "memory-rate")

      // Mechanical: verify mechanical mappings still work
      await ctx.swarm.memory_search({ query: "q" }); // → "memory-search"
    } finally {
      globalThis.fetch = origFetch;
    }

    expect(captured[0]).toBe("trigger-workflow");
    expect(captured[1]).toBe("create_page");
    expect(captured[2]).toBe("memory_rate");
    expect(captured[3]).toBe("memory-search");
  });
});
