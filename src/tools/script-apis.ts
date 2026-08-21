import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { getAgentById } from "@/be/db";
import { can, type PermissionVerb } from "@/rbac";
import type { RequestInfo, SwarmToolResult } from "@/tools/utils";
import { createToolRegistrar, toolErr, toolOk } from "@/tools/utils";
import type { ScriptApiRecord, ScriptApiWithSecret } from "@/types";
import { registerVolatileSecret } from "@/utils/secret-scrubber";
import { proxyScriptsApi, SCRIPT_TRANSPORT_ERROR, scriptToolOutputSchema } from "./script-common";

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

function renderEndpointsList(endpoints: RawEndpoint[]): string | undefined {
  if (endpoints.length === 0) return undefined;
  return endpoints
    .map((endpoint) => {
      const label = endpoint.label ? ` "${endpoint.label}"` : "";
      const token = endpoint.token ? `, token=${endpoint.token}` : "";
      return `- ${endpoint.id}${label}: authMode=${endpoint.authMode}, enabled=${endpoint.enabled}${token}`;
    })
    .join("\n");
}

async function requireScriptApiPermission(
  requestInfo: RequestInfo,
  verb: PermissionVerb,
  message: string,
): Promise<SwarmToolResult | null> {
  if (!requestInfo.agentId) return toolErr(SCRIPT_TRANSPORT_ERROR);

  const agent = await getAgentById(requestInfo.agentId);
  const decision = can({
    principal: {
      kind: "agent",
      agentId: requestInfo.agentId,
      isLead: agent?.isLead ?? false,
    },
    verb,
    resource: { kind: "none" },
    source: "mcp",
  });
  return decision.allow ? null : toolErr(message, { data: { status: 403 } });
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
        if (!result.ok) return result;
        const raw = (result.data as { data?: { apis?: RawEndpoint[] } } | undefined)?.data;
        let endpoints = (raw?.apis ?? []).map(maskToken);

        if (args.includeSecrets) {
          const denied = await requireScriptApiPermission(
            requestInfo,
            "script.api.read.secrets",
            "Only lead agents can reveal script API bearer tokens.",
          );
          if (denied) return denied;

          endpoints = await Promise.all(
            endpoints.map(async (endpoint) => {
              if (endpoint.authMode !== "bearer") return endpoint;
              const secretResult = await proxyScriptsApi({
                method: "GET",
                path: `/api/scripts/${args.scriptId}/apis/${endpoint.id}/secret`,
                requestInfo,
                successMessage: () => "",
              });
              if (!secretResult.ok) return endpoint;
              const token = (secretResult.data as { data?: { token?: string | null } } | undefined)
                ?.data?.token;
              if (token) registerVolatileSecret(token, `script-api:${endpoint.id}`);
              return { ...endpoint, token: token ?? null };
            }),
          );
        }

        return toolOk(`Found ${endpoints.length} endpoint(s).`, {
          details: renderEndpointsList(endpoints),
          data: { status: 200, data: { apis: endpoints } },
          // Deliberate reveal path — includeSecrets returns real bearer tokens.
          allowSecretEgress: args.includeSecrets === true,
        });
      }

      if (args.action === "create") {
        const denied = await requireScriptApiPermission(
          requestInfo,
          "script.api.create",
          "Only lead agents can create script API endpoints.",
        );
        if (denied) return denied;

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
          successDetails: (data) => {
            const token = (data as ScriptApiWithSecret).token;
            return token ? `Bearer token (shown once — save it now): ${token}` : undefined;
          },
        });
        if (result.ok) {
          const endpoint = (result.data as { data?: ScriptApiWithSecret } | undefined)?.data;
          if (endpoint?.token) registerVolatileSecret(endpoint.token, `script-api:${endpoint.id}`);
          // Deliberate one-time reveal — the volatile secret registered above
          // would otherwise be redacted by the finalize scrubber.
          return { ...result, allowSecretEgress: true };
        }
        return result;
      }

      if (args.action === "rotate") {
        if (!args.endpointId) return toolErr("endpointId is required for rotate.");
        const denied = await requireScriptApiPermission(
          requestInfo,
          "script.api.rotate",
          "Only lead agents can rotate script API bearer tokens.",
        );
        if (denied) return denied;

        const result = await proxyScriptsApi({
          method: "POST",
          path: `/api/scripts/${args.scriptId}/apis/${args.endpointId}/rotate`,
          requestInfo,
          successMessage: () => "Token rotated.",
          successDetails: (data) => {
            const token = (data as ScriptApiWithSecret).token;
            return token ? `New bearer token (shown once — save it now): ${token}` : undefined;
          },
        });
        if (result.ok) {
          const endpoint = (result.data as { data?: ScriptApiWithSecret } | undefined)?.data;
          if (endpoint?.token) registerVolatileSecret(endpoint.token, `script-api:${endpoint.id}`);
          // Deliberate one-time reveal — the volatile secret registered above
          // would otherwise be redacted by the finalize scrubber.
          return { ...result, allowSecretEgress: true };
        }
        return result;
      }

      if (args.action === "update") {
        if (!args.endpointId) return toolErr("endpointId is required for update.");
        const denied = await requireScriptApiPermission(
          requestInfo,
          "script.api.update",
          "Only lead agents can update script API endpoints.",
        );
        if (denied) return denied;

        return proxyScriptsApi({
          method: "PATCH",
          path: `/api/scripts/${args.scriptId}/apis/${args.endpointId}`,
          body: { enabled: args.enabled, label: args.label },
          requestInfo,
          successMessage: () => "Endpoint updated.",
        });
      }

      if (args.action === "delete") {
        if (!args.endpointId) return toolErr("endpointId is required for delete.");
        const denied = await requireScriptApiPermission(
          requestInfo,
          "script.api.delete",
          "Only lead agents can delete script API endpoints.",
        );
        if (denied) return denied;

        return proxyScriptsApi({
          method: "DELETE",
          path: `/api/scripts/${args.scriptId}/apis/${args.endpointId}`,
          requestInfo,
          successMessage: () => "Endpoint deleted.",
        });
      }

      return toolErr(`Unknown action: ${args.action}`);
    },
  );
};
