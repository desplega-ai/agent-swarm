import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { parseSkillContent } from "@swarm/core-utils";
import { createToolRegistrar } from "@swarm/mcp-tool";
import { getAgentById, getSkillById, updateSkill } from "@swarm/storage";
import * as z from "zod";

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

      if (!args.skillId) {
        return {
          content: [{ type: "text", text: "skillId is required." }],
          structuredContent: {
            yourAgentId: requestInfo.agentId,
            success: false,
            message: "skillId is required.",
          },
        };
      }

      try {
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

        // Only owner or lead can update
        const agent = getAgentById(requestInfo.agentId);
        if (existing.ownerAgentId !== requestInfo.agentId && !agent?.isLead) {
          return {
            content: [
              { type: "text", text: "Only the owning agent or lead can update this skill." },
            ],
            structuredContent: {
              yourAgentId: requestInfo.agentId,
              success: false,
              message: "Permission denied.",
            },
          };
        }

        if (existing.systemDefault && (args.content !== undefined || args.scope !== undefined)) {
          return {
            content: [{ type: "text", text: SYSTEM_DEFAULT_SKILL_LOCKED_MESSAGE }],
            structuredContent: {
              yourAgentId: requestInfo.agentId,
              success: false,
              message: SYSTEM_DEFAULT_SKILL_LOCKED_MESSAGE,
            },
          };
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
          if (args.scope === "swarm" && !agent?.isLead) {
            return {
              content: [
                {
                  type: "text",
                  text: 'Only lead agents can promote a skill to "swarm" scope. Use "skill-publish" to request approval.',
                },
              ],
              structuredContent: {
                yourAgentId: requestInfo.agentId,
                success: false,
                message: "Only lead agents can promote a skill to swarm scope.",
              },
            };
          }
          updates.scope = args.scope;
        }

        const skill = updateSkill(args.skillId, updates);
        if (!skill) {
          return {
            content: [{ type: "text", text: "Failed to update skill." }],
            structuredContent: {
              yourAgentId: requestInfo.agentId,
              success: false,
              message: "Update failed.",
            },
          };
        }

        return {
          content: [{ type: "text", text: `Updated skill "${skill.name}" (v${skill.version})` }],
          structuredContent: {
            yourAgentId: requestInfo.agentId,
            success: true,
            message: `Updated skill "${skill.name}" to version ${skill.version}.`,
            skill,
          },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error";
        return {
          content: [{ type: "text", text: `Failed: ${message}` }],
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
