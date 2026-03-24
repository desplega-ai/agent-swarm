import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { deleteSkill, getAgentById, getSkillById } from "@/be/db";
import { createToolRegistrar } from "@/tools/utils";

export const registerSkillDeleteTool = (server: McpServer) => {
  createToolRegistrar(server)(
    "skill-delete",
    {
      title: "Delete Skill",
      annotations: { destructiveHint: true },
      description: "Delete a skill. Only the owning agent or lead can delete.",
      inputSchema: z.object({
        skillId: z.string().describe("ID of the skill to delete"),
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

      const existing = getSkillById(args.skillId);
      if (!existing) {
        return {
          content: [{ type: "text", text: "Skill not found." }],
          structuredContent: {
            yourAgentId: requestInfo.agentId,
            success: false,
            message: "Skill not found.",
          },
        };
      }

      const agent = getAgentById(requestInfo.agentId);
      if (existing.ownerAgentId !== requestInfo.agentId && !agent?.isLead) {
        return {
          content: [{ type: "text", text: "Only the owning agent or lead can delete this skill." }],
          structuredContent: {
            yourAgentId: requestInfo.agentId,
            success: false,
            message: "Permission denied.",
          },
        };
      }

      const deleted = deleteSkill(args.skillId);
      return {
        content: [
          { type: "text", text: deleted ? `Deleted skill "${existing.name}".` : "Delete failed." },
        ],
        structuredContent: {
          yourAgentId: requestInfo.agentId,
          success: deleted,
          message: deleted ? `Deleted skill "${existing.name}".` : "Delete failed.",
        },
      };
    },
  );
};
