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
import * as z from "zod";
import { withSpan } from "../otel";
import type { PermissionVerb } from "../rbac/permissions";
import { scrubObject, scrubSecrets } from "../utils/secret-scrubber";

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

/**
 * Canonical result every swarm MCP tool returns. The registrar — not the tool —
 * composes the wire-level CallToolResult from it, so the text channel and
 * structuredContent can never diverge (see runbooks/mcp-tool-results.md for the
 * per-harness evidence behind this contract).
 */
export type SwarmToolData = Record<string, unknown>;

export type SwarmToolResult<TData extends SwarmToolData = SwarmToolData> = {
  /** Truthful outcome. Becomes `isError = !ok` and `structuredContent.success`. */
  ok: boolean;
  /** One-line summary. Required, non-empty — the first thing every harness shows the model. */
  message: string;
  /** Model-needed payload rendering (tables, lists, error detail). Appended to the text channel. */
  details?: string;
  /** Structured payload, spread into structuredContent alongside the envelope keys. */
  data?: TData;
  /** Single-sentence conditional steer, appended to BOTH channels. */
  nudge?: string;
  /**
   * Skip the finalize pipeline's secret scrubbing for this result. ONLY for
   * deliberate credential-reveal branches (oauth-access-token, script-apis
   * create/rotate, get-config includeSecrets) whose entire purpose is handing
   * the agent a secret — the central scrubber would otherwise redact the
   * reveal. Everything else stays scrubbed.
   */
  allowSecretEgress?: boolean;
};

export const toolOk = <TData extends SwarmToolData = SwarmToolData>(
  message: string,
  extras: Omit<SwarmToolResult<TData>, "ok" | "message"> = {},
): SwarmToolResult<TData> => ({ ok: true, message, ...extras });

export const toolErr = <TData extends SwarmToolData = SwarmToolData>(
  message: string,
  extras: Omit<SwarmToolResult<TData>, "ok" | "message"> = {},
): SwarmToolResult<TData> => ({ ok: false, message, ...extras });

/**
 * Envelope keys the registrar writes into structuredContent for every tool.
 * Output schemas must include these and must be LOOSE (`z.looseObject`):
 * plain `z.object` emits `additionalProperties: false`, which makes
 * client-side validators (opencode's official-SDK client) reject the spread
 * `data` keys after the write already landed.
 */
export const swarmToolEnvelopeShape = {
  success: z.boolean(),
  message: z.string(),
  details: z.string().optional(),
  nudge: z.string().optional(),
};

/** Build a permissive output schema: envelope + optional tool-specific data shape. */
export const swarmToolOutputSchema = <S extends z.ZodRawShape>(dataShape?: S) =>
  z.looseObject({ ...swarmToolEnvelopeShape, ...(dataShape ?? ({} as S)) });

export const SCRIPT_AUTHORING_NUDGE =
  "Scripts must `export default async function (args, ctx)` — args FIRST, ctx second; run script-query-types (no name) for the full ctx/SDK type surface, and see the `swarm-scripts` skill for authoring patterns.";

// Only steer on failures plausibly caused by the script itself (typecheck or
// runtime) — on lookup/transport/authorization errors the authoring advice
// distracts from the reported problem.
const scriptAuthoringNudge = (r: SwarmToolResult): string | undefined =>
  !r.ok && /Typecheck failed:|Script run .*failed/.test(r.message)
    ? SCRIPT_AUTHORING_NUDGE
    : undefined;

/**
 * Central conditional nudges, keyed by tool name. Applied by the finalize
 * pipeline when the tool did not set an explicit nudge. Keep entries to a
 * single sentence; derive only from already-scrubbed result fields.
 */
export const NUDGES: Record<string, (result: SwarmToolResult) => string | undefined> = {
  "script-run": scriptAuthoringNudge,
  "script-upsert": scriptAuthoringNudge,
  "launch-script-run": scriptAuthoringNudge,
  "get-script-run": scriptAuthoringNudge,
  "script-search": (r) => {
    if (!r.ok) return undefined;
    // proxyScriptsApi wraps the parsed HTTP body as data = { status, data },
    // so the results array lives one level down.
    const body = (r.data as { data?: { results?: unknown[] } } | undefined)?.data;
    const results = body?.results;
    return Array.isArray(results) && results.length === 0
      ? "No scripts matched — the catalog ships seeded example scripts; re-run script-search with an empty query to list them."
      : undefined;
  },
  "memory-search": (r) => {
    if (!r.ok) return undefined;
    const results = (r.data as { results?: Array<{ rateHint?: unknown }> } | undefined)?.results;
    return Array.isArray(results) && results.some((entry) => Boolean(entry?.rateHint))
      ? "Rate memories that help or mislead you with memory_rate."
      : undefined;
  },
};

