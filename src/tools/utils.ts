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
import { sweepExpiredKvPrefix, upsertKv } from "../be/db";
import { MCP_OVERFLOW_NAMESPACE, mcpOverflowNamespace } from "../kv-overflow";
import { withSpan } from "../otel";
import type { PermissionVerb } from "../rbac/permissions";
import { scrubObject, scrubSecrets } from "../utils/secret-scrubber";

type Meta = RequestHandlerExtra<ServerRequest, ServerNotification>;

const scriptSdkRequestOrigins = new WeakSet<object>();

export function markScriptSdkRequestOrigin<T extends object>(meta: T): T {
  scriptSdkRequestOrigins.add(meta);
  return meta;
}

export type RequestInfo = {
  sessionId: string | undefined;
  agentId: string | undefined;
  sourceTaskId: string | undefined;
  contextKey: string | undefined;
  callOrigin: "mcp" | "script-sdk";
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
    callOrigin: scriptSdkRequestOrigins.has(req) ? "script-sdk" : "mcp",
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

export type SwarmToolTruncation = {
  truncated: true;
  fullValueAt: string;
  originalBytes: number;
  limitBytes: number;
  retrieval: string;
};

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
  /** Ctx-control metadata attached centrally when the full wire result is spilled. */
  truncation?: SwarmToolTruncation;
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
const swarmToolTruncationSchema = z.looseObject({
  truncated: z.literal(true),
  fullValueAt: z.string(),
  originalBytes: z.number(),
  limitBytes: z.number(),
  retrieval: z.string(),
});

export const swarmToolEnvelopeShape = {
  success: z.boolean(),
  message: z.string(),
  details: z.string().optional(),
  nudge: z.string().optional(),
  truncation: swarmToolTruncationSchema.optional(),
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
  // kv-get is spill-exempt (retrieval path), so oversized values reach the
  // harness whole and get natively truncated there. Steer big-value work
  // toward scripts, where the full value stays out of the model's context.
  "kv-get": (r) => {
    if (!r.ok) return undefined;
    const entry = (r.data as { entry?: { value?: unknown } | null } | undefined)?.entry;
    if (!entry) return undefined;
    const rendered =
      typeof entry.value === "string" ? entry.value : (JSON.stringify(entry.value) ?? "");
    return rendered.length > MCP_RESULT_WIRE_LIMIT_BYTES
      ? "Large value — your harness may truncate this result; to filter or aggregate it, process it in a script via ctx.swarm.kv_get instead."
      : undefined;
  },
};

export const MCP_RESULT_WIRE_LIMIT_BYTES = 10_000;
export { MCP_OVERFLOW_NAMESPACE, mcpOverflowNamespace };
export const MCP_OVERFLOW_TTL_MS = 24 * 60 * 60 * 1_000;
const MCP_PROSE_PREVIEW_CHARS = 1_200;

type FinalizeContext = {
  toolName: string;
  agentId: string | undefined;
  callOrigin: RequestInfo["callOrigin"];
};
type FinalizeMiddleware = (result: SwarmToolResult, ctx: FinalizeContext) => SwarmToolResult;

const scrubMiddleware: FinalizeMiddleware = (result) =>
  result.allowSecretEgress ? result : scrubObject(result);

const nudgeMiddleware: FinalizeMiddleware = (result, ctx) => {
  if (result.nudge) return result;
  const nudge = NUDGES[ctx.toolName]?.(result);
  return nudge ? { ...result, nudge } : result;
};

/**
 * Compose the wire shape without applying size control. Ctx-control calls this
 * once to measure the complete text + structured result, then the finalizer
 * calls it again after any overflow replacement.
 */
function composeWireResult(r: SwarmToolResult): CallToolResult {
  const normalizedDetails = r.details?.trim() || undefined;

  // Text-channel completeness guarantee: when a tool sets data but no details,
  // render the data as JSON into the text channel. Most harnesses only ever
  // show the model content.text — without this fallback, a data-only payload
  // would be invisible there. Not copied into structuredContent.details (the
  // structured channel already carries data verbatim).
  const dataFallback =
    !normalizedDetails && r.data && Object.keys(r.data).length > 0
      ? JSON.stringify(r.data, null, 2)
      : undefined;

  // Payload LAST: harnesses truncate oversized text from the tail (or keep
  // head+tail), so message and nudge lead and a cut lands inside the payload
  // rendering — a truncated JSON prefix still shows its first key values.
  const text = [r.message, r.nudge, normalizedDetails ?? dataFallback]
    .filter((part): part is string => Boolean(part?.trim()))
    .join("\n\n");
  const structuredContent: Record<string, unknown> = {
    ...(r.data ?? {}),
    success: r.ok,
    message: r.message,
  };
  if (normalizedDetails) structuredContent.details = normalizedDetails;
  if (r.nudge) structuredContent.nudge = r.nudge;
  if (r.truncation) structuredContent.truncation = r.truncation;

  return {
    content: [{ type: "text", text }],
    structuredContent,
    isError: !r.ok,
  };
}

function overflowKey(toolName: string, value: string): string {
  const safeToolName = toolName.replace(/[^a-zA-Z0-9._-]/g, "-").slice(0, 80);
  const hash = new Bun.CryptoHasher("sha256").update(value).digest("hex");
  return `v1/${safeToolName}/${hash}`;
}

function overflowRetrieval(namespace: string, key: string): string {
  return (
    `kv-get(${JSON.stringify({ namespace, key })}) returns the full value ` +
    `(your harness may truncate it); to filter or aggregate it instead, ` +
    `process it in a script via ctx.swarm.kv_get.`
  );
}

function canonicalOverflowPayload(toolName: string, result: SwarmToolResult): string {
  // `allowSecretEgress` deliberately bypasses the normal wire scrubber. Never
  // persist that escape hatch: overflow KV is readable by authenticated agents,
  // so the stored canonical payload is always scrubbed independently.
  const safe = result.allowSecretEgress ? scrubObject(result) : result;
  return JSON.stringify({
    version: 1,
    toolName,
    outcome: {
      ok: safe.ok,
      message: safe.message,
      ...(safe.details ? { details: safe.details } : {}),
      ...(safe.data ? { data: safe.data } : {}),
      ...(safe.nudge ? { nudge: safe.nudge } : {}),
    },
  });
}

/**
 * Tools the spill middleware must never rewrite. kv-get IS the retrieval path
 * for spilled values — bounding it would re-spill the read into a new pointer
 * and the full value could never leave the store over MCP. Its oversized
 * results go out whole; the harness applies its own truncation and the
 * kv-get nudge steers big-value processing toward scripts.
 */
export const CTX_CONTROL_EXEMPT_TOOLS: ReadonlySet<string> = new Set(["kv-get"]);

type ArrayTarget = {
  path: string;
  parent: Record<string, unknown>;
  key: string;
  originalItems: unknown[];
};

function cloneResultData(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(cloneResultData);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, child]) => [
      key,
      cloneResultData(child),
    ]),
  );
}

