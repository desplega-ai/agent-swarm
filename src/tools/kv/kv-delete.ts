import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { deleteKv } from "@/be/db";
import { createToolRegistrar } from "@/tools/utils";
import { KvKeySchema, KvNamespaceSchema } from "@/types";
import { kvWriteAuthError } from "./kv-write-auth";
import { resolveNamespace } from "./resolve-namespace";

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
      const authErr = kvWriteAuthError(resolved.namespace, { agentId: requestInfo.agentId });
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
