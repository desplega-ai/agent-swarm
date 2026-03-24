import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { getAgentById, getSkillById } from "@/be/db";
import { createToolRegistrar } from "@/tools/utils";

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
      outputSchema: z.object({
        yourAgentId: z.string().uuid().optional(),
        success: z.boolean(),
        message: z.string(),
        taskId: z.string().optional(),
      }),
    },
    async (args, requestInfo, _meta) => {
      if (!requestInfo.agentId) {
        return {
          content: [{ type: "text", text: "Agent ID not found." }],
          structuredContent: { success: false, message: "Agent ID not found." },
        };
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

      if (skill.type !== "personal") {
        return {
          content: [{ type: "text", text: "Only personal skills can be published." }],
          structuredContent: {
            yourAgentId: requestInfo.agentId,
            success: false,
            message: "Only personal skills can be published.",
          },
        };
      }

      if (skill.ownerAgentId !== requestInfo.agentId) {
        return {
          content: [{ type: "text", text: "You can only publish your own skills." }],
          structuredContent: {
            yourAgentId: requestInfo.agentId,
            success: false,
            message: "You can only publish your own skills.",
          },
        };
      }

      // Find the lead agent
      const { getDb } = await import("@/be/db");
      const leadRow = getDb()
        .prepare<{ id: string }, []>("SELECT id FROM agents WHERE isLead = 1 LIMIT 1")
        .get();

      if (!leadRow) {
        return {
          content: [{ type: "text", text: "No lead agent found to approve the skill." }],
          structuredContent: {
            yourAgentId: requestInfo.agentId,
            success: false,
            message: "No lead agent available.",
          },
        };
      }

      // Create an approval task for the lead
      const { createTaskExtended } = await import("@/be/db");
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
        agentId: leadRow.id,
        creatorAgentId: requestInfo.agentId,
        source: "mcp",
        taskType: "skill-approval",
        tags: ["skill-approval", skill.name],
        priority: 60,
      });

      return {
        content: [
          {
            type: "text",
            text: `Skill publish request created. Task ${task.id} sent to lead for approval.`,
          },
        ],
        structuredContent: {
          yourAgentId: requestInfo.agentId,
          success: true,
          message: `Publish request sent to lead. Track via task ${task.id}.`,
          taskId: task.id,
        },
      };
    },
  );
};
