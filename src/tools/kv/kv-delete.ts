import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { deleteKv } from "@/be/db";
import { createToolRegistrar, swarmToolOutputSchema, toolErr, toolOk } from "@/tools/utils";
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
      outputSchema: swarmToolOutputSchema({
        yourAgentId: z.string().optional(),
        namespace: z.string().optional(),
        deleted: z.boolean().optional(),
      }),
    },
    async ({ key, namespace }, requestInfo) => {
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
      const deleted = deleteKv(resolved.namespace, key);
      return toolOk(
        deleted
          ? `Deleted "${key}" from "${resolved.namespace}".`
          : `No entry to delete at "${key}" in "${resolved.namespace}".`,
        {
          data: { yourAgentId: requestInfo.agentId, namespace: resolved.namespace, deleted },
        },
      );
    },
  );
};
