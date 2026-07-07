import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { deleteSkill, getAgentById, getSkillById } from "@/be/db";
import { can } from "@/rbac";
import { createToolRegistrar } from "@/tools/utils";

const SYSTEM_DEFAULT_SKILL_LOCKED_MESSAGE =
  "This skill is system-managed and cannot be edited from the UI; it is re-seeded on each start. Fork it under a new name to customize.";

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
      const decision = can({
        principal: {
          kind: "agent",
          agentId: requestInfo.agentId,
          isLead: agent?.isLead ?? false,
        },
        verb: "skill.delete.any",
        resource: { kind: "owned", ownerAgentId: existing.ownerAgentId },
        source: "mcp",
      });
      if (!decision.allow) {
        return {
          content: [{ type: "text", text: "Only the owning agent or lead can delete this skill." }],
          structuredContent: {
            yourAgentId: requestInfo.agentId,
            success: false,
            message: "Permission denied.",
          },
        };
      }

      if (existing.systemDefault) {
        return {
          content: [{ type: "text", text: SYSTEM_DEFAULT_SKILL_LOCKED_MESSAGE }],
          structuredContent: {
            yourAgentId: requestInfo.agentId,
            success: false,
            message: SYSTEM_DEFAULT_SKILL_LOCKED_MESSAGE,
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
