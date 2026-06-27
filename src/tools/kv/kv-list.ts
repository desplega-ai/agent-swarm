import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createToolRegistrar } from "@swarm/mcp-tool";
import { countKv, listKv } from "@swarm/storage";
import { KvEntrySchema, KvNamespaceSchema } from "@swarm/types";
import * as z from "zod";
import { resolveNamespace } from "./resolve-namespace";

const MAX_KV_LIST_LIMIT = 1000;

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
      outputSchema: z.object({
        yourAgentId: z.string().uuid().optional(),
        success: z.boolean(),
        message: z.string(),
        namespace: z.string().optional(),
        entries: z.array(KvEntrySchema).optional(),
        total: z.number().optional(),
      }),
    },
    async ({ prefix, limit, offset, namespace }, requestInfo) => {
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
      const effectiveLimit = Math.min(limit ?? 100, MAX_KV_LIST_LIMIT);
      const effectivePrefix = prefix && prefix.length > 0 ? prefix : undefined;
      const entries = listKv(resolved.namespace, {
        prefix: effectivePrefix,
        limit: effectiveLimit,
        offset: offset ?? 0,
      });
      const total = countKv(resolved.namespace, { prefix: effectivePrefix });
      return {
        content: [
          {
            type: "text",
            text:
              entries.length === 0
                ? `No entries in "${resolved.namespace}".`
                : `Found ${entries.length} of ${total} entries in "${resolved.namespace}".`,
          },
        ],
        structuredContent: {
          yourAgentId: requestInfo.agentId,
          success: true,
          message: "ok",
          namespace: resolved.namespace,
          entries,
          total,
        },
      };
    },
  );
};
