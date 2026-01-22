import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { getAgentById, getInboxMessageById } from "@/be/db";
import { createToolRegistrar } from "@/tools/utils";
import { InboxMessageSchema } from "@/types";

export const registerGetInboxMessageTool = (server: McpServer) => {
  createToolRegistrar(server)(
    "get-inbox-message",
    {
      title: "Get inbox message details",
      description:
        "Returns detailed information about a specific inbox message, including full content and Slack context. Only accessible to the lead agent who owns the message.",
      inputSchema: z.object({
        inboxMessageId: z.uuid().describe("The ID of the inbox message to retrieve."),
      }),
      outputSchema: z.object({
        yourAgentId: z.string().uuid().optional(),
        success: z.boolean(),
        message: z.string(),
        inboxMessage: InboxMessageSchema.optional(),
      }),
    },
    async ({ inboxMessageId }, requestInfo, _meta) => {
      if (!requestInfo.agentId) {
        return {
          content: [{ type: "text", text: "Agent ID not found." }],
          structuredContent: {
            yourAgentId: requestInfo.agentId,
            success: false,
            message: "Agent ID not found.",
          },
        };
      }

      const agent = getAgentById(requestInfo.agentId);
      if (!agent) {
        return {
          content: [{ type: "text", text: "Agent not found in swarm." }],
          structuredContent: {
            yourAgentId: requestInfo.agentId,
            success: false,
            message: "Agent not found in swarm.",
          },
        };
      }

      const inboxMsg = getInboxMessageById(inboxMessageId);

      if (!inboxMsg) {
        return {
          content: [{ type: "text", text: `Inbox message with ID "${inboxMessageId}" not found.` }],
          structuredContent: {
            yourAgentId: requestInfo.agentId,
            success: false,
            message: `Inbox message with ID "${inboxMessageId}" not found.`,
          },
        };
      }

      // Verify ownership - only the assigned lead can read their inbox
      if (inboxMsg.agentId !== requestInfo.agentId) {
        return {
          content: [{ type: "text", text: "This inbox message belongs to another agent." }],
          structuredContent: {
            yourAgentId: requestInfo.agentId,
            success: false,
            message: "This inbox message belongs to another agent.",
          },
        };
      }

      return {
        content: [
          {
            type: "text",
            text: `Inbox message "${inboxMessageId}" retrieved.\n\nContent:\n${inboxMsg.content}`,
          },
        ],
        structuredContent: {
          yourAgentId: requestInfo.agentId,
          success: true,
          message: `Inbox message "${inboxMessageId}" retrieved.`,
          inboxMessage: inboxMsg,
        },
      };
    },
  );
};
