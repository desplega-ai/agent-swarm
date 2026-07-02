import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { getAgentMcpServers, listMcpServers } from "@/be/db";
import { createToolRegistrar } from "@/tools/utils";

export const registerMcpServerListTool = (server: McpServer) => {
  createToolRegistrar(server)(
    "mcp-server-list",
    {
      title: "List MCP Servers",
      annotations: { destructiveHint: false },
      description:
        "List MCP servers with optional filters. Use installedOnly to see servers installed for the calling agent.",
      inputSchema: z.object({
        scope: z.enum(["global", "swarm", "agent"]).optional().describe("Filter by scope"),
        transport: z.enum(["stdio", "http", "sse"]).optional().describe("Filter by transport type"),
        search: z.string().optional().describe("Search by name or description"),
        installedOnly: z
          .boolean()
          .optional()
          .describe("Only show servers installed for the calling agent"),
      }),
      outputSchema: z.object({
        yourAgentId: z.string().uuid().optional(),
        success: z.boolean(),
        message: z.string(),
        servers: z.array(z.any()),
        total: z.number(),
      }),
    },
    async (args, requestInfo, _meta) => {
      try {
        const servers =
          args.installedOnly && requestInfo.agentId
            ? getAgentMcpServers(requestInfo.agentId)
            : listMcpServers({
                scope: args.scope,
                transport: args.transport,
                search: args.search,
              });

        return {
          content: [{ type: "text", text: `Found ${servers.length} MCP server(s).` }],
          structuredContent: {
            yourAgentId: requestInfo.agentId,
            success: true,
            message: `Found ${servers.length} MCP server(s).`,
            servers,
            total: servers.length,
          },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error";
        return {
          content: [{ type: "text", text: `Failed: ${message}` }],
          structuredContent: {
            yourAgentId: requestInfo.agentId,
            success: false,
            message: `Failed: ${message}`,
            servers: [],
            total: 0,
          },
        };
      }
    },
  );
};
