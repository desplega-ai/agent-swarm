import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { deleteSwarmConfig, getAgentById, getSwarmConfigLookupById } from "@/be/db";
import { scheduleIntegrationsReload } from "@/http/core";
import { can } from "@/rbac";
import { createToolRegistrar, swarmToolOutputSchema, toolErr, toolOk } from "@/tools/utils";

export const registerDeleteConfigTool = (server: McpServer) => {
  createToolRegistrar(server)(
    "delete-config",
    {
      title: "Delete Config",
      description:
        "Delete a swarm configuration entry by its ID. Use list-config to find config IDs first.",
      annotations: { destructiveHint: true },

      inputSchema: z.object({
        id: z.string().uuid().describe("The config entry ID to delete."),
      }),
      outputSchema: swarmToolOutputSchema({
        yourAgentId: z.string().optional(),
      }),
    },
    async ({ id }, requestInfo) => {
      if (!requestInfo.agentId) {
        return toolErr('Agent ID not found. Set the "X-Agent-ID" header.');
      }

      // Deleting any config entry is lead-gated (DES-445 follow-up): a delete
      // previously had NO gate, letting any agent remove any entry (including
      // SCRIPT_CREDENTIAL_BINDINGS, routing around the set-config write gate).
      const agent = getAgentById(requestInfo.agentId);
      const decision = can({
        principal: {
          kind: "agent",
          agentId: requestInfo.agentId,
          isLead: agent?.isLead ?? false,
        },
        verb: "config.delete.any",
        resource: { kind: "none" },
        source: "mcp",
      });
      if (!decision.allow) {
        return toolErr("Deleting swarm config requires the lead agent.", {
          data: { yourAgentId: requestInfo.agentId },
        });
      }

      try {
        // Check if config exists first for a better error message
        const existing = getSwarmConfigLookupById(id);
        if (!existing) {
          return toolErr(`Config entry "${id}" not found.`, {
            data: { yourAgentId: requestInfo.agentId },
          });
        }

        const deleted = deleteSwarmConfig(id);
        if (!deleted) {
          return toolErr(`Failed to delete config entry "${id}".`, {
            data: { yourAgentId: requestInfo.agentId },
          });
        }

        if (existing.scope === "global") {
          scheduleIntegrationsReload();
        }

        return toolOk(`Config "${existing.key}" deleted successfully.`, {
          details: `Config "${existing.key}" (scope: ${existing.scope}${existing.scopeId ? `, scopeId: ${existing.scopeId}` : ""}) deleted successfully.`,
          data: { yourAgentId: requestInfo.agentId },
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error";
        return toolErr(`Failed to delete config: ${message}`, {
          data: { yourAgentId: requestInfo.agentId },
        });
      }
    },
  );
};
