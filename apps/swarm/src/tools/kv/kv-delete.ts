import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { deleteKv, getAgentById } from "@/be/db";
import { createToolRegistrar } from "@/tools/utils";
import { KvKeySchema, KvNamespaceSchema } from "@/types";
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

export const registerKvDeleteTool = (server: McpServer) => {
  createToolRegistrar(server)(
    "kv-delete",
    {
      title: "KV Delete",
      description:
        "Remove a key from the swarm KV store. Returns whether a row was actually deleted. Namespace defaults to your current context.",
      annotations: { idempotentHint: true },

      inputSchema: z.object({
        key: KvKeySchema,
        namespace: KvNamespaceSchema.optional(),
      }),
      outputSchema: z.object({
        yourAgentId: z.string().uuid().optional(),
        success: z.boolean(),
        message: z.string(),
        namespace: z.string().optional(),
        deleted: z.boolean().optional(),
      }),
    },
    async ({ key, namespace }, requestInfo) => {
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
      const deleted = deleteKv(resolved.namespace, key);
      return {
        content: [
          {
            type: "text",
            text: deleted
              ? `Deleted "${key}" from "${resolved.namespace}".`
              : `No entry to delete at "${key}" in "${resolved.namespace}".`,
          },
        ],
        structuredContent: {
          yourAgentId: requestInfo.agentId,
          success: true,
          message: deleted ? "deleted" : "not found",
          namespace: resolved.namespace,
          deleted,
        },
      };
    },
  );
};
