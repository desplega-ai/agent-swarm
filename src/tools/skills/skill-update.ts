import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { getAgentById, getSkillById, updateSkill } from "@/be/db";
import { parseSkillContent } from "@/be/skill-parser";
import { can } from "@/rbac";
import { createToolRegistrar, swarmToolOutputSchema, toolErr, toolOk } from "@/tools/utils";

const SYSTEM_DEFAULT_SKILL_LOCKED_MESSAGE =
  "This skill is system-managed and cannot be edited from the UI; it is re-seeded on each start. Fork it under a new name to customize.";

export const registerSkillUpdateTool = (server: McpServer) => {
  createToolRegistrar(server)(
    "skill-update",
    {
      title: "Update Skill",
      annotations: { destructiveHint: false },
      description:
        "Update a skill's content or settings. Re-parses frontmatter if content changes.",
      inputSchema: z.object({
        skillId: z.string().optional().describe("Skill ID to update"),
        content: z.string().optional().describe("New SKILL.md content (re-parses frontmatter)"),
        isEnabled: z.boolean().optional().describe("Toggle enabled/disabled"),
        scope: z
          .enum(["agent", "swarm"])
          .optional()
          .describe(
            "Scope: agent (personal) or swarm (shared). Only leads can promote a skill to swarm scope (used by the skill-approval flow).",
          ),
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

      if (!args.skillId) {
        return toolErr("skillId is required.", { data: { yourAgentId: requestInfo.agentId } });
      }

      try {
        const existing = await getSkillById(args.skillId);
        if (!existing) {
          return toolErr("Skill not found.", { data: { yourAgentId: requestInfo.agentId } });
        }

        // Only owner or lead can update
        const agent = await getAgentById(requestInfo.agentId);
        const updateDecision = can({
          principal: {
            kind: "agent",
            agentId: requestInfo.agentId,
            isLead: agent?.isLead ?? false,
          },
          verb: "skill.update.any",
          resource: { kind: "owned", ownerAgentId: existing.ownerAgentId },
          source: "mcp",
        });
        if (!updateDecision.allow) {
          return toolErr("Only the owning agent or lead can update this skill.", {
            data: { yourAgentId: requestInfo.agentId },
          });
        }

        if (existing.systemDefault && (args.content !== undefined || args.scope !== undefined)) {
          return toolErr(SYSTEM_DEFAULT_SKILL_LOCKED_MESSAGE, {
            data: { yourAgentId: requestInfo.agentId },
          });
        }

        const updates: Parameters<typeof updateSkill>[1] = {};

        if (args.content !== undefined) {
          const parsed = parseSkillContent(args.content);
          updates.content = args.content;
          updates.name = parsed.name;
          updates.description = parsed.description;
          updates.allowedTools = parsed.allowedTools;
          updates.model = parsed.model;
          updates.effort = parsed.effort;
          updates.context = parsed.context;
          updates.agent = parsed.agent;
          updates.disableModelInvocation = parsed.disableModelInvocation;
          updates.userInvocable = parsed.userInvocable;
        }

        if (args.isEnabled !== undefined) {
          updates.isEnabled = args.isEnabled;
        }

        if (args.scope !== undefined && args.scope !== existing.scope) {
          // Promoting to swarm scope is the skill-approval path — only leads may do it.
          if (
            args.scope === "swarm" &&
            !can({
              principal: {
                kind: "agent",
                agentId: requestInfo.agentId,
                isLead: agent?.isLead ?? false,
              },
              verb: "skill.promote.swarm",
              resource: { kind: "owned", ownerAgentId: existing.ownerAgentId },
              source: "mcp",
            }).allow
          ) {
            return toolErr("Only lead agents can promote a skill to swarm scope.", {
              details: 'Use "skill-publish" to request approval.',
              data: { yourAgentId: requestInfo.agentId },
            });
          }
          updates.scope = args.scope;
        }

        const skill = await updateSkill(args.skillId, updates);
        if (!skill) {
          return toolErr("Update failed.", {
            details: "Failed to update skill.",
            data: { yourAgentId: requestInfo.agentId },
          });
        }

        return toolOk(`Updated skill "${skill.name}" to version ${skill.version}.`, {
          data: { yourAgentId: requestInfo.agentId, skill },
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error";
        return toolErr(`Failed: ${message}`, { data: { yourAgentId: requestInfo.agentId } });
      }
    },
  );
};
