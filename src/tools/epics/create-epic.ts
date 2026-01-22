import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { createEpic, getAgentById, getChannelById, getEpicByName } from "@/be/db";
import { createToolRegistrar } from "@/tools/utils";

export const registerCreateEpicTool = (server: McpServer) => {
  createToolRegistrar(server)(
    "create-epic",
    {
      title: "Create Epic",
      description: "Create a new epic (project) to organize related tasks.",
      inputSchema: z.object({
        name: z.string().min(1).max(200).describe("Unique name for the epic"),
        goal: z.string().min(1).describe("The goal/objective of this epic"),
        description: z.string().optional().describe("Detailed description"),
        prd: z.string().optional().describe("Product Requirements Document (markdown)"),
        plan: z.string().optional().describe("Implementation plan (markdown)"),
        priority: z.number().int().min(0).max(100).default(50).optional(),
        tags: z.array(z.string()).optional().describe("Tags for filtering"),
        leadAgentId: z.string().uuid().optional().describe("Lead agent for this epic"),
        researchDocPath: z.string().optional().describe("Path to research document"),
        planDocPath: z.string().optional().describe("Path to plan document"),
        slackChannelId: z.string().optional(),
        slackThreadTs: z.string().optional(),
        githubRepo: z.string().optional(),
        githubMilestone: z.string().optional(),
      }),
      outputSchema: z.object({
        yourAgentId: z.string().uuid().optional(),
        success: z.boolean(),
        message: z.string(),
        epic: z.any().optional(),
        channel: z.any().optional(),
      }),
    },
    async (args, requestInfo, _meta) => {
      if (!requestInfo.agentId) {
        return {
          content: [{ type: "text", text: 'Agent ID not found. Set the "X-Agent-ID" header.' }],
          structuredContent: { success: false, message: "Agent ID not found." },
        };
      }

      // Only lead agents can create epics
      const agent = getAgentById(requestInfo.agentId);
      if (!agent || !agent.isLead) {
        return {
          content: [{ type: "text", text: "Only lead agents can create epics." }],
          structuredContent: {
            yourAgentId: requestInfo.agentId,
            success: false,
            message: "Only lead agents can create epics.",
          },
        };
      }

      // Check for duplicate name
      const existing = getEpicByName(args.name);
      if (existing) {
        return {
          content: [{ type: "text", text: `Epic "${args.name}" already exists.` }],
          structuredContent: { success: false, message: `Epic "${args.name}" already exists.` },
        };
      }

      // Validate leadAgentId if provided
      if (args.leadAgentId) {
        const agent = getAgentById(args.leadAgentId);
        if (!agent) {
          return {
            content: [{ type: "text", text: `Lead agent not found: ${args.leadAgentId}` }],
            structuredContent: { success: false, message: "Lead agent not found." },
          };
        }
      }

      try {
        // createEpic automatically creates a messaging channel for the epic
        const epic = createEpic({
          ...args,
          createdByAgentId: requestInfo.agentId,
        });

        // Get the auto-created channel for the response
        const channel = epic.channelId ? getChannelById(epic.channelId) : null;

        return {
          content: [
            {
              type: "text",
              text: `Created epic "${epic.name}" (${epic.id}) with channel #${channel?.name ?? "unknown"}`,
            },
          ],
          structuredContent: {
            yourAgentId: requestInfo.agentId,
            success: true,
            message: `Created epic "${epic.name}" with channel #${channel?.name ?? "unknown"}.`,
            epic,
            channel,
          },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error";
        return {
          content: [{ type: "text", text: `Failed to create epic: ${message}` }],
          structuredContent: { success: false, message: `Failed: ${message}` },
        };
      }
    },
  );
};
