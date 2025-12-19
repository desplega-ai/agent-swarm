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

type Meta = RequestHandlerExtra<ServerRequest, ServerNotification>;

export type RequestInfo = {
  sessionId: string | undefined;
  agentId: string | undefined;
};

export const getRequestInfo = (req: Meta): RequestInfo => {
  const agentIdHeader = req.requestInfo?.headers?.["x-agent-id"];

  let agentId: string | undefined;

  if (Array.isArray(agentIdHeader)) {
    agentId = agentIdHeader?.[0];
  } else if (typeof agentIdHeader === "string") {
    agentId = agentIdHeader;
  }

  return {
    sessionId: req.sessionId || undefined,
    agentId,
  };
};

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
    return server.registerTool(name, config, ((args: InferInput<InputArgs>, meta: Meta) => {
      const requestInfo = getRequestInfo(meta);

      // Handle zero-argument case
      if (config.inputSchema === undefined) {
        return (
          cb as (requestInfo: RequestInfo, meta: Meta) => CallToolResult | Promise<CallToolResult>
        )(requestInfo, meta);
      }

      // Handle with-arguments case
      return (
        cb as (
          args: InferInput<InputArgs>,
          requestInfo: RequestInfo,
          meta: Meta,
        ) => CallToolResult | Promise<CallToolResult>
      )(args, requestInfo, meta);
    }) as Parameters<typeof server.registerTool>[2]);
  };
};