// Cap for the auto-rendered data fallback in the text channel — Codex's
// ~10KB middle-out truncation is the tightest harness budget.
const DATA_FALLBACK_CAP = 8_000;

function truncateForText(text: string): string {
  if (text.length <= DATA_FALLBACK_CAP) return text;
  return `${text.slice(0, DATA_FALLBACK_CAP)}\n… [truncated ${text.length - DATA_FALLBACK_CAP} chars]`;
}

type FinalizeContext = { toolName: string };
type FinalizeMiddleware = (result: SwarmToolResult, ctx: FinalizeContext) => SwarmToolResult;

const scrubMiddleware: FinalizeMiddleware = (result) =>
  result.allowSecretEgress ? result : scrubObject(result);

const nudgeMiddleware: FinalizeMiddleware = (result, ctx) => {
  if (result.nudge) return result;
  const nudge = NUDGES[ctx.toolName]?.(result);
  return nudge ? { ...result, nudge } : result;
};

// Ordered: scrub first so nudges (and any future middleware) only ever see
// scrubbed data. Future ctx-control middleware (response pruning, auto-KV
// overflow) slots in between nudge and the final transform.
const FINALIZE_PIPELINE: FinalizeMiddleware[] = [scrubMiddleware, nudgeMiddleware];

/**
 * Transform a SwarmToolResult into the wire CallToolResult. Both channels are
 * composed identically and are independently self-sufficient: Codex reads only
 * structuredContent, pi/opencode/claude-managed read only content.text.
 * structuredContent is ALWAYS present (opencode's SDK client throws when a
 * declared outputSchema has no structuredContent).
 */
export function finalizeSwarmToolResult(toolName: string, result: SwarmToolResult): CallToolResult {
  let r = result;
  if (!r.message?.trim()) {
    console.warn(`[mcp] tool ${toolName} returned an empty message — every tool must summarize`);
    r = {
      ...r,
      message: r.ok
        ? "Tool call succeeded (no message provided)."
        : "Tool call failed (no message provided).",
    };
  }
  for (const middleware of FINALIZE_PIPELINE) r = middleware(r, { toolName });

  // Text-channel completeness guarantee: when a tool sets data but no details,
  // render the data as JSON into the text channel. Most harnesses only ever
  // show the model content.text — without this fallback, a data-only payload
  // would be invisible there. Not copied into structuredContent.details (the
  // structured channel already carries data verbatim).
  const dataFallback =
    !r.details?.trim() && r.data && Object.keys(r.data).length > 0
      ? truncateForText(JSON.stringify(r.data, null, 2))
      : undefined;

  const text = [r.message, r.details ?? dataFallback, r.nudge]
    .filter((part): part is string => Boolean(part?.trim()))
    .join("\n\n");
  const structuredContent: Record<string, unknown> = {
    ...(r.data ?? {}),
    success: r.ok,
    message: r.message,
  };
  if (r.details) structuredContent.details = r.details;
  if (r.nudge) structuredContent.nudge = r.nudge;

  return {
    content: [{ type: "text", text }],
    structuredContent,
    isError: !r.ok,
  };
}

// Infer the input type from the schema
type InferInput<Args extends undefined | ZodRawShapeCompat | AnySchema> =
  Args extends ZodRawShapeCompat
    ? ShapeOutput<Args>
    : Args extends AnySchema
      ? SchemaOutput<Args>
      : undefined;

// Callback type with requestInfo injected as second parameter.
// Tools return SwarmToolResult (ours) — never a raw MCP CallToolResult.
type ToolCallbackWithInfo<Args extends undefined | ZodRawShapeCompat | AnySchema = undefined> =
  Args extends undefined
    ? (requestInfo: RequestInfo, meta: Meta) => SwarmToolResult | Promise<SwarmToolResult>
    : (
        args: InferInput<Args>,
        requestInfo: RequestInfo,
        meta: Meta,
      ) => SwarmToolResult | Promise<SwarmToolResult>;

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
            const outcome = await (
              cb as (
                requestInfo: RequestInfo,
                meta: Meta,
              ) => SwarmToolResult | Promise<SwarmToolResult>
            )(requestInfo, meta);
            const result = finalizeSwarmToolResult(name, outcome);
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
          const outcome = await (
            cb as (
              args: InferInput<InputArgs>,
              requestInfo: RequestInfo,
              meta: Meta,
            ) => SwarmToolResult | Promise<SwarmToolResult>
          )(args, requestInfo, meta);
          const result = finalizeSwarmToolResult(name, outcome);
          span.setAttributes(toolResultAttributes(result));
          return result;
        },
        toolRequestAttributes(name, requestInfo, args),
      );
    }) as Parameters<typeof server.registerTool>[2]);
  };
};
