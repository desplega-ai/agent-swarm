import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { getKv } from "@/be/db";
import { createToolRegistrar, swarmToolOutputSchema, toolErr, toolOk } from "@/tools/utils";
import { KvKeySchema, KvNamespaceSchema, KvValueTypeSchema } from "@/types";
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
      }),
      outputSchema: swarmToolOutputSchema({
        yourAgentId: z.string().optional(),
        namespace: z.string().optional(),
        entry: kvEntryOutputSchema.nullable().optional(),
      }),
    },
    async ({ key, namespace }, requestInfo) => {
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
      // it is the retrieval path for spilled values, so oversized entries go out
      // whole and the harness applies its own truncation.
      const entry = await getKv(resolved.namespace, key);
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
