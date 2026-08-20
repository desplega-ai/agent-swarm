import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { getAgentById, uninstallMcpServer } from "@/be/db";
import { can } from "@/rbac";
import { createToolRegistrar, swarmToolOutputSchema, toolErr, toolOk } from "@/tools/utils";

export const registerMcpServerUninstallTool = (server: McpServer) => {
  createToolRegistrar(server)(
    "mcp-server-uninstall",
    {
      title: "Uninstall MCP Server",
      annotations: { destructiveHint: true },
      description:
        "Uninstall an MCP server from an agent. Self-uninstall is always allowed; cross-agent requires lead.",
      inputSchema: z.object({
        mcpServerId: z.string().describe("ID of the MCP server to uninstall"),
        agentId: z.string().optional().describe("Target agent (default: calling agent)"),
      }),
      outputSchema: swarmToolOutputSchema({
        yourAgentId: z.string().optional(),
      }),
    },
    async (args, requestInfo, _meta) => {
      if (!requestInfo.agentId) {
        return toolErr("Agent ID not found.");
      }

      const targetAgentId = args.agentId ?? requestInfo.agentId;

      if (targetAgentId !== requestInfo.agentId) {
        const agent = await getAgentById(requestInfo.agentId);
        const decision = can({
          principal: {
            kind: "agent",
            agentId: requestInfo.agentId,
            isLead: agent?.isLead ?? false,
          },
          verb: "mcp-server.uninstall.any",
          resource: { kind: "agent", agentId: targetAgentId },
          source: "mcp",
        });
        if (!decision.allow) {
          return toolErr("Only leads can uninstall MCP servers for other agents.", {
            data: { yourAgentId: requestInfo.agentId },
          });
        }
      }

      const removed = await uninstallMcpServer(targetAgentId, args.mcpServerId);
      const data = { yourAgentId: requestInfo.agentId };
      return removed
        ? toolOk("MCP server uninstalled.", { data })
        : toolErr("MCP server was not installed for this agent.", { data });
    },
  );
};
