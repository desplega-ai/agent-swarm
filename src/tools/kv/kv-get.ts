import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { getKv } from "@/be/db";
import {
  hasKvViewArgs,
  joinKvPath,
  type KvView,
  resolveKvTarget,
  resolveKvView,
  sliceKvTarget,
} from "@/kv-view";
import {
  createToolRegistrar,
  MCP_RESULT_WIRE_LIMIT_BYTES,
  type SwarmToolResult,
  swarmToolOutputSchema,
  swarmToolResultBytes,
  toolErr,
  toolOk,
} from "@/tools/utils";
import { type KvEntry, KvKeySchema, KvNamespaceSchema, KvValueTypeSchema } from "@/types";
import { kvReadAuthError } from "./kv-read-auth";
import { resolveNamespace } from "./resolve-namespace";

// Loose, format-pin-free mirror of KvEntrySchema for MCP output validation.
const kvEntryOutputSchema = z.looseObject({
  namespace: z.string().optional(),
  key: z.string().optional(),
  value: z.unknown().optional(),
  valueType: KvValueTypeSchema.optional(),
  expiresAt: z.number().int().nullable().optional(),
  createdAt: z.number().int().optional(),
  updatedAt: z.number().int().optional(),
});

function renderKvEntry(entry: {
  value: unknown;
  valueType: string;
  expiresAt: number | null;
}): string {
  const valueText =
    typeof entry.value === "string" ? entry.value : JSON.stringify(entry.value, null, 2);
  const expiry = entry.expiresAt ? ` (expires ${new Date(entry.expiresAt).toISOString()})` : "";
  return `value (${entry.valueType}): ${valueText}${expiry}`;
}

const kvViewOutputSchema = z.looseObject({
  path: z.string().optional(),
  type: z.string().optional(),
  total: z.number().optional(),
  offset: z.number().optional(),
  returned: z.number().optional(),
  nextOffset: z.number().nullable().optional(),
});

function describeView(view: KvView): string {
  const target = view.path ? `"${view.path}"` : "the value";
  if (view.total === undefined) return `${target} (${view.type})`;
  const unit =
    view.type === "array" ? "items" : view.type === "object" ? "keys" : "chars (JSON-encoded)";
  const offset = view.offset ?? 0;
  return `${target} ${unit} ${offset}..${offset + (view.returned ?? 0)} of ${view.total}`;
}

/**
 * A targeted read shrunk to the per-channel MCP budget. kv-get is spill-exempt,
 * so the tool bounds its own views: the page shrinks (binary search on items,
 * keys, or chars) and `view.nextOffset` says where to resume.
 */
function boundedView(
  entry: KvEntry,
  agentId: string | undefined,
  args: { path?: string; offset?: number; limit?: number },
): SwarmToolResult {
  const { namespace, key } = entry;
  const failed = (error: string) => toolErr(error, { data: { yourAgentId: agentId, namespace } });
  // Validates path and offset/limit applicability; the page itself is sized below.
  const checked = resolveKvView(entry.value, args);
  if (!checked.ok) return failed(checked.error);
  const target = resolveKvTarget(entry.value, args.path ?? "");
  if (!target.ok) return failed(target.error);

  const { value: _value, ...meta } = entry;
  // Strings go out JSON-encoded too: the wire composer trims `details`, which
  // would drop a slice's edge whitespace and erase a whitespace-only slice.
  const render = (value: unknown, view: KvView) =>
    toolOk(`Read ${describeView(view)} from "${key}" in "${namespace}".`, {
      details: JSON.stringify(value),
      data: { yourAgentId: agentId, namespace, entry: meta, view },
    });
  const baseView = checked.view;
  if (baseView.total === undefined) return render(checked.value, baseView);

  const offset = baseView.offset ?? 0;
  const page = (count: number) => {
    const sliced = sliceKvTarget(target.value, offset, count);
    return render(sliced?.value, {
      ...baseView,
      returned: sliced?.returned ?? 0,
      nextOffset: sliced?.nextOffset ?? null,
    });
  };
  const wanted = Math.min(args.limit ?? baseView.total, Math.max(0, baseView.total - offset));
  const fits = (count: number) => swarmToolResultBytes(page(count)) <= MCP_RESULT_WIRE_LIMIT_BYTES;
  if (fits(wanted)) return page(wanted);

  let low = 0;
  let high = wanted;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (fits(mid)) low = mid;
    else high = mid - 1;
  }
  const bounded = page(low);
  const firstKey =
    baseView.type === "array"
      ? String(offset)
      : baseView.type === "object"
        ? Object.keys(target.value as object)[offset]
        : undefined;
  const firstPath =
    firstKey === undefined
      ? undefined
      : `${baseView.path ? `${baseView.path}.` : ""}${joinKvPath([firstKey])}`;
  const note =
    low === 0 && firstPath !== undefined
      ? ` The entry at offset ${offset} alone exceeds the ${MCP_RESULT_WIRE_LIMIT_BYTES}-byte cap; narrow the path to "${firstPath}".`
      : ` Page shrunk to fit the ${MCP_RESULT_WIRE_LIMIT_BYTES}-byte cap; continue at view.nextOffset.`;
  return { ...bounded, message: `${bounded.message}${note}` };
}

