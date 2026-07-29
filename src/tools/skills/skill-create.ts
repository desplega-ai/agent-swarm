import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { createSkill, getAgentById, installSkill } from "@/be/db";
import { parseSkillContent } from "@/be/skill-parser";
import { can } from "@/rbac";
import { createToolRegistrar, swarmToolOutputSchema, toolErr, toolOk } from "@/tools/utils";

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
      outputSchema: swarmToolOutputSchema({
        yourAgentId: z.string().optional(),
        skill: z.looseObject({}).optional(),
      }),
    },
    async (args, requestInfo, _meta) => {
      if (!requestInfo.agentId) {
        return toolErr("Agent ID not found.");
      }

      try {
        const parsed = parseSkillContent(args.content);

        // If swarm scope requested, only leads can create directly
        if (args.scope === "swarm") {
          const agent = getAgentById(requestInfo.agentId);
          const decision = can({
            principal: {
              kind: "agent",
              agentId: requestInfo.agentId,
              isLead: agent?.isLead ?? false,
            },
            verb: "skill.create.swarm",
            resource: { kind: "none" },
            source: "mcp",
          });
          if (!decision.allow) {
            return toolErr("Only lead agents can create swarm-scope skills directly.", {
              details: 'Use "skill-publish" to request approval.',
              data: { yourAgentId: requestInfo.agentId },
            });
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

        return toolOk(`Created and installed skill "${skill.name}".`, {
          data: { yourAgentId: requestInfo.agentId, skill },
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error";
        return toolErr(`Failed to create skill: ${message}`, {
          data: { yourAgentId: requestInfo.agentId },
        });
      }
    },
  );
};
