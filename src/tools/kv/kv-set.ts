import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { upsertKv } from "@/be/db";
import { createToolRegistrar, swarmToolOutputSchema, toolErr, toolOk } from "@/tools/utils";
import { KvKeySchema, KvNamespaceSchema, KvValueTypeSchema } from "@/types";
import { kvWriteAuthError } from "./kv-write-auth";
import { resolveNamespace } from "./resolve-namespace";

// 2 MiB cap — mirrors the HTTP enforcement.
const MAX_KV_BODY_BYTES = 2 * 1024 * 1024;

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

export const registerKvSetTool = (server: McpServer) => {
  createToolRegistrar(server)(
    "kv-set",
    {
      title: "KV Set",
      description:
        "Write a key in the swarm KV store. Each replacement is atomic but unconditional: there is no compare-and-swap, so concurrent read-modify-write callers can lose updates. Namespace defaults to your current context. Use `expiresInSec` for opt-in TTL (default: never expires). 2 MiB body cap.",
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
      outputSchema: swarmToolOutputSchema({
        yourAgentId: z.string().optional(),
        namespace: z.string().optional(),
        entry: kvEntryOutputSchema.optional(),
      }),
    },
    async ({ key, value, valueType, expiresInSec, namespace }, requestInfo) => {
      const resolved = await resolveNamespace(namespace, requestInfo);
      if ("error" in resolved) {
        return toolErr(resolved.error, { data: { yourAgentId: requestInfo.agentId } });
      }

      const authErr = await kvWriteAuthError(resolved.namespace, { agentId: requestInfo.agentId });
      if (authErr) {
        return toolErr(authErr, {
          data: { yourAgentId: requestInfo.agentId, namespace: resolved.namespace },
        });
      }

      const finalValueType = valueType ?? "json";
      // Pre-flight encode to surface validation errors as a structured tool
      // response (rather than letting `upsertKv` throw).
      let encodedSize: number;
      try {
        if (finalValueType === "json") {
          const stringified = JSON.stringify(value);
          if (stringified === undefined) {
            return toolErr("value is not JSON-encodable", {
              data: { yourAgentId: requestInfo.agentId, namespace: resolved.namespace },
            });
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
        return toolErr(msg, {
          data: { yourAgentId: requestInfo.agentId, namespace: resolved.namespace },
        });
      }

      if (encodedSize > MAX_KV_BODY_BYTES) {
        return toolErr(`Payload too large (max ${MAX_KV_BODY_BYTES} bytes)`, {
          data: { yourAgentId: requestInfo.agentId, namespace: resolved.namespace },
        });
      }

      const expiresAt = expiresInSec !== undefined ? Date.now() + expiresInSec * 1000 : null;

      try {
        const entry = await upsertKv({
          namespace: resolved.namespace,
          key,
          value,
          valueType: finalValueType,
          expiresAt,
        });
        return toolOk(`Set "${key}" in "${resolved.namespace}".`, {
          data: { yourAgentId: requestInfo.agentId, namespace: resolved.namespace, entry },
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : "upsert failed";
        return toolErr(msg, {
          data: { yourAgentId: requestInfo.agentId, namespace: resolved.namespace },
        });
      }
    },
  );
};
