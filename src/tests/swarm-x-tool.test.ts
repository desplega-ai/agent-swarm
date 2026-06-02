import { afterEach, describe, expect, mock, test } from "bun:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerSwarmXTool } from "../tools/swarm-x";
import { clearVolatileSecretsForTesting } from "../utils/secret-scrubber";

type RegisteredTool = {
  handler: (args: unknown, extra: unknown) => Promise<unknown>;
};

const originalFetch = globalThis.fetch;
const originalComposioKey = process.env.COMPOSIO_API_KEY;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function buildTool() {
  const server = new McpServer({ name: "swarm-x-test", version: "1.0.0" });
  registerSwarmXTool(server);
  const registered = (server as unknown as { _registeredTools: Record<string, RegisteredTool> })
    ._registeredTools;
  const tool = registered.swarm_x;
  if (!tool) throw new Error("swarm_x tool not registered");
  return tool;
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalComposioKey === undefined) delete process.env.COMPOSIO_API_KEY;
  else process.env.COMPOSIO_API_KEY = originalComposioKey;
  clearVolatileSecretsForTesting();
});

describe("swarm_x MCP tool", () => {
  test("routes composio requests with server-side auth and scrubbed output", async () => {
    process.env.COMPOSIO_API_KEY = "ck_tool_secret_value";
    const fetchMock = mock(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe("https://backend.composio.dev/api/v3.1/tools?limit=1");
      expect(init?.method).toBe("GET");
      expect((init?.headers as Record<string, string>)["x-api-key"]).toBe("ck_tool_secret_value");
      return jsonResponse({ ok: true, token: "ck_tool_secret_value" });
    });
    globalThis.fetch = fetchMock;

    const tool = buildTool();
    const result = (await tool.handler(
      {
        target: "composio",
        method: "GET",
        path: "/tools",
        query: { limit: 1 },
      },
      { sessionId: "s", requestInfo: { headers: {} } },
    )) as {
      isError?: boolean;
      structuredContent: { ok: boolean; response: unknown; responseText: string };
    };

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.isError).toBe(false);
    expect(result.structuredContent.ok).toBe(true);
    expect(JSON.stringify(result.structuredContent.response)).toContain(
      "[REDACTED:COMPOSIO_API_KEY]",
    );
    expect(result.structuredContent.responseText).not.toContain("ck_tool_secret_value");
  });

  test("rejects absolute composio paths", async () => {
    process.env.COMPOSIO_API_KEY = "ck_tool_secret_value";
    const fetchMock = mock(async () => jsonResponse({ ok: true }));
    globalThis.fetch = fetchMock;

    const tool = buildTool();
    const result = (await tool.handler(
      {
        target: "composio",
        method: "GET",
        path: "https://evil.example/tools",
      },
      { sessionId: "s", requestInfo: { headers: {} } },
    )) as { isError?: boolean; structuredContent: { message: string } };

    expect(result.isError).toBe(true);
    expect(result.structuredContent.message).toContain("endpoint must be a Composio API path");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
