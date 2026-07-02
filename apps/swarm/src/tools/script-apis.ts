import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import * as z from "zod";
import { createToolRegistrar } from "@/tools/utils";
import type { ScriptApiRecord, ScriptApiWithSecret } from "@/types";
import { registerVolatileSecret } from "@/utils/secret-scrubber";
import { proxyScriptsApi, scriptToolOutputSchema } from "./script-common";

const scriptApisInputSchema = z.object({
  action: z
    .enum(["list", "create", "update", "rotate", "delete"])
    .describe(
      "list: endpoints for a script, tokens masked unless includeSecrets=true. create: expose the script as a new endpoint (returns the plaintext token once). update: enable/disable or relabel an endpoint. rotate: issue a new token (returns it once). delete: remove an endpoint.",
    ),
  scriptId: z.string().uuid().describe("The script the endpoint(s) belong to."),
  endpointId: z.string().optional().describe("Required for update, rotate, and delete."),
  authMode: z
    .enum(["none", "bearer"])
    .optional()
    .describe("For create: 'bearer' (default, auto-generated token) or 'none' (no auth)."),
  label: z.string().max(200).nullable().optional().describe("For create/update."),
  agentId: z
    .string()
    .optional()
    .describe(
      "For create: the agent the endpoint runs as (its egress secrets + API connections apply). Defaults to the script's owning agent; required if the script has none.",
    ),
  enabled: z.boolean().optional().describe("For update: enable or disable the endpoint."),
  includeSecrets: z
    .boolean()
    .optional()
    .describe(
      "For list only: reveal real bearer tokens (default: false — tokens come back masked as '********', mirroring get-config's includeSecrets).",
    ),
});

type RawEndpoint = ScriptApiRecord & { token?: string | null };

function maskToken(endpoint: RawEndpoint): RawEndpoint {
  const { token: _drop, ...rest } = endpoint;
  return { ...rest, token: endpoint.authMode === "bearer" ? "********" : null };
}

function errorResult(message: string): CallToolResult {
  return {
    isError: true,
    content: [{ type: "text", text: message }],
    structuredContent: { success: false, status: 400, error: message },
  };
}

export const registerScriptApisTool = (server: McpServer) => {
  createToolRegistrar(server)(
    "script-apis",
    {
      title: "Script APIs",
      description:
        "Manage external HTTP API endpoints for swarm scripts (POST /api/x/script/<id>). list/create/update/rotate/delete. Bearer tokens are masked ('********') on list unless includeSecrets=true; create and rotate always return the fresh plaintext token once — the only time it's visible without an explicit reveal.",
      annotations: { idempotentHint: true },
      inputSchema: scriptApisInputSchema,
      outputSchema: scriptToolOutputSchema,
    },
    async (args, requestInfo) => {
      if (args.action === "list") {
        const result = await proxyScriptsApi({
          method: "GET",
          path: `/api/scripts/${args.scriptId}/apis`,
          requestInfo,
          successMessage: () => "",
        });
        if (result.isError) return result;
        const raw = (result.structuredContent as { data?: { apis?: RawEndpoint[] } })?.data;
        let endpoints = (raw?.apis ?? []).map(maskToken);

        if (args.includeSecrets) {
          endpoints = await Promise.all(
            endpoints.map(async (endpoint) => {
              if (endpoint.authMode !== "bearer") return endpoint;
              const secretResult = await proxyScriptsApi({
                method: "GET",
                path: `/api/scripts/${args.scriptId}/apis/${endpoint.id}/secret`,
                requestInfo,
                successMessage: () => "",
              });
              if (secretResult.isError) return endpoint;
              const token = (secretResult.structuredContent as { data?: { token?: string | null } })
                ?.data?.token;
              if (token) registerVolatileSecret(token, `script-api:${endpoint.id}`);
              return { ...endpoint, token: token ?? null };
            }),
          );
        }

        return {
          content: [{ type: "text", text: `Found ${endpoints.length} endpoint(s).` }],
          structuredContent: { success: true, status: 200, data: { apis: endpoints } },
        };
      }

      if (args.action === "create") {
        const result = await proxyScriptsApi({
          method: "POST",
          path: `/api/scripts/${args.scriptId}/apis`,
          body: {
            authMode: args.authMode ?? "bearer",
            label: args.label ?? undefined,
            agentId: args.agentId,
          },
          requestInfo,
          successMessage: (data) => `Endpoint ${(data as ScriptApiWithSecret).id} created.`,
        });
        if (!result.isError) {
          const endpoint = (result.structuredContent as { data?: ScriptApiWithSecret })?.data;
          if (endpoint?.token) registerVolatileSecret(endpoint.token, `script-api:${endpoint.id}`);
        }
        return result;
      }

      if (args.action === "rotate") {
        if (!args.endpointId) return errorResult("endpointId is required for rotate.");
        const result = await proxyScriptsApi({
          method: "POST",
          path: `/api/scripts/${args.scriptId}/apis/${args.endpointId}/rotate`,
          requestInfo,
          successMessage: () => "Token rotated.",
        });
        if (!result.isError) {
          const endpoint = (result.structuredContent as { data?: ScriptApiWithSecret })?.data;
          if (endpoint?.token) registerVolatileSecret(endpoint.token, `script-api:${endpoint.id}`);
        }
        return result;
      }

      if (args.action === "update") {
        if (!args.endpointId) return errorResult("endpointId is required for update.");
        return proxyScriptsApi({
          method: "PATCH",
          path: `/api/scripts/${args.scriptId}/apis/${args.endpointId}`,
          body: { enabled: args.enabled, label: args.label },
          requestInfo,
          successMessage: () => "Endpoint updated.",
        });
      }

      if (args.action === "delete") {
        if (!args.endpointId) return errorResult("endpointId is required for delete.");
        return proxyScriptsApi({
          method: "DELETE",
          path: `/api/scripts/${args.scriptId}/apis/${args.endpointId}`,
          requestInfo,
          successMessage: () => "Endpoint deleted.",
        });
      }

      return errorResult(`Unknown action: ${args.action}`);
    },
  );
};