export const registerKvGetTool = (server: McpServer) => {
  createToolRegistrar(server)(
    "kv-get",
    {
      title: "KV Get",
      description:
        "Read a key from the swarm KV store. Returns the entry or null if missing/expired. Namespace defaults to your current context (Slack thread / PR / Linear issue when invoked from a task; otherwise your agent scratchpad). Without path/offset/limit the whole value comes back unbounded. With any of them you get a bounded view (≤10KB per channel): `path` is a dot path into a JSON value (string entries holding JSON, such as spilled tool results, count as JSON; numeric segments index arrays, e.g. `outcome.data.rows` or `rows.3`; escape a dot inside a key as `\\.`), and `offset`/`limit` page the array items, object keys, or string characters found there. The result's `view.nextOffset` says where the next page starts.",
      annotations: { readOnlyHint: true },

      inputSchema: z.object({
        key: KvKeySchema.describe("KV key (≤512 chars, [a-zA-Z0-9._:/-])."),
        namespace: KvNamespaceSchema.optional().describe(
          "Optional explicit namespace. Defaults to the caller's contextKey.",
        ),
        path: z
          .string()
          .max(1024)
          .optional()
          .describe(
            'Dot path into the JSON value, e.g. "outcome.data.rows" or "rows.3". "" is the whole value. A dot inside a key is escaped as "\\.".',
          ),
        offset: z
          .number()
          .int()
          .nonnegative()
          .optional()
          .describe("First array item / object key / string char to return. Default 0."),
        limit: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Max items / keys / chars to return; the page also shrinks to fit the cap."),
      }),
      outputSchema: swarmToolOutputSchema({
        yourAgentId: z.string().optional(),
        namespace: z.string().optional(),
        entry: kvEntryOutputSchema.nullable().optional(),
        view: kvViewOutputSchema.optional(),
      }),
    },
    async ({ key, namespace, path, offset, limit }, requestInfo) => {
      const resolved = await resolveNamespace(namespace, requestInfo);
      if ("error" in resolved) {
        return toolErr(resolved.error, { data: { yourAgentId: requestInfo.agentId } });
      }
      const authErr = kvReadAuthError(resolved.namespace, { agentId: requestInfo.agentId });
      if (authErr) {
        return toolErr(authErr, {
          data: { yourAgentId: requestInfo.agentId, namespace: resolved.namespace },
        });
      }

      // kv-get is exempt from the ctx-control spill (see CTX_CONTROL_EXEMPT_TOOLS):
      // it is the retrieval path for spilled values. Without view args oversized
      // entries go out whole and the harness applies its own truncation; with
      // path/offset/limit the tool bounds the page itself.
      const entry = await getKv(resolved.namespace, key);
      if (entry && hasKvViewArgs({ path, offset, limit })) {
        return boundedView(entry, requestInfo.agentId, { path, offset, limit });
      }
      return toolOk(
        entry
          ? `Found "${key}" in "${resolved.namespace}".`
          : `No entry for "${key}" in "${resolved.namespace}".`,
        {
          details: entry ? renderKvEntry(entry) : undefined,
          data: {
            yourAgentId: requestInfo.agentId,
            namespace: resolved.namespace,
            entry: entry ?? null,
          },
        },
      );
    },
  );
};
