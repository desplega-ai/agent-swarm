import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { deleteSkill, getAgentById, getSkillById } from "@/be/db";
import { can } from "@/rbac";
import { createToolRegistrar, swarmToolOutputSchema, toolErr, toolOk } from "@/tools/utils";

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
      outputSchema: swarmToolOutputSchema({
        yourAgentId: z.string().optional(),
      }),
    },
    async (args, requestInfo, _meta) => {
      if (!requestInfo.agentId) {
        return toolErr("Agent ID not found.");
      }

      const existing = getSkillById(args.skillId);
      if (!existing) {
        return toolErr("Skill not found.", { data: { yourAgentId: requestInfo.agentId } });
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
        return toolErr("Only the owning agent or lead can delete this skill.", {
          data: { yourAgentId: requestInfo.agentId },
        });
      }

      if (existing.systemDefault) {
        return toolErr(SYSTEM_DEFAULT_SKILL_LOCKED_MESSAGE, {
          data: { yourAgentId: requestInfo.agentId },
        });
      }

      const deleted = deleteSkill(args.skillId);
      const message = deleted ? `Deleted skill "${existing.name}".` : "Delete failed.";
      return deleted
        ? toolOk(message, { data: { yourAgentId: requestInfo.agentId } })
        : toolErr(message, { data: { yourAgentId: requestInfo.agentId } });
    },
  );
};
