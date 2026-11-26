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
import {
  runIdempotentToolCall,
  TOOL_CALL_IDEMPOTENCY_TTL_MS,
  ToolCallInFlightError,
} from "../be/scripts/tool-call-idempotency";
import { resolveBridgeCallOrigin } from "../extensions/dispatcher";
import { isMcpToolAllowedForScripts } from "../scripts-runtime/sdk-allowlist";
import {
  markExtensionRequestOrigin,
  markScriptSdkRequestOrigin,
  type RequestInfo,
} from "../tools/utils";
import { runForBridgedScriptRun } from "../utils/request-auth-context";
import {
  IDEMPOTENCY_KEY_PATTERN,
  IDEMPOTENT_REPLAYED_HEADER,
  readIdempotencyKey,
} from "./idempotency-key";
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

export function resetBridgeServerForTesting(): void {
  _bridgeServer = null;
}

type RegisteredTool = {
  handler: (argsOrExtra: unknown, extra?: unknown) => unknown | Promise<unknown>;
  inputSchema?: AnySchema;
  enabled?: boolean;
  annotations?: { readOnlyHint?: boolean };
};

type ToolRegistry = Record<string, RegisteredTool>;

async function registeredTools(): Promise<ToolRegistry> {
  const server = await getBridgeServer();
  // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- the MCP SDK keeps its tool registry private.
  return (server as unknown as { _registeredTools: ToolRegistry })._registeredTools;
}

/**
 * A tool that declares `readOnlyHint: true`. The bridge never dedupes it:
 * running a read twice changes nothing. A tool without the hint counts as a write.
 */
export async function isReadOnlyBridgeTool(toolName: string): Promise<boolean> {
  return (await registeredTools())[toolName]?.annotations?.readOnlyHint === true;
}

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
  /** Audit-only task; see `RequestInfo.auditSourceTaskId`. */
  auditSourceTaskId?: string;
  runtimeInstanceId?: string;
  callOrigin: Extract<RequestInfo["callOrigin"], "script-sdk" | "extension">;
}): Promise<unknown> {
  if (!isMcpToolAllowedForScripts(args.toolName)) {
    throw new InProcessToolInvocationError(
      `Tool '${args.toolName}' is not in the SDK allowlist`,
      403,
    );
  }

  const tools = await registeredTools();
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
        ...(args.auditSourceTaskId ? { "x-audit-source-task-id": args.auditSourceTaskId } : {}),
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
  headers: runtimeInstanceHeader("acquire work through bridged tools").extend({
    "Idempotency-Key": z
      .string()
      .regex(IDEMPOTENCY_KEY_PATTERN)
      .optional()
      .describe(
        "Optional key, 1-255 visible ASCII characters, scoped to the caller and the tool. " +
          "The first successful call of a tool that is not read-only runs it and records its " +
          "result; a later call with the same key and tool returns that result (with " +
          `\`${IDEMPOTENT_REPLAYED_HEADER}: true\`) and runs nothing, whatever its args. A call ` +
          "that fails or that the tool refuses records nothing. A second call while the first " +
          "still runs waits for it, then gets a 409. Read-only tools ignore the key. Records " +
          `expire after ${TOOL_CALL_IDEMPOTENCY_TTL_MS / 86_400_000} days. Durable script runs ` +
          "send one on every ctx.swarm call.",
      ),
  }),
  body: z.object({
    tool: z.string().min(1).max(200),
    args: z.record(z.string(), z.unknown()).default({}),
    /** The background script run making the call, so the runs it starts join its tree. */
    parentScriptRunId: z.string().min(1).optional(),
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
    409: { description: "A call with the same Idempotency-Key is still running" },
  },
  rbac: { ungated: "scripts SDK bridge: each proxied MCP tool runs its own gates" },
});

function headerValue(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

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

  const { tool: toolName, args, parentScriptRunId } = parsed.body;

  const sourceTaskId = headerValue(req, "x-source-task-id");
  // Runtime identity rides the bridge like the agent identity so the
  // work-acquisition gates in bridged tools see the invoking worker process.
  const runtimeInstanceId = headerValue(req, "x-runtime-instance-id");
  const idempotency = readIdempotencyKey(req, res, myAgentId);
  if (idempotency === null) return true;

  try {
    const invoke = () =>
      runForBridgedScriptRun(parentScriptRunId, () =>
        invokeToolInProcess({
          toolName,
          args,
          agentId: myAgentId,
          sourceTaskId,
          auditSourceTaskId: headerValue(req, "x-audit-source-task-id"),
          runtimeInstanceId,
          // The agent header is caller-controlled; the extension origin also needs the
          // per-process token that only the in-process extension SDK holds.
          callOrigin: resolveBridgeCallOrigin(myAgentId, headerValue(req, "x-extension-token")),
        }),
      );
    let result: unknown;
    if (idempotency && !(await isReadOnlyBridgeTool(toolName))) {
      const outcome = await runIdempotentToolCall(
        { principal: idempotency.principal, tool: toolName, key: idempotency.key },
        invoke,
        // A refusal (toolErr) changed nothing: let a retry run it again.
        (value) => !(value && typeof value === "object" && "isError" in value && value.isError),
      );
      if (outcome.replayed) res.setHeader(IDEMPOTENT_REPLAYED_HEADER, "true");
      result = outcome.result;
    } else {
      result = await invoke();
    }

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
    const status =
      err instanceof InProcessToolInvocationError
        ? err.status
        : err instanceof ToolCallInFlightError
          ? 409
          : 500;
    jsonError(res, message, status);
  }
  return true;
}
