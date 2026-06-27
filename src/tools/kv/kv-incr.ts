import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createToolRegistrar } from "@swarm/mcp-tool";
import { getAgentById, incrKv, KvTypeCollisionError } from "@swarm/storage";
import { KvEntrySchema, KvKeySchema, KvNamespaceSchema } from "@swarm/types";
import * as z from "zod";
import { resolveNamespace } from "./resolve-namespace";

function authError(namespace: string, info: { agentId: string | undefined }): string | null {
  if (namespace.startsWith("task:page:")) {
    return "task:page:* writes require a page-proxy request, not an MCP call";
  }
  if (namespace.startsWith("task:agent:")) {
    const target = namespace.slice("task:agent:".length);
    if (info.agentId && target === info.agentId) return null;
    if (info.agentId) {
      const agent = getAgentById(info.agentId);
      if (agent?.isLead) return null;
    }
    return "writes to another agent's namespace require lead";
  }
  return null;
}

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
      outputSchema: z.object({
        yourAgentId: z.string().uuid().optional(),
        success: z.boolean(),
        message: z.string(),
        namespace: z.string().optional(),
        entry: KvEntrySchema.optional(),
      }),
    },
    async ({ key, by, namespace }, requestInfo) => {
      const resolved = resolveNamespace(namespace, requestInfo);
      if ("error" in resolved) {
        return {
          content: [{ type: "text", text: resolved.error }],
          structuredContent: {
            yourAgentId: requestInfo.agentId,
            success: false,
            message: resolved.error,
          },
        };
      }
      const authErr = authError(resolved.namespace, { agentId: requestInfo.agentId });
      if (authErr) {
        return {
          content: [{ type: "text", text: authErr }],
          structuredContent: {
            yourAgentId: requestInfo.agentId,
            success: false,
            message: authErr,
            namespace: resolved.namespace,
          },
        };
      }
      try {
        const entry = incrKv(resolved.namespace, key, by ?? 1);
        return {
          content: [
            {
              type: "text",
              text: `"${key}" now ${entry.value} in "${resolved.namespace}".`,
            },
          ],
          structuredContent: {
            yourAgentId: requestInfo.agentId,
            success: true,
            message: "ok",
            namespace: resolved.namespace,
            entry,
          },
        };
      } catch (err) {
        if (err instanceof KvTypeCollisionError) {
          return {
            content: [{ type: "text", text: err.message }],
            structuredContent: {
              yourAgentId: requestInfo.agentId,
              success: false,
              message: err.message,
              namespace: resolved.namespace,
            },
          };
        }
        const msg = err instanceof Error ? err.message : "INCR failed";
        return {
          content: [{ type: "text", text: msg }],
          structuredContent: {
            yourAgentId: requestInfo.agentId,
            success: false,
            message: msg,
            namespace: resolved.namespace,
          },
        };
      }
    },
  );
};
