import { describe, expect, test } from "bun:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { createToolRegistrar } from "../tools/utils";

describe("createToolRegistrar with no inputSchema", () => {
  test("handler receives requestInfo from meta when no inputSchema is defined", async () => {
    const server = new McpServer({ name: "test-no-input", version: "1.0.0" });

    let receivedRequestInfo: unknown = null;
    let receivedMeta: unknown = null;

    createToolRegistrar(server)(
      "test-no-input-tool",
      {
        title: "Test Tool",
        description: "Tool with no inputSchema",
        outputSchema: z.object({ ok: z.boolean() }),
      },
      async (requestInfo, meta) => {
        receivedRequestInfo = requestInfo;
        receivedMeta = meta;
        return {
          content: [{ type: "text" as const, text: "ok" }],
          structuredContent: { ok: true },
        };
      },
    );

    // Access the internal registered tool handler directly
    // The MCP SDK stores tools in _registeredTools and calls handler(extra) for no-inputSchema
    const registeredTools = (server as Record<string, unknown>)._registeredTools as Record<
      string,
      { handler: (extra: unknown) => Promise<unknown> }
    >;

    const tool = registeredTools["test-no-input-tool"];
    expect(tool).toBeDefined();

    // Simulate how the MCP SDK calls the handler for tools without inputSchema:
    // It calls handler(extra) with a single argument (the Meta/extra object)
    const fakeExtra = {
      sessionId: "test-session-123",
      requestInfo: {
        headers: {
          "x-agent-id": "agent-abc",
          "x-source-task-id": "task-xyz",
        },
      },
    };

    // This is the critical test: the handler should NOT throw
    // Before the fix, this would throw "undefined is not an object (evaluating 'req.requestInfo')"
    const result = await tool.handler(fakeExtra);

    expect(receivedRequestInfo).toEqual({
      sessionId: "test-session-123",
      agentId: "agent-abc",
      sourceTaskId: "task-xyz",
    });
    expect(receivedMeta).toBe(fakeExtra);
    expect(result).toBeDefined();
  });

  test("handler with inputSchema still receives args correctly", async () => {
    const server = new McpServer({ name: "test-with-input", version: "1.0.0" });

    let receivedArgs: unknown = null;
    let receivedRequestInfo: unknown = null;

    createToolRegistrar(server)(
      "test-with-input-tool",
      {
        title: "Test Tool With Input",
        description: "Tool with inputSchema",
        inputSchema: z.object({ name: z.string() }),
        outputSchema: z.object({ greeting: z.string() }),
      },
      async (args, requestInfo, _meta) => {
        receivedArgs = args;
        receivedRequestInfo = requestInfo;
        return {
          content: [{ type: "text" as const, text: "ok" }],
          structuredContent: { greeting: `Hello ${args.name}` },
        };
      },
    );

    const registeredTools = (server as Record<string, unknown>)._registeredTools as Record<
      string,
      { handler: (args: unknown, extra: unknown) => Promise<unknown> }
    >;

    const tool = registeredTools["test-with-input-tool"];

    // MCP SDK calls handler(args, extra) when inputSchema is defined
    const fakeExtra = {
      sessionId: "test-session-456",
      requestInfo: {
        headers: { "x-agent-id": "agent-def" },
      },
    };

    const result = await tool.handler({ name: "World" }, fakeExtra);

    expect(receivedArgs).toEqual({ name: "World" });
    expect(receivedRequestInfo).toEqual({
      sessionId: "test-session-456",
      agentId: "agent-def",
      sourceTaskId: undefined,
    });
    expect(result).toBeDefined();
  });
});
