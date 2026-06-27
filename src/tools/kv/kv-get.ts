import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createToolRegistrar } from "@swarm/mcp-tool";
import { getKv } from "@swarm/storage";
import { KvEntrySchema, KvKeySchema, KvNamespaceSchema } from "@swarm/types";
import * as z from "zod";
import { resolveNamespace } from "./resolve-namespace";

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
      outputSchema: z.object({
        yourAgentId: z.string().uuid().optional(),
        success: z.boolean(),
        message: z.string(),
        namespace: z.string().optional(),
        entry: KvEntrySchema.nullable().optional(),
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

      const entry = getKv(resolved.namespace, key);
      return {
        content: [
          {
            type: "text",
            text: entry
              ? `Found "${key}" in "${resolved.namespace}".`
              : `No entry for "${key}" in "${resolved.namespace}".`,
          },
        ],
        structuredContent: {
          yourAgentId: requestInfo.agentId,
          success: true,
          message: entry ? "ok" : "not found",
          namespace: resolved.namespace,
          entry: entry ?? null,
        },
      };
    },
  );
};
