import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { createTaskExtended, getAgentById, getLeadAgent, getSkillById } from "@/be/db";
import { createToolRegistrar, swarmToolOutputSchema, toolErr, toolOk } from "@/tools/utils";

export const registerSkillPublishTool = (server: McpServer) => {
  createToolRegistrar(server)(
    "skill-publish",
    {
      title: "Publish Skill",
      annotations: { destructiveHint: false },
      description:
        "Publish a personal skill to swarm scope. Creates an approval task for the lead agent.",
      inputSchema: z.object({
        skillId: z.string().describe("ID of the personal skill to publish"),
      }),
      outputSchema: swarmToolOutputSchema({
        yourAgentId: z.string().optional(),
        taskId: z.string().optional(),
      }),
    },
    async (args, requestInfo, _meta) => {
      if (!requestInfo.agentId) {
        return toolErr("Agent ID not found.");
      }

      const skill = getSkillById(args.skillId);
      if (!skill) {
        return toolErr("Skill not found.", { data: { yourAgentId: requestInfo.agentId } });
      }

      if (skill.type !== "personal") {
        return toolErr("Only personal skills can be published.", {
          data: { yourAgentId: requestInfo.agentId },
        });
      }

      if (skill.ownerAgentId !== requestInfo.agentId) {
        return toolErr("You can only publish your own skills.", {
          data: { yourAgentId: requestInfo.agentId },
        });
      }

      // Find the lead agent
      const leadAgent = getLeadAgent();

      if (!leadAgent) {
        return toolErr("No lead agent available.", {
          details: "No lead agent found to approve the skill.",
          data: { yourAgentId: requestInfo.agentId },
        });
      }

      // Create an approval task for the lead
      const agent = getAgentById(requestInfo.agentId);
      const taskDescription = `Skill Approval Request: "${skill.name}"

Agent ${agent?.name ?? requestInfo.agentId} wants to publish a personal skill to swarm scope.

**Skill Name:** ${skill.name}
**Description:** ${skill.description}
**Version:** ${skill.version}

**Content:**
\`\`\`
${skill.content}
\`\`\`

To approve: update the skill's scope to "swarm" using skill-update.
To reject: close this task with a rejection reason.`;

      const task = createTaskExtended(taskDescription, {
        agentId: leadAgent.id,
        creatorAgentId: requestInfo.agentId,
        source: "mcp",
        taskType: "skill-approval",
        tags: ["skill-approval", skill.name],
        priority: 60,
      });

      return toolOk(`Publish request sent to lead. Track via task ${task.id}.`, {
        details: `Skill publish request created. Task ${task.id} sent to lead for approval.`,
        data: { yourAgentId: requestInfo.agentId, taskId: task.id },
      });
    },
  );
};
