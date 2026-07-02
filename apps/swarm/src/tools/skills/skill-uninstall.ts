import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { getAgentById, uninstallSkill } from "@/be/db";
import { createToolRegistrar } from "@/tools/utils";

export const registerSkillUninstallTool = (server: McpServer) => {
  createToolRegistrar(server)(
    "skill-uninstall",
    {
      title: "Uninstall Skill",
      annotations: { destructiveHint: true },
      description: "Remove a skill from an agent.",
      inputSchema: z.object({
        skillId: z.string().describe("ID of the skill to uninstall"),
        agentId: z.string().optional().describe("Target agent (default: calling agent)"),
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
          content: [{ type: "text", text: "Agent ID not found." }],
          structuredContent: { success: false, message: "Agent ID not found." },
        };
      }

      const targetAgentId = args.agentId ?? requestInfo.agentId;

      if (targetAgentId !== requestInfo.agentId) {
        const agent = getAgentById(requestInfo.agentId);
        if (!agent?.isLead) {
          return {
            content: [{ type: "text", text: "Only leads can uninstall skills for other agents." }],
            structuredContent: {
              yourAgentId: requestInfo.agentId,
              success: false,
              message: "Permission denied.",
            },
          };
        }
      }

      const removed = uninstallSkill(targetAgentId, args.skillId);
      return {
        content: [
          { type: "text", text: removed ? "Skill uninstalled." : "Skill was not installed." },
        ],
        structuredContent: {
          yourAgentId: requestInfo.agentId,
          success: removed,
          message: removed ? "Skill uninstalled." : "Skill was not installed for this agent.",
        },
      };
    },
  );
};
