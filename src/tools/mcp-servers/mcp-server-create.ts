import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { createMcpServer, getAgentById, installMcpServer } from "@/be/db";
import { createToolRegistrar } from "@/tools/utils";

export const registerMcpServerCreateTool = (server: McpServer) => {
  createToolRegistrar(server)(
    "mcp-server-create",
    {
      title: "Create MCP Server",
      annotations: { destructiveHint: false },
      description:
        "Create a new MCP server definition. Agent-scope servers are auto-installed for the creating agent. Swarm/global scope requires lead.",
      inputSchema: z.object({
        name: z.string().describe("Server name"),
        description: z.string().optional().describe("Server description"),
        transport: z.enum(["stdio", "http", "sse"]).describe("Transport type"),
        scope: z
          .enum(["global", "swarm", "agent"])
          .default("agent")
          .optional()
          .describe("Scope: agent (personal), swarm (shared), or global. Default: agent"),
        command: z.string().optional().describe("Command to run (required for stdio transport)"),
        args: z.string().optional().describe("JSON array of command arguments (stdio only)"),
        url: z.string().optional().describe("Server URL (required for http/sse transport)"),
        headers: z
          .string()
          .optional()
          .describe("JSON object of non-secret headers (http/sse only)"),
        envConfigKeys: z
          .string()
          .optional()
          .describe("JSON object mapping env var names to config key paths"),
        headerConfigKeys: z
          .string()
          .optional()
          .describe("JSON object mapping header names to config key paths for secret headers"),
      }),
      outputSchema: z.object({
        yourAgentId: z.string().uuid().optional(),
        success: z.boolean(),
        message: z.string(),
        server: z.any().optional(),
      }),
    },
    async (args, requestInfo, _meta) => {
      if (!requestInfo.agentId) {
        return {
          content: [{ type: "text", text: "Agent ID not found." }],
          structuredContent: { success: false, message: "Agent ID not found." },
        };
      }

      try {
        // Validate transport-specific fields
        if (args.transport === "stdio" && !args.command) {
          return {
            content: [{ type: "text", text: "stdio transport requires a command." }],
            structuredContent: {
              yourAgentId: requestInfo.agentId,
              success: false,
              message: "stdio transport requires a command.",
            },
          };
        }

        if ((args.transport === "http" || args.transport === "sse") && !args.url) {
          return {
            content: [{ type: "text", text: `${args.transport} transport requires a url.` }],
            structuredContent: {
              yourAgentId: requestInfo.agentId,
              success: false,
              message: `${args.transport} transport requires a url.`,
            },
          };
        }

        // Swarm/global scope requires lead
        const scope = args.scope ?? "agent";
        if (scope === "swarm" || scope === "global") {
          const agent = getAgentById(requestInfo.agentId);
          if (!agent?.isLead) {
            return {
              content: [
                {
                  type: "text",
                  text: `Only lead agents can create ${scope}-scope MCP servers.`,
                },
              ],
              structuredContent: {
                yourAgentId: requestInfo.agentId,
                success: false,
                message: `Only lead agents can create ${scope}-scope MCP servers.`,
              },
            };
          }
        }

        const created = createMcpServer({
          name: args.name,
          description: args.description,
          transport: args.transport,
          scope,
          ownerAgentId: requestInfo.agentId,
          command: args.command,
          args: args.args,
          url: args.url,
          headers: args.headers,
          envConfigKeys: args.envConfigKeys,
          headerConfigKeys: args.headerConfigKeys,
        });

        // Auto-install for the creating agent
        installMcpServer(requestInfo.agentId, created.id);

        return {
          content: [{ type: "text", text: `Created MCP server "${created.name}" (${created.id})` }],
          structuredContent: {
            yourAgentId: requestInfo.agentId,
            success: true,
            message: `Created and installed MCP server "${created.name}".`,
            server: created,
          },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error";
        return {
          content: [{ type: "text", text: `Failed to create MCP server: ${message}` }],
          structuredContent: {
            yourAgentId: requestInfo.agentId,
            success: false,
            message: `Failed: ${message}`,
          },
        };
      }
    },
  );
};