function collectArrayTargets(
  value: unknown,
  path: string,
  targets: ArrayTarget[],
  parent?: Record<string, unknown>,
  key?: string,
): void {
  if (Array.isArray(value)) {
    if (parent !== undefined && key !== undefined && value.length > 0) {
      targets.push({ path, parent, key, originalItems: value.slice() });
    }
    // Treat array elements as atomic records. Truncating a parent array is
    // clearer than independently truncating nested arrays in retained items.
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [childKey, child] of Object.entries(value as Record<string, unknown>)) {
    collectArrayTargets(
      child,
      `${path}.${childKey}`,
      targets,
      value as Record<string, unknown>,
      childKey,
    );
  }
}

function setArrayLength(target: ArrayTarget, length: number): void {
  target.parent[target.key] = target.originalItems.slice(0, length);
}

function currentArrayLength(target: ArrayTarget): number {
  const value = target.parent[target.key];
  return Array.isArray(value) ? value.length : 0;
}

function pruneBranchesWithoutArrays(value: unknown): boolean {
  if (Array.isArray(value)) return true;
  if (!value || typeof value !== "object") return false;

  let containsArray = false;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (pruneBranchesWithoutArrays(child)) {
      containsArray = true;
    } else {
      delete (value as Record<string, unknown>)[key];
    }
  }
  return containsArray;
}

