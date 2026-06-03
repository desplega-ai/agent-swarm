import type { IncomingMessage, ServerResponse } from "node:http";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { createServer } from "@/server";
import { isSdkToolAllowed } from "../scripts-runtime/sdk-allowlist";
import { route } from "./route-def";
import { json, jsonError } from "./utils";

// Lazy singleton — created once on first bridge call to avoid boot-time cost.
let _bridgeServer: McpServer | null = null;
function getBridgeServer(): McpServer {
  if (!_bridgeServer) {
    _bridgeServer = createServer();
  }
  return _bridgeServer;
}

type RegisteredTool = {
  handler: Function;
  inputSchema?: unknown;
  enabled?: boolean;
};

type ToolRegistry = Record<string, RegisteredTool>;

const mcpBridgeRoute = route({
  method: "post",
  path: "/api/mcp-bridge",
  pattern: ["api", "mcp-bridge"],
  summary: "Generic MCP tool proxy for the scripts SDK bridge",
  tags: ["Scripts"],
  body: z.object({
    tool: z.string().min(1).max(200),
    args: z.record(z.string(), z.unknown()).default({}),
  }),
  responses: {
    200: { description: "Tool result" },
    400: { description: "Invalid tool name or args" },
    403: { description: "Tool not in SDK allowlist" },
    404: { description: "Tool not found" },
  },
});

export async function handleMcpBridge(
  req: IncomingMessage,
  res: ServerResponse,
  pathSegments: string[],
  _queryParams?: URLSearchParams,
  myAgentId?: string,
): Promise<boolean> {
  if (!mcpBridgeRoute.match(req.method, pathSegments)) return false;

  const parsed = await mcpBridgeRoute.parse(req, res, pathSegments, new URLSearchParams());
  if (!parsed) return true;

  const { tool: toolName, args } = parsed.body;

  if (!isSdkToolAllowed(toolName)) {
    jsonError(res, `Tool '${toolName}' is not in the SDK allowlist`, 403);
    return true;
  }

  const server = getBridgeServer();
  const tools = (server as unknown as { _registeredTools: ToolRegistry })._registeredTools;

  const tool = tools[toolName];
  if (!tool) {
    jsonError(res, `Tool '${toolName}' not found in the MCP registry`, 404);
    return true;
  }

  if (tool.enabled === false) {
    jsonError(res, `Tool '${toolName}' is disabled`, 400);
    return true;
  }

  const sourceTaskId = Array.isArray(req.headers["x-source-task-id"])
    ? req.headers["x-source-task-id"][0]
    : (req.headers["x-source-task-id"] as string | undefined);

  const extra = {
    sessionId: "mcp-bridge",
    requestInfo: {
      headers: {
        "x-agent-id": myAgentId ?? "",
        ...(sourceTaskId ? { "x-source-task-id": sourceTaskId } : {}),
      },
    },
  };

  try {
    const result = tool.inputSchema
      ? await Promise.resolve(tool.handler(args, extra))
      : await Promise.resolve(tool.handler(extra));

    if (result && typeof result === "object" && "structuredContent" in result) {
      json(res, result.structuredContent);
    } else if (result && typeof result === "object" && "content" in result) {
      const content = (result as { content: Array<{ type: string; text?: string }> }).content;
      const text = content
        .filter((c) => c.type === "text" && c.text)
        .map((c) => c.text)
        .join("\n");
      try {
        json(res, JSON.parse(text));
      } catch {
        json(res, { result: text });
      }
    } else {
      json(res, result ?? {});
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    jsonError(res, message, 500);
  }
  return true;
}
