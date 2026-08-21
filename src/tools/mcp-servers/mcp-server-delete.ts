import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { deleteMcpServer, getAgentById, getMcpServerById } from "@/be/db";
import { can } from "@/rbac";
import { createToolRegistrar, swarmToolOutputSchema, toolErr, toolOk } from "@/tools/utils";

export const registerMcpServerDeleteTool = (server: McpServer) => {
  createToolRegistrar(server)(
    "mcp-server-delete",
    {
      title: "Delete MCP Server",
      annotations: { destructiveHint: true },
      description: "Delete an MCP server definition. Only the owning agent or lead can delete.",
      inputSchema: z.object({
        id: z.string().describe("ID of the MCP server to delete"),
      }),
      outputSchema: swarmToolOutputSchema({
        yourAgentId: z.string().optional(),
      }),
    },
    async (args, requestInfo, _meta) => {
      if (!requestInfo.agentId) {
        return toolErr("Agent ID not found.");
      }

      const existing = await getMcpServerById(args.id);
      if (!existing) {
        return toolErr("MCP server not found.", { data: { yourAgentId: requestInfo.agentId } });
      }

      const agent = await getAgentById(requestInfo.agentId);
      const decision = can({
        principal: {
          kind: "agent",
          agentId: requestInfo.agentId,
          isLead: agent?.isLead ?? false,
        },
        verb: "mcp-server.delete.any",
        resource: { kind: "owned", ownerAgentId: existing.ownerAgentId },
        source: "mcp",
      });
      if (!decision.allow) {
        return toolErr("Only the owning agent or lead can delete this MCP server.", {
          data: { yourAgentId: requestInfo.agentId },
        });
      }

      const result = await deleteMcpServer(args.id);
      const message = result.deleted
        ? `Deleted MCP server "${existing.name}" and ${result.deletedScriptConnectionCount} script connection(s).`
        : "Delete failed.";
      const data = { yourAgentId: requestInfo.agentId };
      return result.deleted ? toolOk(message, { data }) : toolErr(message, { data });
    },
  );
};
