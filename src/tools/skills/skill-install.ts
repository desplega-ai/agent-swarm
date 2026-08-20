import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { getAgentById, getSkillById, installSkill } from "@/be/db";
import { can } from "@/rbac";
import { createToolRegistrar, swarmToolOutputSchema, toolErr, toolOk } from "@/tools/utils";

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
      outputSchema: swarmToolOutputSchema({
        yourAgentId: z.string().optional(),
        agentSkill: z.looseObject({}).optional(),
      }),
    },
    async (args, requestInfo, _meta) => {
      if (!requestInfo.agentId) {
        return toolErr("Agent ID not found.");
      }

      const targetAgentId = args.agentId ?? requestInfo.agentId;

      // If installing for another agent, must be lead
      if (targetAgentId !== requestInfo.agentId) {
        const agent = await getAgentById(requestInfo.agentId);
        const decision = can({
          principal: {
            kind: "agent",
            agentId: requestInfo.agentId,
            isLead: agent?.isLead ?? false,
          },
          verb: "skill.install.any",
          resource: { kind: "agent", agentId: targetAgentId },
          source: "mcp",
        });
        if (!decision.allow) {
          return toolErr("Only leads can install skills for other agents.", {
            data: { yourAgentId: requestInfo.agentId },
          });
        }
      }

      const skill = await getSkillById(args.skillId);
      if (!skill) {
        return toolErr("Skill not found.", { data: { yourAgentId: requestInfo.agentId } });
      }

      if (!skill.isEnabled) {
        return toolErr("Skill is disabled.", { data: { yourAgentId: requestInfo.agentId } });
      }

      try {
        const agentSkill = await installSkill(targetAgentId, args.skillId);
        return toolOk(`Installed skill "${skill.name}".`, {
          details: `Installed skill "${skill.name}" for agent ${targetAgentId}.`,
          data: { yourAgentId: requestInfo.agentId, agentSkill },
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error";
        return toolErr(`Failed: ${message}`, { data: { yourAgentId: requestInfo.agentId } });
      }
    },
  );
};
