import { expect, test } from "bun:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerExtensionInstallTool } from "../tools/extension-install";

type RegisteredTool = {
  handler: (args: unknown, extra: unknown) => Promise<unknown>;
};

test("a lead installs a disabled draft with explicit activation guidance", async () => {
  const previousBaseUrl = process.env.MCP_BASE_URL;
  const previousApiKey = process.env.AGENT_SWARM_API_KEY;
  const savedFetch = globalThis.fetch;
  const leadId = crypto.randomUUID();

  process.env.MCP_BASE_URL = "http://extensions-example.test";
  process.env.AGENT_SWARM_API_KEY = "extensions-example-key";
  globalThis.fetch = (async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    expect(body).toEqual({ template: "minimal" });
    expect(body.enabled).toBeUndefined();
    expect(body.activeVersion).toBeUndefined();
    return new Response(
      JSON.stringify({
        extension: {
          id: "extension-1",
          name: "minimal",
          version: 1,
          activeVersion: 1,
          enabled: false,
          status: "disabled",
          priority: 100,
          consecutiveFailures: 0,
        },
        contentDeduped: false,
        assets: { created: [], updated: [], skipped: [], deleted: [], detached: [] },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }) as typeof globalThis.fetch;

  try {
    const server = new McpServer({ name: "extensions-example", version: "1" });
    registerExtensionInstallTool(server);
    const tool = (server as unknown as { _registeredTools: Record<string, RegisteredTool> })
      ._registeredTools["extension-install"]!;
    const result = (await tool.handler(
      { template: "minimal" },
      {
        sessionId: "extensions-example",
        requestInfo: { headers: { "x-agent-id": leadId } },
      },
    )) as {
      isError?: boolean;
      structuredContent: Record<string, unknown>;
    };

    expect(result.isError).toBe(false);
    expect(result.structuredContent).toMatchObject({ enabled: false, status: "disabled" });
    expect(String(result.structuredContent.message)).toContain("extension-enable");
  } finally {
    globalThis.fetch = savedFetch;
    if (previousBaseUrl === undefined) delete process.env.MCP_BASE_URL;
    else process.env.MCP_BASE_URL = previousBaseUrl;
    if (previousApiKey === undefined) delete process.env.AGENT_SWARM_API_KEY;
    else process.env.AGENT_SWARM_API_KEY = previousApiKey;
  }
});
