import type { IncomingMessage, ServerResponse } from "node:http";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  type AnySchema,
  getParseErrorMessage,
  normalizeObjectSchema,
  safeParseAsync,
} from "@modelcontextprotocol/sdk/server/zod-compat.js";
import { z } from "zod";
import { createServer } from "@/server";
import { isExtensionAgentId } from "../extensions/dispatcher";
import { isMcpToolAllowedForScripts } from "../scripts-runtime/sdk-allowlist";
import {
  markExtensionRequestOrigin,
  markScriptSdkRequestOrigin,
  type RequestInfo,
} from "../tools/utils";
import { route, runtimeInstanceHeader } from "./route-def";
import { json, jsonError } from "./utils";

// Lazy singleton — created once on first bridge call to avoid boot-time cost.
let _bridgeServer: McpServer | null = null;
async function getBridgeServer(): Promise<McpServer> {
  if (!_bridgeServer) {
    // Always full tool surface: the bridge is how scripts reach every SDK
    // tool, including when SCRIPTS_ONLY_MCP trims the external MCP server or
    // CAPABILITIES trims the externally exposed tool groups. Capability flags
    // shape the agents' MCP tool list, not what scripts can do — the scripts
    // surface is governed by SDK_ALLOWLIST instead.
    _bridgeServer = await createServer({ scriptsOnly: false, fullSurface: true });
  }
  return _bridgeServer;
}

type RegisteredTool = {
  handler: (argsOrExtra: unknown, extra?: unknown) => unknown | Promise<unknown>;
  inputSchema?: AnySchema;
  enabled?: boolean;
};

type ToolRegistry = Record<string, RegisteredTool>;

export class InProcessToolInvocationError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "InProcessToolInvocationError";
  }
}

export async function invokeToolInProcess(args: {
  toolName: string;
  args?: unknown;
  agentId?: string;
  sourceTaskId?: string;
  runtimeInstanceId?: string;
  callOrigin: Extract<RequestInfo["callOrigin"], "script-sdk" | "extension">;
}): Promise<unknown> {
  if (!isMcpToolAllowedForScripts(args.toolName)) {
    throw new InProcessToolInvocationError(
      `Tool '${args.toolName}' is not in the SDK allowlist`,
      403,
    );
  }

  const server = await getBridgeServer();
  const tools = (server as unknown as { _registeredTools: ToolRegistry })._registeredTools;
  const tool = tools[args.toolName];
  if (!tool) {
    throw new InProcessToolInvocationError(
      `Tool '${args.toolName}' not found in the MCP registry`,
      404,
    );
  }
  if (tool.enabled === false) {
    throw new InProcessToolInvocationError(`Tool '${args.toolName}' is disabled`, 400);
  }

  const baseExtra = {
    sessionId: args.callOrigin === "extension" ? "extension" : "mcp-bridge",
    requestInfo: {
      headers: {
        "x-agent-id": args.agentId ?? "",
        ...(args.sourceTaskId ? { "x-source-task-id": args.sourceTaskId } : {}),
        ...(args.runtimeInstanceId ? { "x-runtime-instance-id": args.runtimeInstanceId } : {}),
      },
    },
  };
  const extra =
    args.callOrigin === "extension"
      ? markExtensionRequestOrigin(baseExtra)
      : markScriptSdkRequestOrigin(baseExtra);

  let handlerArgs: unknown = args.args ?? {};
  if (tool.inputSchema) {
    const inputObj = normalizeObjectSchema(tool.inputSchema);
    const parseResult = await safeParseAsync(inputObj ?? tool.inputSchema, handlerArgs);
    if (!parseResult.success) {
      const parseError = "error" in parseResult ? parseResult.error : "Unknown error";
      throw new InProcessToolInvocationError(
        `Invalid arguments for tool '${args.toolName}': ${getParseErrorMessage(parseError)}`,
        400,
      );
    }
    handlerArgs = parseResult.data;
  }

  return tool.inputSchema
    ? await Promise.resolve(tool.handler(handlerArgs, extra))
    : await Promise.resolve(tool.handler(extra));
}

const mcpBridgeRoute = route({
  method: "post",
  path: "/api/mcp-bridge",
  pattern: ["api", "mcp-bridge"],
  summary: "Generic MCP tool proxy for the scripts SDK bridge",
  tags: ["Scripts"],
  headers: runtimeInstanceHeader("acquire work through bridged tools"),
  body: z.object({
    tool: z.string().min(1).max(200),
    args: z.record(z.string(), z.unknown()).default({}),
  }),
  responses: {
    200: {
      description: "Tool result",
      unstructured:
        "Generic MCP tool proxy — response shape is whatever the invoked tool's structuredContent/content returns, which varies per tool",
    },
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

  const sourceTaskId = Array.isArray(req.headers["x-source-task-id"])
    ? req.headers["x-source-task-id"][0]
    : (req.headers["x-source-task-id"] as string | undefined);
  // Runtime identity rides the bridge like the agent identity so the
  // work-acquisition gates in bridged tools see the invoking worker process.
  const runtimeInstanceId = Array.isArray(req.headers["x-runtime-instance-id"])
    ? req.headers["x-runtime-instance-id"][0]
    : (req.headers["x-runtime-instance-id"] as string | undefined);

  try {
    const result = await invokeToolInProcess({
      toolName,
      args,
      agentId: myAgentId,
      sourceTaskId,
      runtimeInstanceId,
      callOrigin: isExtensionAgentId(myAgentId) ? "extension" : "script-sdk",
    });

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
    jsonError(res, message, err instanceof InProcessToolInvocationError ? err.status : 500);
  }
  return true;
}
