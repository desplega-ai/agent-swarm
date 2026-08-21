import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { getAgentById, uninstallSkill } from "@/be/db";
import { can } from "@/rbac";
import { createToolRegistrar, swarmToolOutputSchema, toolErr, toolOk } from "@/tools/utils";

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
      outputSchema: swarmToolOutputSchema({
        yourAgentId: z.string().optional(),
      }),
    },
    async (args, requestInfo, _meta) => {
      if (!requestInfo.agentId) {
        return toolErr("Agent ID not found.");
      }

      const targetAgentId = args.agentId ?? requestInfo.agentId;

      if (targetAgentId !== requestInfo.agentId) {
        const agent = await getAgentById(requestInfo.agentId);
        const decision = can({
          principal: {
            kind: "agent",
            agentId: requestInfo.agentId,
            isLead: agent?.isLead ?? false,
          },
          verb: "skill.uninstall.any",
          resource: { kind: "agent", agentId: targetAgentId },
          source: "mcp",
        });
        if (!decision.allow) {
          return toolErr("Only leads can uninstall skills for other agents.", {
            data: { yourAgentId: requestInfo.agentId },
          });
        }
      }

      const removed = await uninstallSkill(targetAgentId, args.skillId);
      const message = removed ? "Skill uninstalled." : "Skill was not installed for this agent.";
      return removed
        ? toolOk(message, { data: { yourAgentId: requestInfo.agentId } })
        : toolErr(message, { data: { yourAgentId: requestInfo.agentId } });
    },
  );
};
