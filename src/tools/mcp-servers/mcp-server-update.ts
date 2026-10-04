import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { getAgentById, type updateMcpServer } from "@/be/db";
import { updateMcpServerChecked } from "@/be/mcp-server-checked-update";
import { updateTouchesStdioExecution } from "@/be/mcp-server-stdio-gate";
import { can } from "@/rbac";
import { createToolRegistrar, swarmToolOutputSchema, toolErr, toolOk } from "@/tools/utils";

export const registerMcpServerUpdateTool = (server: McpServer) => {
  createToolRegistrar(server)(
    "mcp-server-update",
    {
      title: "Update MCP Server",
      annotations: { destructiveHint: false },
      description:
        "Update an MCP server's configuration. Only the owner or lead can update. Changing or enabling what a stdio server runs requires lead.",
      inputSchema: z.object({
        id: z.string().describe("ID of the MCP server to update"),
        name: z.string().optional().describe("New name"),
        description: z.string().optional().describe("New description"),
        transport: z.enum(["stdio", "http", "sse"]).optional().describe("New transport type"),
        command: z.string().optional().describe("New command (stdio)"),
        args: z.string().optional().describe("New JSON array of arguments (stdio)"),
        url: z.string().optional().describe("New URL (http/sse)"),
        headers: z.string().optional().describe("New JSON object of non-secret headers"),
        envConfigKeys: z.string().optional().describe("New env config key mappings"),
        headerConfigKeys: z.string().optional().describe("New header config key mappings"),
        extraAuthorizeParams: z
          .string()
          .optional()
          .describe(
            'JSON object string of extra OAuth authorize-request params, e.g. {"access_type":"offline","prompt":"consent"}',
          ),
        isEnabled: z.boolean().optional().describe("Toggle enabled/disabled"),
      }),
      outputSchema: swarmToolOutputSchema({
        yourAgentId: z.string().optional(),
        server: z.looseObject({}).optional(),
      }),
    },
    async (args, requestInfo, _meta) => {
      if (!requestInfo.agentId) {
        return toolErr("Agent ID not found.");
      }

      try {
        const updates: Parameters<typeof updateMcpServer>[1] = {};
        if (args.name !== undefined) updates.name = args.name;
        if (args.description !== undefined) updates.description = args.description;
        if (args.transport !== undefined) updates.transport = args.transport;
        if (args.command !== undefined) updates.command = args.command;
        if (args.args !== undefined) updates.args = args.args;
        if (args.url !== undefined) updates.url = args.url;
        if (args.headers !== undefined) updates.headers = args.headers;
        if (args.envConfigKeys !== undefined) updates.envConfigKeys = args.envConfigKeys;
        if (args.headerConfigKeys !== undefined) updates.headerConfigKeys = args.headerConfigKeys;
        if (args.extraAuthorizeParams !== undefined)
          updates.extraAuthorizeParams = args.extraAuthorizeParams;
        if (args.isEnabled !== undefined) updates.isEnabled = args.isEnabled;

        // Both decisions read the server and the agent inside the write transaction, so a
        // concurrent edit cannot change what the server runs between the decision and the write.
        const agentId = requestInfo.agentId;
        const result = await updateMcpServerChecked(args.id, updates, async (existing) => {
          const agent = await getAgentById(agentId);
          const principal = {
            kind: "agent" as const,
            agentId,
            isLead: agent?.isLead ?? false,
          };

          // Only owner or lead can update
          const decision = can({
            principal,
            verb: "mcp-server.update.any",
            resource: { kind: "owned", ownerAgentId: existing.ownerAgentId },
            source: "mcp",
          });
          if (!decision.allow) return "Only the owning agent or lead can update this MCP server.";

          // The owner may edit a server, but not change or turn on the command a stdio one runs.
          if (updateTouchesStdioExecution(existing, updates)) {
            const stdioDecision = can({
              principal,
              verb: "mcp-server.stdio.write",
              resource: { kind: "none" },
              source: "mcp",
            });
            if (!stdioDecision.allow) {
              return "Only lead agents can create or change stdio MCP servers.";
            }
          }
          return null;
        });

        if (result.kind === "not-found") {
          return toolErr("MCP server not found.", { data: { yourAgentId: requestInfo.agentId } });
        }
        if (result.kind === "refused") {
          return toolErr(result.refusal, { data: { yourAgentId: requestInfo.agentId } });
        }

        const updated = result.server;
        return toolOk(`Updated MCP server "${updated.name}" to version ${updated.version}.`, {
          data: { yourAgentId: requestInfo.agentId, server: updated },
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error";
        return toolErr(`Failed: ${message}`, { data: { yourAgentId: requestInfo.agentId } });
      }
    },
  );
};
