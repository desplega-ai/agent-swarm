import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type {
  AnySchema,
  SchemaOutput,
  ShapeOutput,
  ZodRawShapeCompat,
} from "@modelcontextprotocol/sdk/server/zod-compat.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type {
  CallToolResult,
  ServerNotification,
  ServerRequest,
  ToolAnnotations,
} from "@modelcontextprotocol/sdk/types.js";
import { withSpan } from "../otel";
import type { PermissionVerb } from "../rbac/permissions";
import { scrubSecrets } from "../utils/secret-scrubber";

type Meta = RequestHandlerExtra<ServerRequest, ServerNotification>;

export type RequestInfo = {
  sessionId: string | undefined;
  agentId: string | undefined;
  sourceTaskId: string | undefined;
  contextKey: string | undefined;
};

export const getRequestInfo = (req: Meta): RequestInfo => {
  const agentIdHeader = req.requestInfo?.headers?.["x-agent-id"];
  const sourceTaskIdHeader = req.requestInfo?.headers?.["x-source-task-id"];
  const contextKeyHeader = req.requestInfo?.headers?.["x-context-key"];

  let agentId: string | undefined;
  if (Array.isArray(agentIdHeader)) {
    agentId = agentIdHeader?.[0];
  } else if (typeof agentIdHeader === "string") {
    agentId = agentIdHeader;
  }

  let sourceTaskId: string | undefined;
  if (Array.isArray(sourceTaskIdHeader)) {
    sourceTaskId = sourceTaskIdHeader?.[0];
  } else if (typeof sourceTaskIdHeader === "string") {
    sourceTaskId = sourceTaskIdHeader;
  }

  let contextKey: string | undefined;
  if (Array.isArray(contextKeyHeader)) {
    contextKey = contextKeyHeader?.[0];
  } else if (typeof contextKeyHeader === "string") {
    contextKey = contextKeyHeader;
  }

  return {
    sessionId: req.sessionId || undefined,
    agentId,
    sourceTaskId,
    contextKey,
  };
};

const PREVIEW_LIMIT = 500;

function previewValue(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  try {
    const serialized = typeof value === "string" ? value : JSON.stringify(value);
    if (!serialized) return undefined;
    const scrubbed = scrubSecrets(serialized);
    return scrubbed.length > PREVIEW_LIMIT ? `${scrubbed.slice(0, PREVIEW_LIMIT)}...` : scrubbed;
  } catch {
    return "[unserializable]";
  }
}

function toolRequestAttributes(name: string, requestInfo: RequestInfo, args?: unknown) {
  return {
    "mcp.tool.name": name,
    "mcp.session.id": requestInfo.sessionId,
    "agent.id": requestInfo.agentId,
    "agentswarm.task.id": requestInfo.sourceTaskId,
    "agentswarm.tool.args_preview": previewValue(args),
  };
}

function toolResultAttributes(result: CallToolResult) {
  return {
    "mcp.tool.result_content_count": Array.isArray(result.content) ? result.content.length : 0,
    "mcp.tool.is_error": result.isError ?? false,
    "agentswarm.tool.result_preview": previewValue(result.content),
  };
}

// Infer the input type from the schema
type InferInput<Args extends undefined | ZodRawShapeCompat | AnySchema> =
  Args extends ZodRawShapeCompat
    ? ShapeOutput<Args>
    : Args extends AnySchema
      ? SchemaOutput<Args>
      : undefined;

// Callback type with requestInfo injected as second parameter
type ToolCallbackWithInfo<Args extends undefined | ZodRawShapeCompat | AnySchema = undefined> =
  Args extends undefined
    ? (requestInfo: RequestInfo, meta: Meta) => CallToolResult | Promise<CallToolResult>
    : (
        args: InferInput<Args>,
        requestInfo: RequestInfo,
        meta: Meta,
      ) => CallToolResult | Promise<CallToolResult>;

type ToolConfig<
  InputArgs extends undefined | ZodRawShapeCompat | AnySchema,
  OutputArgs extends ZodRawShapeCompat | AnySchema,
> = {
  title?: string;
  description?: string;
  inputSchema?: InputArgs;
  outputSchema?: OutputArgs;
  annotations?: ToolAnnotations;
  rbac?: { permission: PermissionVerb } | { ungated: string };
  _meta?: Record<string, unknown>;
};

/**
 * Creates a tool registration helper that automatically extracts request info
 * and passes it as the second parameter to the callback.
 *
 * @example
 * const registerTool = createToolRegistrar(server);
 *
 * registerTool(
 *   "my-tool",
 *   { inputSchema: z.object({ name: z.string() }) },
 *   async ({ name }, requestInfo, meta) => {
 *     // requestInfo.sessionId and requestInfo.agentId are available
 *     return { content: [{ type: "text", text: `Hello ${name}` }] };
 *   }
 * );
 */
export const createToolRegistrar = (server: McpServer) => {
  return <
    OutputArgs extends ZodRawShapeCompat | AnySchema,
    InputArgs extends undefined | ZodRawShapeCompat | AnySchema = undefined,
  >(
    name: string,
    config: ToolConfig<InputArgs, OutputArgs>,
    cb: ToolCallbackWithInfo<InputArgs>,
  ) => {
    // When inputSchema is undefined, the MCP SDK calls handler(extra) with a single arg.
    // When inputSchema is defined, it calls handler(args, extra) with two args.
    if (config.inputSchema === undefined) {
      return server.registerTool(name, config, (async (meta: Meta) => {
        const requestInfo = getRequestInfo(meta);
        return withSpan(
          "mcp.tool",
          async (span) => {
            const result = await (
              cb as (
                requestInfo: RequestInfo,
                meta: Meta,
              ) => CallToolResult | Promise<CallToolResult>
            )(requestInfo, meta);
            span.setAttributes(toolResultAttributes(result));
            return result;
          },
          toolRequestAttributes(name, requestInfo),
        );
      }) as Parameters<typeof server.registerTool>[2]);
    }

    return server.registerTool(name, config, (async (args: InferInput<InputArgs>, meta: Meta) => {
      const requestInfo = getRequestInfo(meta);
      return withSpan(
        // Span name carries the tool: a static `mcp.tool` is unreadable in a
        // trace tree. Cardinality is bounded — tool names are a fixed enum.
        `mcp.tool ${name}`,
        async (span) => {
          const result = await (
            cb as (
              args: InferInput<InputArgs>,
              requestInfo: RequestInfo,
              meta: Meta,
            ) => CallToolResult | Promise<CallToolResult>
          )(args, requestInfo, meta);
          span.setAttributes(toolResultAttributes(result));
          return result;
        },
        toolRequestAttributes(name, requestInfo, args),
      );
    }) as Parameters<typeof server.registerTool>[2]);
  };
};
