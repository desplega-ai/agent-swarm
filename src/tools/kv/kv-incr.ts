import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { incrKv, KvTypeCollisionError } from "@/be/db";
import { createToolRegistrar, swarmToolOutputSchema, toolErr, toolOk } from "@/tools/utils";
import { KvKeySchema, KvNamespaceSchema, KvValueTypeSchema } from "@/types";
import { kvWriteAuthError } from "./kv-write-auth";
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

export const registerKvIncrTool = (server: McpServer) => {
  createToolRegistrar(server)(
    "kv-incr",
    {
      title: "KV Incr",
      description:
        "Atomically increment an integer KV entry. Creates the entry (set to `by`) if it doesn't exist or has expired. Fails if the existing value_type is not 'integer' (use kv-delete first if you want to switch).",
      annotations: {},

      inputSchema: z.object({
        key: KvKeySchema,
        by: z
          .number()
          .int()
          .optional()
          .describe("Increment (or decrement when negative). Default: 1."),
        namespace: KvNamespaceSchema.optional(),
      }),
      outputSchema: swarmToolOutputSchema({
        yourAgentId: z.string().optional(),
        namespace: z.string().optional(),
        entry: kvEntryOutputSchema.optional(),
      }),
    },
    async ({ key, by, namespace }, requestInfo) => {
      const resolved = resolveNamespace(namespace, requestInfo);
      if ("error" in resolved) {
        return toolErr(resolved.error, { data: { yourAgentId: requestInfo.agentId } });
      }
      const authErr = kvWriteAuthError(resolved.namespace, { agentId: requestInfo.agentId });
      if (authErr) {
        return toolErr(authErr, {
          data: { yourAgentId: requestInfo.agentId, namespace: resolved.namespace },
        });
      }
      try {
        const entry = incrKv(resolved.namespace, key, by ?? 1);
        return toolOk(`"${key}" now ${entry.value} in "${resolved.namespace}".`, {
          data: { yourAgentId: requestInfo.agentId, namespace: resolved.namespace, entry },
        });
      } catch (err) {
        if (err instanceof KvTypeCollisionError) {
          return toolErr(err.message, {
            data: { yourAgentId: requestInfo.agentId, namespace: resolved.namespace },
          });
        }
        const msg = err instanceof Error ? err.message : "INCR failed";
        return toolErr(msg, {
          data: { yourAgentId: requestInfo.agentId, namespace: resolved.namespace },
        });
      }
    },
  );
};
