import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { getAgentById, getMcpServerById, installMcpServer } from "@/be/db";
import { can } from "@/rbac";
import { createToolRegistrar, swarmToolOutputSchema, toolErr, toolOk } from "@/tools/utils";

export const registerMcpServerInstallTool = (server: McpServer) => {
  createToolRegistrar(server)(
    "mcp-server-install",
    {
      title: "Install MCP Server",
      annotations: { destructiveHint: false },
      description:
        "Install an MCP server for an agent. Self-install is always allowed; cross-agent install requires lead.",
      inputSchema: z.object({
        mcpServerId: z.string().describe("ID of the MCP server to install"),
        agentId: z
          .string()
          .optional()
          .describe("Target agent (default: calling agent). Lead can install for others."),
      }),
      outputSchema: swarmToolOutputSchema({
        yourAgentId: z.string().optional(),
        installation: z.looseObject({}).optional(),
      }),
    },
    async (args, requestInfo, _meta) => {
      if (!requestInfo.agentId) {
        return toolErr("Agent ID not found.");
      }

      const targetAgentId = args.agentId ?? requestInfo.agentId;

      // Cross-agent install requires lead
      if (targetAgentId !== requestInfo.agentId) {
        const agent = getAgentById(requestInfo.agentId);
        const decision = can({
          principal: {
            kind: "agent",
            agentId: requestInfo.agentId,
            isLead: agent?.isLead ?? false,
          },
          verb: "mcp-server.install.any",
          resource: { kind: "agent", agentId: targetAgentId },
          source: "mcp",
        });
        if (!decision.allow) {
          return toolErr("Only leads can install MCP servers for other agents.", {
            data: { yourAgentId: requestInfo.agentId },
          });
        }
      }

      const mcpServer = getMcpServerById(args.mcpServerId);
      if (!mcpServer) {
        return toolErr("MCP server not found.", { data: { yourAgentId: requestInfo.agentId } });
      }

      if (!mcpServer.isEnabled) {
        return toolErr("MCP server is disabled.", { data: { yourAgentId: requestInfo.agentId } });
      }

      try {
        const installation = installMcpServer(targetAgentId, args.mcpServerId);
        return toolOk(`Installed MCP server "${mcpServer.name}" for agent ${targetAgentId}.`, {
          data: { yourAgentId: requestInfo.agentId, installation },
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error";
        return toolErr(`Failed: ${message}`, { data: { yourAgentId: requestInfo.agentId } });
      }
    },
  );
};