function arrayTruncationMessage(message: string, targets: ArrayTarget[]): string {
  const truncatedTargets = targets.filter(
    (target) => currentArrayLength(target) < target.originalItems.length,
  );
  if (truncatedTargets.length === 1) {
    const [target] = truncatedTargets;
    if (target) {
      const kept = currentArrayLength(target);
      const original = target.originalItems.length;
      const originalCount = new RegExp(`\\b${original}\\b`);
      if (originalCount.test(message)) {
        const rewritten = message.replace(originalCount, String(kept)).replace(/\.\s*$/, "");
        return `${rewritten} (truncated from ${original}; ${target.path} shortened in this bounded response).`;
      }
    }
  }
  const summaries = truncatedTargets.map(
    (target) =>
      `${currentArrayLength(target)} of ${target.originalItems.length} ${target.path} item(s)`,
  );
  if (summaries.length === 0) return message;
  return `${message} Returned ${summaries.join(", ")} in this bounded response.`;
}

function arrayPreservingOverflowResult(
  result: SwarmToolResult,
  data: SwarmToolData,
  targets: ArrayTarget[],
  truncation: SwarmToolTruncation,
  pointer: string,
): SwarmToolResult {
  const normalizedDetails = result.details?.trim() || undefined;
  const details = normalizedDetails
    ? `${normalizedDetails.slice(0, MCP_PROSE_PREVIEW_CHARS)}\n… [truncated ${Math.max(
        normalizedDetails.length - MCP_PROSE_PREVIEW_CHARS,
        0,
      )} chars]\n${pointer}`
    : `JSON payload truncated in place:\n${JSON.stringify(data, null, 2)}\n${pointer}`;
  return {
    ok: result.ok,
    message: arrayTruncationMessage(result.message, targets),
    details,
    data,
    nudge: result.nudge,
    truncation,
  };
}

/**
 * Prefer a short, valid prefix for array-shaped data over deleting the data
 * field wholesale. This prevents idiomatic `res.data.items ?? []` callers
 * from silently interpreting overflow as a genuine empty result.
 */
function truncateArraysInPlace(
  result: SwarmToolResult,
  truncation: SwarmToolTruncation,
  pointer: string,
): SwarmToolResult | undefined {
  if (!result.data) return undefined;
  const data = cloneResultData(result.data) as SwarmToolData;
  const targets: ArrayTarget[] = [];
  collectArrayTargets(data, "data", targets);
  if (targets.length === 0) return undefined;

  targets.sort(
    (a, b) =>
      Buffer.byteLength(JSON.stringify(b.originalItems), "utf8") -
      Buffer.byteLength(JSON.stringify(a.originalItems), "utf8"),
  );

  const render = () => arrayPreservingOverflowResult(result, data, targets, truncation, pointer);
  const fits = () =>
    Buffer.byteLength(JSON.stringify(composeWireResult(render())), "utf8") <=
    MCP_RESULT_WIRE_LIMIT_BYTES;

  for (const target of targets) {
    setArrayLength(target, 0);
    if (!fits()) continue;

    let low = 0;
    let high = target.originalItems.length;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      setArrayLength(target, mid);
      if (fits()) low = mid;
      else high = mid - 1;
    }
    setArrayLength(target, low);
    return render();
  }

  if (fits()) return render();

  // A large scalar sibling can keep the result oversized even after every
  // array is emptied. Prefer dropping those non-array branches over dropping
  // the array keys—the complete canonical result is already in overflow KV.
  pruneBranchesWithoutArrays(data);
  if (!fits()) return undefined;

  for (const target of targets) {
    let low = 0;
    let high = target.originalItems.length;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      setArrayLength(target, mid);
      if (fits()) low = mid;
      else high = mid - 1;
    }
    setArrayLength(target, low);
  }
  return render();
}

