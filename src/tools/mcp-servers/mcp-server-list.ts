import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { getAgentMcpServers, listMcpServers } from "@/be/db";
import { createToolRegistrar, swarmToolOutputSchema, toolErr, toolOk } from "@/tools/utils";

function renderServerLines(servers: unknown[]): string | undefined {
  if (servers.length === 0) return undefined;
  return servers
    .map((entry) => {
      const s = entry as {
        name?: unknown;
        transport?: unknown;
        isEnabled?: unknown;
        status?: unknown;
      };
      const enabled = s.isEnabled === false ? "disabled" : "enabled";
      const status = typeof s.status === "string" && s.status ? `, status=${s.status}` : "";
      return `- ${String(s.name ?? "?")} (${String(s.transport ?? "?")}, ${enabled}${status})`;
    })
    .join("\n");
}

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
      outputSchema: swarmToolOutputSchema({
        yourAgentId: z.string().optional(),
        servers: z.array(z.looseObject({})).optional(),
        total: z.number().optional(),
      }),
    },
    async (args, requestInfo, _meta) => {
      try {
        const servers =
          args.installedOnly && requestInfo.agentId
            ? await getAgentMcpServers(requestInfo.agentId)
            : await listMcpServers({
                scope: args.scope,
                transport: args.transport,
                search: args.search,
              });

        return toolOk(`Found ${servers.length} MCP server(s).`, {
          details: renderServerLines(servers),
          data: { yourAgentId: requestInfo.agentId, servers, total: servers.length },
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error";
        return toolErr(`Failed: ${message}`, {
          data: { yourAgentId: requestInfo.agentId, servers: [], total: 0 },
        });
      }
    },
  );
};
