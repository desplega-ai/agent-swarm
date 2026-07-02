import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { getAgentById, getSkillById, installSkill } from "@/be/db";
import { createToolRegistrar } from "@/tools/utils";

export const registerSkillInstallTool = (server: McpServer) => {
  createToolRegistrar(server)(
    "skill-install",
    {
      title: "Install Skill",
      annotations: { destructiveHint: false },
      description: "Install/assign a skill to an agent. Leads can install for other agents.",
      inputSchema: z.object({
        skillId: z.string().describe("ID of the skill to install"),
        agentId: z
          .string()
          .optional()
          .describe("Target agent (default: calling agent). Lead can install for others."),
      }),
      outputSchema: z.object({
        yourAgentId: z.string().uuid().optional(),
        success: z.boolean(),
        message: z.string(),
        agentSkill: z.any().optional(),
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

      // If installing for another agent, must be lead
      if (targetAgentId !== requestInfo.agentId) {
        const agent = getAgentById(requestInfo.agentId);
        if (!agent?.isLead) {
          return {
            content: [{ type: "text", text: "Only leads can install skills for other agents." }],
            structuredContent: {
              yourAgentId: requestInfo.agentId,
              success: false,
              message: "Permission denied.",
            },
          };
        }
      }

      const skill = getSkillById(args.skillId);
      if (!skill) {
        return {
          content: [{ type: "text", text: "Skill not found." }],
          structuredContent: {
            yourAgentId: requestInfo.agentId,
            success: false,
            message: "Skill not found.",
          },
        };
      }

      if (!skill.isEnabled) {
        return {
          content: [{ type: "text", text: "Skill is disabled." }],
          structuredContent: {
            yourAgentId: requestInfo.agentId,
            success: false,
            message: "Skill is disabled.",
          },
        };
      }

      try {
        const agentSkill = installSkill(targetAgentId, args.skillId);
        return {
          content: [
            { type: "text", text: `Installed skill "${skill.name}" for agent ${targetAgentId}.` },
          ],
          structuredContent: {
            yourAgentId: requestInfo.agentId,
            success: true,
            message: `Installed skill "${skill.name}".`,
            agentSkill,
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
          },
        };
      }
    },
  );
};
