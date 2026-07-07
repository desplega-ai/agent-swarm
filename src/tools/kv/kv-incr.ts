import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { incrKv, KvTypeCollisionError } from "@/be/db";
import { createToolRegistrar } from "@/tools/utils";
import { KvEntrySchema, KvKeySchema, KvNamespaceSchema } from "@/types";
import { kvWriteAuthError } from "./kv-write-auth";
import { resolveNamespace } from "./resolve-namespace";

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
