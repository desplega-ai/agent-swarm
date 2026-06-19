import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { getAgentSkills } from "@/be/db";
import { createToolRegistrar } from "@/tools/utils";
import type { Skill } from "@/types";

function maxSkillChars(): number {
  return Number(process.env.MAX_SKILL_CHARS) || 100_000;
}

function normalizeSkillName(value: string): string {
  return value.trim().replace(/^\/+/, "").toLowerCase();
}

export function resolveAvailableSkillByName(
  nameOrSlug: string,
  agentId: string,
): { skill: Skill | null; matchedBy: "exact" | "fuzzy" | null; available: Skill[] } {
  const query = normalizeSkillName(nameOrSlug);
  const available = getAgentSkills(agentId);
  const exact =
    available.find((skill) => normalizeSkillName(skill.name) === query) ??
    available.find((skill) => normalizeSkillName(skill.name).replaceAll("_", "-") === query) ??
    available.find((skill) => normalizeSkillName(skill.name).replaceAll("-", "_") === query);

  if (exact) {
    return { skill: exact, matchedBy: "exact", available };
  }

  const fuzzy = available.find((skill) => {
    const name = normalizeSkillName(skill.name);
    const description = skill.description.toLowerCase();
    return name.includes(query) || query.includes(name) || description.includes(query);
  });

  return { skill: fuzzy ?? null, matchedBy: fuzzy ? "fuzzy" : null, available };
}

export const registerSkillTool = (server: McpServer) => {
  createToolRegistrar(server)(
    "Skill",
    {
      title: "Skill",
      annotations: { destructiveHint: false },
      description:
        "Load an installed skill's SKILL.md content into context by name or slug. Exact name matches are preferred; fuzzy matching falls back within the calling agent's available skills.",
      inputSchema: z.object({
        name: z.string().min(1).optional().describe("Skill name or slug to load"),
        skill: z.string().min(1).optional().describe("Alias for name"),
      }),
      outputSchema: z.object({
        yourAgentId: z.string().uuid().optional(),
        success: z.boolean(),
        message: z.string(),
        skillName: z.string().optional(),
        skillId: z.string().optional(),
        matchedBy: z.enum(["exact", "fuzzy"]).optional(),
        truncated: z.boolean().optional(),
        originalChars: z.number().optional(),
        returnedChars: z.number().optional(),
      }),
    },
    async (args, requestInfo, _meta) => {
      const requestedName = args.name ?? args.skill;
      if (!requestedName) {
        const message = "Provide a skill name.";
        return {
          content: [{ type: "text", text: message }],
          structuredContent: {
            yourAgentId: requestInfo.agentId,
            success: false,
            message,
          },
        };
      }

      if (!requestInfo.agentId) {
        const message = "Skill tool requires a calling agent id.";
        return {
          content: [{ type: "text", text: message }],
          structuredContent: {
            yourAgentId: requestInfo.agentId,
            success: false,
            message,
          },
        };
      }

      const { skill, matchedBy, available } = resolveAvailableSkillByName(
        requestedName,
        requestInfo.agentId,
      );

      if (!skill) {
        const candidates = available
          .slice(0, 8)
          .map((availableSkill) => availableSkill.name)
          .join(", ");
        const message = candidates
          ? `Skill "${requestedName}" not found for this agent. Available examples: ${candidates}.`
          : `Skill "${requestedName}" not found for this agent.`;
        return {
          content: [{ type: "text", text: message }],
          structuredContent: {
            yourAgentId: requestInfo.agentId,
            success: false,
            message,
          },
        };
      }

      const originalChars = skill.content.length;
      const limit = maxSkillChars();
      const truncated = originalChars > limit;
      const content = truncated ? skill.content.slice(0, limit) : skill.content;
      const message = truncated
        ? `Loaded skill "${skill.name}" and truncated content to ${limit} chars.`
        : `Loaded skill "${skill.name}".`;

      return {
        content: [{ type: "text", text: content }],
        structuredContent: {
          yourAgentId: requestInfo.agentId,
          success: true,
          message,
          skillName: skill.name,
          skillId: skill.id,
          matchedBy: matchedBy ?? undefined,
          truncated,
          originalChars,
          returnedChars: content.length,
        },
      };
    },
  );
};
