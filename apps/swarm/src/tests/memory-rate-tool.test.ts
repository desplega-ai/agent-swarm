/**
 * Unit + integration tests for the `memory_rate` MCP tool and the
 * conditional system-prompt addendum from `src/prompts/memories.ts`.
 *
 * Plan: thoughts/taras/plans/2026-05-05-memory-rater-v1.5/step-5.md §7
 *
 * Strategy:
 *   - Tool tests stub `globalThis.fetch` to assert the request payload and
 *     simulate the 200/400/409 responses the step-3 endpoint emits. No
 *     network or server boot needed.
 *   - Prompt tests flip `MEMORY_RATERS` and assert the addendum is gated
 *     on `explicit-self` being present.
 *   - MCP handshake test registers the tool against a fresh `McpServer` and
 *     pulls the entry out of the SDK's registry to confirm the wiring.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { renderMemoriesPrompt } from "../prompts/memories";
import { registerMemoryRateTool } from "../tools/memory-rate";

type FetchInit = Parameters<typeof fetch>[1];
type CallRecord = { url: string; init: FetchInit };

const originalFetch = globalThis.fetch;

function installFetchStub(
  responder: (url: string, init: FetchInit) => Response | Promise<Response>,
): { calls: CallRecord[] } {
  const calls: CallRecord[] = [];
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: FetchInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : "";
    calls.push({ url, init: init ?? {} });
    return responder(url, init ?? {});
  }) as typeof fetch;
  return { calls };
}

function buildServer() {
  const server = new McpServer({ name: "memory-rate-test", version: "1.0.0" });
  registerMemoryRateTool(server);
  type RegisteredTool = {
    handler: (args: unknown, extra: unknown) => Promise<unknown>;
  };
  const registered = (server as unknown as { _registeredTools: Record<string, RegisteredTool> })
    ._registeredTools;
  const tool = registered.memory_rate;
  if (!tool) throw new Error("memory_rate tool not registered");
  return { server, tool, registered };
}

const fakeMeta = {
  sessionId: "session-123",
  requestInfo: {
    headers: {
      "x-agent-id": "agent-abc",
      "x-source-task-id": "11111111-1111-4111-8111-111111111111",
    },
  },
};

const memoryId = "22222222-2222-4222-8222-222222222222";

describe("memory_rate MCP tool", () => {
  beforeEach(() => {
    process.env.MCP_BASE_URL = "http://test-host:9999";
    process.env.API_KEY = "test-key";
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    delete process.env.MCP_BASE_URL;
    delete process.env.API_KEY;
  });

  test("success path POSTs the canonical event shape and returns success=true", async () => {
    const { tool } = buildServer();
    const { calls } = installFetchStub(() => new Response("{}", { status: 200 }));

    const result = (await tool.handler({ id: memoryId, useful: true }, fakeMeta)) as {
      structuredContent: { success: boolean; message: string };
    };

    expect(result.structuredContent.success).toBe(true);
    expect(result.structuredContent.message).toContain("useful");

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("http://test-host:9999/api/memory/rate");
    expect(calls[0]!.init?.method).toBe("POST");
    const headers = calls[0]!.init?.headers as Record<string, string>;
    expect(headers["X-Agent-ID"]).toBe("agent-abc");
    expect(headers.Authorization).toBe("Bearer test-key");
    const body = JSON.parse(calls[0]!.init?.body as string);
    expect(body).toEqual({
      events: [
        {
          memoryId,
          signal: 1,
          weight: 1.0,
          source: "explicit-self",
          reasoning: "",
          taskId: "11111111-1111-4111-8111-111111111111",
        },
      ],
    });
  });

  test("useful=false flips signal to -1 and forwards the note as reasoning", async () => {
    const { tool } = buildServer();
    const { calls } = installFetchStub(() => new Response("{}", { status: 200 }));

    await tool.handler({ id: memoryId, useful: false, note: "actually misleading" }, fakeMeta);

    const body = JSON.parse(calls[0]!.init?.body as string);
    expect(body.events[0].signal).toBe(-1);
    expect(body.events[0].reasoning).toBe("actually misleading");
  });

  test("409 → success=false with the canned duplicate message", async () => {
    const { tool } = buildServer();
    installFetchStub(
      () =>
        new Response(JSON.stringify({ error: "Duplicate explicit-self" }), {
          status: 409,
        }),
    );

    const result = (await tool.handler({ id: memoryId, useful: true }, fakeMeta)) as {
      structuredContent: { success: boolean; message: string };
    };

    expect(result.structuredContent.success).toBe(false);
    expect(result.structuredContent.message).toBe(
      "Memory already rated for this task. Use a follow-up memory_rerate tool (coming soon) to override.",
    );
  });

  test("400 → success=false with a clear message and the server error detail", async () => {
    const { tool } = buildServer();
    installFetchStub(
      () =>
        new Response(
          JSON.stringify({
            error: `explicit-self rating rejected: memoryId=${memoryId} not present in memory_retrieval for task=t`,
          }),
          { status: 400 },
        ),
    );

    const result = (await tool.handler({ id: memoryId, useful: true }, fakeMeta)) as {
      structuredContent: { success: boolean; message: string };
    };

    expect(result.structuredContent.success).toBe(false);
    expect(result.structuredContent.message).toMatch(/not present in memory_retrieval/);
    expect(result.structuredContent.message).toMatch(/must have been retrieved/);
  });

  test("network failure does NOT throw — surfaces a structured error", async () => {
    const { tool } = buildServer();
    installFetchStub(() => {
      throw new Error("connect ECONNREFUSED");
    });

    const result = (await tool.handler({ id: memoryId, useful: true }, fakeMeta)) as {
      structuredContent: { success: boolean; message: string };
    };

    expect(result.structuredContent.success).toBe(false);
    expect(result.structuredContent.message).toMatch(/ECONNREFUSED/);
  });

  test("missing sourceTaskId → tool returns a clear failure without POSTing", async () => {
    const { tool } = buildServer();
    const { calls } = installFetchStub(() => new Response("{}", { status: 200 }));

    const noTaskMeta = {
      sessionId: "session-123",
      requestInfo: { headers: { "x-agent-id": "agent-abc" } },
    };
    const result = (await tool.handler({ id: memoryId, useful: true }, noTaskMeta)) as {
      structuredContent: { success: boolean; message: string };
    };

    expect(result.structuredContent.success).toBe(false);
    expect(result.structuredContent.message).toMatch(/no source task ID/);
    expect(calls).toHaveLength(0);
  });

  test("MCP handshake — memory_rate is registered with the expected name", () => {
    const { registered } = buildServer();
    expect(Object.keys(registered)).toContain("memory_rate");
  });
});

describe("renderMemoriesPrompt — conditional rate-tool hint", () => {
  const sampleMemories = [
    { id: "m-1", name: "Foo bug fix", content: "use Bun.serve not express", similarity: 0.9 },
    { id: "m-2", name: "Low signal", content: "trivial", similarity: 0.1 },
  ];

  beforeEach(() => {
    delete process.env.MEMORY_RATERS;
  });

  afterEach(() => {
    delete process.env.MEMORY_RATERS;
  });

  test("no memories above threshold → returns null", () => {
    const result = renderMemoriesPrompt([{ id: "x", name: "x", content: "x", similarity: 0.1 }]);
    expect(result).toBeNull();
  });

  test("MEMORY_RATERS unset → no rate-tool hint (byte-identical to pre-step-5)", () => {
    const result = renderMemoriesPrompt(sampleMemories);
    expect(result).not.toBeNull();
    expect(result).not.toContain("memory_rate");
    expect(result).toContain("### Relevant Past Knowledge");
    expect(result).toContain("- **Foo bug fix** (id: m-1):");
    // Snapshot — exact byte parity with main's runner.ts:1579 block.
    expect(result).toBe(
      `\n\n### Relevant Past Knowledge\n\nThese memories from your previous sessions may be useful. Use \`memory-get\` with the memory ID to retrieve full details.\n\n- **Foo bug fix** (id: m-1): use Bun.serve not express\n`,
    );
  });

  test("MEMORY_RATERS empty string → no hint", () => {
    process.env.MEMORY_RATERS = "";
    const result = renderMemoriesPrompt(sampleMemories);
    expect(result).not.toContain("memory_rate");
  });

  test("MEMORY_RATERS=noop → no hint (gate is on explicit-self only)", () => {
    process.env.MEMORY_RATERS = "noop";
    const result = renderMemoriesPrompt(sampleMemories);
    expect(result).not.toContain("memory_rate");
  });

  test("MEMORY_RATERS=explicit-self → hint appended verbatim", () => {
    process.env.MEMORY_RATERS = "explicit-self";
    const result = renderMemoriesPrompt(sampleMemories);
    expect(result).toContain("memory_rate");
    expect(result).toContain("trains the swarm to surface better memories");
    expect(result).toContain("2-5 ratings per task is plenty.");
  });

  test("MEMORY_RATERS includes explicit-self alongside others → hint appended", () => {
    process.env.MEMORY_RATERS = "implicit-citation, explicit-self ,llm";
    const result = renderMemoriesPrompt(sampleMemories);
    expect(result).toContain("memory_rate");
  });
});
