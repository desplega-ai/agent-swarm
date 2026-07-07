import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { deleteSwarmConfig, getAgentById, getSwarmConfigLookupById } from "@/be/db";
import { scheduleIntegrationsReload } from "@/http/core";
import { can } from "@/rbac";
import { createToolRegistrar } from "@/tools/utils";

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
      outputSchema: z.object({
        yourAgentId: z.string().uuid().optional(),
        success: z.boolean(),
        message: z.string(),
      }),
    },
    async ({ id }, requestInfo) => {
      if (!requestInfo.agentId) {
        return {
          content: [{ type: "text", text: 'Agent ID not found. Set the "X-Agent-ID" header.' }],
          structuredContent: {
            success: false,
            message: 'Agent ID not found. Set the "X-Agent-ID" header.',
          },
        };
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
        const message = "Deleting swarm config requires the lead agent.";
        return {
          content: [{ type: "text", text: message }],
          structuredContent: {
            yourAgentId: requestInfo.agentId,
            success: false,
            message,
          },
        };
      }

      try {
        // Check if config exists first for a better error message
        const existing = getSwarmConfigLookupById(id);
        if (!existing) {
          return {
            content: [{ type: "text", text: `Config entry "${id}" not found.` }],
            structuredContent: {
              yourAgentId: requestInfo.agentId,
              success: false,
              message: `Config entry "${id}" not found.`,
            },
          };
        }

        const deleted = deleteSwarmConfig(id);
        if (!deleted) {
          return {
            content: [{ type: "text", text: `Failed to delete config entry "${id}".` }],
            structuredContent: {
              yourAgentId: requestInfo.agentId,
              success: false,
              message: `Failed to delete config entry "${id}".`,
            },
          };
        }

        if (existing.scope === "global") {
          scheduleIntegrationsReload();
        }

        return {
          content: [
            {
              type: "text",
              text: `Config "${existing.key}" (scope: ${existing.scope}${existing.scopeId ? `, scopeId: ${existing.scopeId}` : ""}) deleted successfully.`,
            },
          ],
          structuredContent: {
            yourAgentId: requestInfo.agentId,
            success: true,
            message: `Config "${existing.key}" deleted successfully.`,
          },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error";
        return {
          content: [{ type: "text", text: `Failed to delete config: ${message}` }],
          structuredContent: {
            yourAgentId: requestInfo.agentId,
            success: false,
            message: `Failed to delete config: ${message}`,
          },
        };
      }
    },
  );
};
