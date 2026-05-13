import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { getAgentById, upsertKv } from "@/be/db";
import { createToolRegistrar } from "@/tools/utils";
import { KvEntrySchema, KvKeySchema, KvNamespaceSchema, KvValueTypeSchema } from "@/types";
import { resolveNamespace } from "./resolve-namespace";

// 2 MiB cap — mirrors the HTTP enforcement.
const MAX_KV_BODY_BYTES = 2 * 1024 * 1024;

function authError(namespace: string, info: { agentId: string | undefined }): string | null {
  if (namespace.startsWith("task:page:")) {
    // MCP requests don't carry an X-Page-Id; page writes must go through the
    // browser SDK + page proxy.
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

export const registerKvSetTool = (server: McpServer) => {
  createToolRegistrar(server)(
    "kv-set",
    {
      title: "KV Set",
      description:
        "Write a key in the swarm KV store. Upserts atomically. Namespace defaults to your current context. Use `expiresInSec` for opt-in TTL (default: never expires). 2 MiB body cap.",
      annotations: { idempotentHint: true },

      inputSchema: z.object({
        key: KvKeySchema.describe("KV key (≤512 chars, [a-zA-Z0-9._:/-])."),
        value: z
          .unknown()
          .describe(
            "Value. Stored as JSON by default; pass `valueType: 'string'` or `'integer'` to skip JSON wrapping.",
          ),
        valueType: KvValueTypeSchema.optional().describe(
          "How to encode `value`. Defaults to 'json'. 'integer' is required for INCR.",
        ),
        expiresInSec: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Optional TTL in seconds. Omit for no expiry."),
        namespace: KvNamespaceSchema.optional().describe(
          "Optional explicit namespace. Defaults to the caller's contextKey.",
        ),
      }),
      outputSchema: z.object({
        yourAgentId: z.string().uuid().optional(),
        success: z.boolean(),
        message: z.string(),
        namespace: z.string().optional(),
        entry: KvEntrySchema.optional(),
      }),
    },
    async ({ key, value, valueType, expiresInSec, namespace }, requestInfo) => {
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

      const finalValueType = valueType ?? "json";
      // Pre-flight encode to surface validation errors as a structured tool
      // response (rather than letting `upsertKv` throw).
      let encodedSize: number;
      try {
        if (finalValueType === "json") {
          const stringified = JSON.stringify(value);
          if (stringified === undefined) {
            const msg = "value is not JSON-encodable";
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
          encodedSize = Buffer.byteLength(stringified, "utf8");
        } else if (finalValueType === "integer") {
          if (typeof value === "number") {
            if (!Number.isInteger(value) || !Number.isSafeInteger(value)) {
              throw new Error("integer value must be a JS-safe integer");
            }
            encodedSize = String(value).length;
          } else if (typeof value === "string" && /^-?\d+$/.test(value)) {
            encodedSize = value.length;
          } else {
            throw new Error("integer value must be a JS-safe integer");
          }
        } else {
          if (typeof value !== "string") {
            throw new Error("string value must be a string");
          }
          encodedSize = Buffer.byteLength(value, "utf8");
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : "encoding error";
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

      if (encodedSize > MAX_KV_BODY_BYTES) {
        const msg = `Payload too large (max ${MAX_KV_BODY_BYTES} bytes)`;
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

      const expiresAt = expiresInSec !== undefined ? Date.now() + expiresInSec * 1000 : null;

      try {
        const entry = upsertKv({
          namespace: resolved.namespace,
          key,
          value,
          valueType: finalValueType,
          expiresAt,
        });
        return {
          content: [
            {
              type: "text",
              text: `Set "${key}" in "${resolved.namespace}".`,
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
        const msg = err instanceof Error ? err.message : "upsert failed";
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
