import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { createSkill, getAgentById, installSkill } from "@/be/db";
import { parseSkillContent } from "@/be/skill-parser";
import { createToolRegistrar } from "@/tools/utils";

export const registerSkillCreateTool = (server: McpServer) => {
  createToolRegistrar(server)(
    "skill-create",
    {
      title: "Create Skill",
      annotations: { destructiveHint: false },
      description:
        "Create a personal skill from SKILL.md content. Parses frontmatter for name, description, and metadata.",
      inputSchema: z.object({
        content: z
          .string()
          .min(1)
          .describe("Full SKILL.md content (YAML frontmatter + markdown body)"),
        scope: z
          .enum(["agent", "swarm"])
          .default("agent")
          .optional()
          .describe("Scope: agent (personal) or swarm (shared). Default: agent"),
      }),
      outputSchema: z.object({
        yourAgentId: z.string().uuid().optional(),
        success: z.boolean(),
        message: z.string(),
        skill: z.any().optional(),
      }),
    },
    async (args, requestInfo, _meta) => {
      if (!requestInfo.agentId) {
        return {
          content: [{ type: "text", text: "Agent ID not found." }],
          structuredContent: { success: false, message: "Agent ID not found." },
        };
      }

      try {
        const parsed = parseSkillContent(args.content);

        // If swarm scope requested, only leads can create directly
        if (args.scope === "swarm") {
          const agent = getAgentById(requestInfo.agentId);
          if (!agent?.isLead) {
            return {
              content: [
                {
                  type: "text",
                  text: 'Only lead agents can create swarm-scope skills directly. Use "skill-publish" to request approval.',
                },
              ],
              structuredContent: {
                yourAgentId: requestInfo.agentId,
                success: false,
                message: "Only lead agents can create swarm-scope skills directly.",
              },
            };
          }
        }

        const skill = createSkill({
          name: parsed.name,
          description: parsed.description,
          content: args.content,
          type: "personal",
          scope: args.scope ?? "agent",
          ownerAgentId: requestInfo.agentId,
          allowedTools: parsed.allowedTools,
          model: parsed.model,
          effort: parsed.effort,
          context: parsed.context,
          agent: parsed.agent,
          disableModelInvocation: parsed.disableModelInvocation,
          userInvocable: parsed.userInvocable,
        });

        // Auto-install for the creating agent
        installSkill(requestInfo.agentId, skill.id);

        return {
          content: [{ type: "text", text: `Created skill "${skill.name}" (${skill.id})` }],
          structuredContent: {
            yourAgentId: requestInfo.agentId,
            success: true,
            message: `Created and installed skill "${skill.name}".`,
            skill,
          },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error";
        return {
          content: [{ type: "text", text: `Failed to create skill: ${message}` }],
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
