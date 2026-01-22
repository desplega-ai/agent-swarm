import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { deleteEpic, getAgentById, getEpicById, getEpicByName } from "@/be/db";
import { createToolRegistrar } from "@/tools/utils";

export const registerDeleteEpicTool = (server: McpServer) => {
  createToolRegistrar(server)(
    "delete-epic",
    {
      title: "Delete Epic",
      description:
        "Delete an epic. Only the creator or swarm lead can delete. Tasks are unassigned, not deleted.",
      inputSchema: z.object({
        epicId: z.string().uuid().optional().describe("The ID of the epic to delete"),
        name: z.string().optional().describe("Epic name (alternative to ID)"),
      }),
      outputSchema: z.object({
        yourAgentId: z.string().uuid().optional(),
        success: z.boolean(),
        message: z.string(),
      }),
    },
    async (args, requestInfo, _meta) => {
      if (!requestInfo.agentId) {
        return {
          content: [{ type: "text", text: 'Agent ID not found. Set the "X-Agent-ID" header.' }],
          structuredContent: { success: false, message: "Agent ID not found." },
        };
      }

      if (!args.epicId && !args.name) {
        return {
          content: [{ type: "text", text: "Either epicId or name must be provided." }],
          structuredContent: {
            yourAgentId: requestInfo.agentId,
            success: false,
            message: "Either epicId or name must be provided.",
          },
        };
      }

      try {
        // Find epic by ID or name
        let epic = args.epicId ? getEpicById(args.epicId) : null;
        if (!epic && args.name) {
          epic = getEpicByName(args.name);
        }

        if (!epic) {
          const identifier = args.epicId || args.name;
          return {
            content: [{ type: "text", text: `Epic not found: ${identifier}` }],
            structuredContent: {
              yourAgentId: requestInfo.agentId,
              success: false,
              message: `Epic not found: ${identifier}`,
            },
          };
        }

        // Check authorization: must be creator or swarm lead
        const callingAgent = getAgentById(requestInfo.agentId);
        const isCreator = epic.createdByAgentId === requestInfo.agentId;
        const isSwarmLead = callingAgent?.isLead === true;

        if (!isCreator && !isSwarmLead) {
          return {
            content: [
              { type: "text", text: "Not authorized. Only epic creator or swarm lead can delete." },
            ],
            structuredContent: {
              yourAgentId: requestInfo.agentId,
              success: false,
              message: "Not authorized to delete this epic.",
            },
          };
        }

        const epicName = epic.name;
        const deleted = deleteEpic(epic.id);

        if (!deleted) {
          return {
            content: [{ type: "text", text: "Failed to delete epic." }],
            structuredContent: {
              yourAgentId: requestInfo.agentId,
              success: false,
              message: "Failed to delete epic.",
            },
          };
        }

        return {
          content: [
            {
              type: "text",
              text: `Deleted epic "${epicName}". Associated tasks have been unassigned from the epic.`,
            },
          ],
          structuredContent: {
            yourAgentId: requestInfo.agentId,
            success: true,
            message: `Deleted epic "${epicName}".`,
          },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error";
        return {
          content: [{ type: "text", text: `Failed to delete epic: ${message}` }],
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
