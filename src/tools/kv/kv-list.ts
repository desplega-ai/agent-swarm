import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { countKv, listKv } from "@/be/db";
import { createToolRegistrar, swarmToolOutputSchema, toolErr, toolOk } from "@/tools/utils";
import { KvNamespaceSchema, KvValueTypeSchema } from "@/types";
import { resolveNamespace } from "./resolve-namespace";

const MAX_KV_LIST_LIMIT = 1000;

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

function renderKvEntries(
  entries: Array<{ key: string; value: unknown; valueType: string }>,
): string | undefined {
  if (entries.length === 0) return undefined;
  return entries
    .map((entry) => {
      const valueText = typeof entry.value === "string" ? entry.value : JSON.stringify(entry.value);
      return `- ${entry.key} (${entry.valueType}): ${valueText}`;
    })
    .join("\n");
}

export const registerKvListTool = (server: McpServer) => {
  createToolRegistrar(server)(
    "kv-list",
    {
      title: "KV List",
      description:
        "List KV entries in the resolved namespace (optionally filtered by key prefix). Expired entries are filtered out. Pagination via limit/offset (limit capped at 1000).",
      annotations: { readOnlyHint: true },

      inputSchema: z.object({
        prefix: z.string().optional().describe("Key prefix to filter on."),
        limit: z
          .number()
          .int()
          .positive()
          .max(MAX_KV_LIST_LIMIT)
          .optional()
          .describe("Max entries to return (default 100, max 1000)."),
        offset: z.number().int().nonnegative().optional(),
        namespace: KvNamespaceSchema.optional(),
      }),
      outputSchema: swarmToolOutputSchema({
        yourAgentId: z.string().optional(),
        namespace: z.string().optional(),
        entries: z.array(kvEntryOutputSchema).optional(),
        total: z.number().optional(),
      }),
    },
    async ({ prefix, limit, offset, namespace }, requestInfo) => {
      const resolved = resolveNamespace(namespace, requestInfo);
      if ("error" in resolved) {
        return toolErr(resolved.error, { data: { yourAgentId: requestInfo.agentId } });
      }
      const effectiveLimit = Math.min(limit ?? 100, MAX_KV_LIST_LIMIT);
      const effectivePrefix = prefix && prefix.length > 0 ? prefix : undefined;
      const entries = listKv(resolved.namespace, {
        prefix: effectivePrefix,
        limit: effectiveLimit,
        offset: offset ?? 0,
      });
      const total = countKv(resolved.namespace, { prefix: effectivePrefix });
      return toolOk(
        entries.length === 0
          ? `No entries in "${resolved.namespace}".`
          : `Found ${entries.length} of ${total} entries in "${resolved.namespace}".`,
        {
          details: renderKvEntries(entries),
          data: {
            yourAgentId: requestInfo.agentId,
            namespace: resolved.namespace,
            entries,
            total,
          },
        },
      );
    },
  );
};