const ctxControlMiddleware: FinalizeMiddleware = (result, ctx) => {
  // Calls made through ctx.swarm.* execute inside a script sandbox, so their
  // response never enters the model's context. The script SDK has a separate,
  // much higher hard response limit to protect the sandbox heap.
  if (ctx.callOrigin === "script-sdk") return result;
  if (CTX_CONTROL_EXEMPT_TOOLS.has(ctx.toolName)) return result;

  const fullWire = composeWireResult(result);
  const fullWireJson = JSON.stringify(fullWire);
  const fullWireBytes = Buffer.byteLength(fullWireJson, "utf8");
  if (fullWireBytes <= MCP_RESULT_WIRE_LIMIT_BYTES) {
    return result;
  }

  let fullValueAt: string;
  let retrieval: string;
  if (ctx.agentId) {
    const storedValue = canonicalOverflowPayload(ctx.toolName, result);
    const key = overflowKey(ctx.toolName, storedValue);
    const namespace = mcpOverflowNamespace(ctx.agentId);
    fullValueAt = `kv://${namespace}/${key}`;
    retrieval = overflowRetrieval(namespace, key);
    const expiresAt = Date.now() + MCP_OVERFLOW_TTL_MS;

    // The public KV write surfaces cap values at 2 MiB, while the SQLite TEXT
    // column and this direct server-side helper have no declared size limit.
    // Sweep the whole per-agent namespace family so expired rows from inactive
    // agents do not wait for their owner to spill again.
    sweepExpiredKvPrefix(MCP_OVERFLOW_NAMESPACE);
    upsertKv({
      namespace,
      key,
      value: storedValue,
      valueType: "string",
      expiresAt,
    });
  } else {
    fullValueAt = "unavailable: authenticated agent identity required";
    retrieval = "Retry the tool with an authenticated X-Agent-ID to retain the full value.";
  }

  const truncation: SwarmToolTruncation = {
    truncated: true,
    fullValueAt,
    originalBytes: fullWireBytes,
    limitBytes: MCP_RESULT_WIRE_LIMIT_BYTES,
    retrieval,
  };
  const pointer =
    `Full value: ${fullValueAt}\nRetrieval: ${retrieval}\n` +
    `Truncation: ${JSON.stringify(truncation)}`;
  const arrayPreservingResult = truncateArraysInPlace(result, truncation, pointer);
  if (arrayPreservingResult) return arrayPreservingResult;

  const normalizedDetails = result.details?.trim() || undefined;
  const details = normalizedDetails
    ? `${normalizedDetails.slice(0, MCP_PROSE_PREVIEW_CHARS)}\n… [truncated ${Math.max(
        normalizedDetails.length - MCP_PROSE_PREVIEW_CHARS,
        0,
      )} chars]\n${pointer}`
    : `JSON payload omitted because the composed result exceeded ${MCP_RESULT_WIRE_LIMIT_BYTES} bytes.\n${pointer}`;

  return {
    ok: result.ok,
    message: result.message,
    details,
    nudge: result.nudge,
    truncation,
  };
};

// Ordered and security-sensitive: ctx-control runs only after the result and
// any dynamic nudge have been scrubbed, and before the final wire transform.
const FINALIZE_PIPELINE: FinalizeMiddleware[] = [
  scrubMiddleware,
  nudgeMiddleware,
  ctxControlMiddleware,
];

/**
 * Transform a SwarmToolResult into the wire CallToolResult. Both channels are
 * composed identically and are independently self-sufficient: Codex reads only
 * structuredContent, pi/opencode/claude-managed read only content.text.
 * structuredContent is ALWAYS present (opencode's SDK client throws when a
 * declared outputSchema has no structuredContent).
 */
export function finalizeSwarmToolResult(
  toolName: string,
  result: SwarmToolResult,
  requestInfo: Pick<RequestInfo, "agentId"> & Partial<Pick<RequestInfo, "callOrigin">> = {
    agentId: undefined,
  },
): CallToolResult {
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
  for (const middleware of FINALIZE_PIPELINE) {
    r = middleware(r, {
      toolName,
      agentId: requestInfo.agentId,
      callOrigin: requestInfo.callOrigin ?? "mcp",
    });
  }
  return composeWireResult(r);
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
            const result = finalizeSwarmToolResult(name, outcome, requestInfo);
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
          const result = finalizeSwarmToolResult(name, outcome, requestInfo);
          span.setAttributes(toolResultAttributes(result));
          return result;
        },
        toolRequestAttributes(name, requestInfo, args),
      );
    }) as Parameters<typeof server.registerTool>[2]);
  };
};
