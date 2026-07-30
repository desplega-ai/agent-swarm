import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { getKv, getKvValueRange } from "@/be/db";
import { createToolRegistrar, swarmToolOutputSchema, toolErr, toolOk } from "@/tools/utils";
import type { KvEntry, KvValueRange } from "@/types";
import {
  KvKeySchema,
  KvNamespaceSchema,
  KvValueRangeSchema,
  KvValueTypeSchema,
  MAX_KV_VALUE_RANGE_CHARS,
} from "@/types";
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

export const registerKvGetTool = (server: McpServer) => {
  createToolRegistrar(server)(
    "kv-get",
    {
      title: "KV Get",
      description:
        "Read a key from the swarm KV store. Returns the entry or null if missing/expired. Namespace defaults to your current context (Slack thread / PR / Linear issue when invoked from a task; otherwise your agent scratchpad).",
      annotations: { readOnlyHint: true },

      inputSchema: z.object({
        key: KvKeySchema.describe("KV key (≤512 chars, [a-zA-Z0-9._:/-])."),
        namespace: KvNamespaceSchema.optional().describe(
          "Optional explicit namespace. Defaults to the caller's contextKey.",
        ),
        offset: z
          .number()
          .int()
          .nonnegative()
          .optional()
          .describe("Character offset for a bounded string-value read. Defaults to 0."),
        limit: z
          .number()
          .int()
          .positive()
          .max(MAX_KV_VALUE_RANGE_CHARS)
          .optional()
          .describe(
            "Maximum UTF-16 code units to return from a string value (≤512). Use with offset to retrieve large values safely.",
          ),
      }),
      outputSchema: swarmToolOutputSchema({
        yourAgentId: z.string().optional(),
        namespace: z.string().optional(),
        entry: kvEntryOutputSchema.nullable().optional(),
        range: KvValueRangeSchema.optional(),
      }),
    },
    async ({ key, namespace, offset, limit }, requestInfo) => {
      const resolved = resolveNamespace(namespace, requestInfo);
      if ("error" in resolved) {
        return toolErr(resolved.error, { data: { yourAgentId: requestInfo.agentId } });
      }
      const authErr = kvReadAuthError(resolved.namespace, { agentId: requestInfo.agentId });
      if (authErr) {
        return toolErr(authErr, {
          data: { yourAgentId: requestInfo.agentId, namespace: resolved.namespace },
        });
      }

      const wantsRange = offset !== undefined || limit !== undefined;
      let entry: KvEntry | null;
      let range: KvValueRange | undefined;
      try {
        if (wantsRange) {
          const ranged = getKvValueRange(
            resolved.namespace,
            key,
            offset ?? 0,
            limit ?? MAX_KV_VALUE_RANGE_CHARS,
          );
          entry = ranged?.entry ?? null;
          range = ranged?.range;
        } else {
          entry = getKv(resolved.namespace, key);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : "bounded read failed";
        return toolErr(message, {
          data: { yourAgentId: requestInfo.agentId, namespace: resolved.namespace },
        });
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
            ...(range ? { range } : {}),
          },
        },
      );
    },
  );
};
