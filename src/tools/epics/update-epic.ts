import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { getAgentById, getEpicById, getEpicByName, updateEpic } from "@/be/db";
import { createToolRegistrar } from "@/tools/utils";
import type { EpicStatus } from "@/types";

export const registerUpdateEpicTool = (server: McpServer) => {
  createToolRegistrar(server)(
    "update-epic",
    {
      title: "Update Epic",
      description:
        "Update an existing epic. Only the creator, lead agent, or swarm lead can update.",
      inputSchema: z.object({
        epicId: z.string().uuid().optional().describe("The ID of the epic to update"),
        name: z.string().optional().describe("Epic name (alternative to ID for lookup)"),
        newName: z.string().min(1).max(200).optional().describe("New name for the epic"),
        description: z.string().optional().describe("New description"),
        goal: z.string().min(1).optional().describe("New goal"),
        prd: z.string().optional().describe("New PRD (markdown)"),
        plan: z.string().optional().describe("New plan (markdown)"),
        status: z
          .enum(["draft", "active", "paused", "completed", "cancelled"])
          .optional()
          .describe("New status"),
        priority: z.number().int().min(0).max(100).optional().describe("New priority"),
        tags: z.array(z.string()).optional().describe("New tags"),
        leadAgentId: z.string().uuid().nullable().optional().describe("New lead agent"),
        researchDocPath: z.string().optional(),
        planDocPath: z.string().optional(),
        slackChannelId: z.string().optional(),
        slackThreadTs: z.string().optional(),
        githubRepo: z.string().optional(),
        githubMilestone: z.string().optional(),
      }),
      outputSchema: z.object({
        yourAgentId: z.string().optional(),
        success: z.boolean(),
        message: z.string(),
        epic: z.any().optional(),
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

        // Check authorization: must be creator, lead agent, or swarm lead
        const callingAgent = getAgentById(requestInfo.agentId);
        const isCreator = epic.createdByAgentId === requestInfo.agentId;
        const isEpicLead = epic.leadAgentId === requestInfo.agentId;
        const isSwarmLead = callingAgent?.isLead === true;

        if (!isCreator && !isEpicLead && !isSwarmLead) {
          return {
            content: [
              {
                type: "text",
                text: "Not authorized. Only epic creator, lead agent, or swarm lead can update.",
              },
            ],
            structuredContent: {
              yourAgentId: requestInfo.agentId,
              success: false,
              message: "Not authorized to update this epic.",
            },
          };
        }

        // Validate new leadAgentId if provided
        if (args.leadAgentId && args.leadAgentId !== null) {
          const agent = getAgentById(args.leadAgentId);
          if (!agent) {
            return {
              content: [{ type: "text", text: `Lead agent not found: ${args.leadAgentId}` }],
              structuredContent: {
                yourAgentId: requestInfo.agentId,
                success: false,
                message: "Lead agent not found.",
              },
            };
          }
        }

        // Build update data
        const updateData: Parameters<typeof updateEpic>[1] = {};
        if (args.newName !== undefined) updateData.name = args.newName;
        if (args.description !== undefined) updateData.description = args.description;
        if (args.goal !== undefined) updateData.goal = args.goal;
        if (args.prd !== undefined) updateData.prd = args.prd;
        if (args.plan !== undefined) updateData.plan = args.plan;
        if (args.status !== undefined) updateData.status = args.status as EpicStatus;
        if (args.priority !== undefined) updateData.priority = args.priority;
        if (args.tags !== undefined) updateData.tags = args.tags;
        if (args.leadAgentId !== undefined) updateData.leadAgentId = args.leadAgentId;
        if (args.researchDocPath !== undefined) updateData.researchDocPath = args.researchDocPath;
        if (args.planDocPath !== undefined) updateData.planDocPath = args.planDocPath;
        if (args.slackChannelId !== undefined) updateData.slackChannelId = args.slackChannelId;
        if (args.slackThreadTs !== undefined) updateData.slackThreadTs = args.slackThreadTs;
        if (args.githubRepo !== undefined) updateData.githubRepo = args.githubRepo;
        if (args.githubMilestone !== undefined) updateData.githubMilestone = args.githubMilestone;

        const updatedEpic = updateEpic(epic.id, updateData);

        if (!updatedEpic) {
          return {
            content: [{ type: "text", text: "Failed to update epic." }],
            structuredContent: {
              yourAgentId: requestInfo.agentId,
              success: false,
              message: "Failed to update epic.",
            },
          };
        }

        return {
          content: [{ type: "text", text: `Updated epic "${updatedEpic.name}".` }],
          structuredContent: {
            yourAgentId: requestInfo.agentId,
            success: true,
            message: `Updated epic "${updatedEpic.name}".`,
            epic: updatedEpic,
          },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error";
        return {
          content: [{ type: "text", text: `Failed to update epic: ${message}` }],
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
