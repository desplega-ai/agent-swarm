import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { getSkillById, listSkills, updateSkill } from "@/be/db";
import { parseSkillContent } from "@/be/skill-parser";
import { createToolRegistrar } from "@/tools/utils";

export const registerSkillSyncRemoteTool = (server: McpServer) => {
  createToolRegistrar(server)(
    "skill-sync-remote",
    {
      title: "Sync Remote Skills",
      annotations: { destructiveHint: false },
      description:
        "Check and update remote skills from their GitHub sources. Compares content and updates if changed.",
      inputSchema: z.object({
        skillId: z
          .string()
          .optional()
          .describe("Sync a specific skill, or all remote skills if omitted"),
        force: z
          .boolean()
          .default(false)
          .optional()
          .describe("Force re-fetch even if hash matches"),
      }),
      outputSchema: z.object({
        yourAgentId: z.string().uuid().optional(),
        success: z.boolean(),
        message: z.string(),
        updated: z.number(),
        checked: z.number(),
        errors: z.array(z.string()),
      }),
    },
    async (args, requestInfo, _meta) => {
      try {
        const skills = args.skillId
          ? (() => {
              const skill = getSkillById(args.skillId!);
              return skill && skill.type === "remote" ? [skill] : [];
            })()
          : listSkills({ type: "remote" });

        let updated = 0;
        const errors: string[] = [];

        for (const skill of skills) {
          if (skill.isComplex) continue; // Skip complex skills (handled by npx)
          if (!skill.sourceRepo) continue;

          try {
            const filePath = skill.sourcePath ? `${skill.sourcePath}/SKILL.md` : "SKILL.md";
            const rawUrl = `https://raw.githubusercontent.com/${skill.sourceRepo}/${skill.sourceBranch}/${filePath}`;

            const response = await fetch(rawUrl);
            if (!response.ok) {
              errors.push(`${skill.name}: HTTP ${response.status}`);
              continue;
            }

            const newContent = await response.text();
            const now = new Date().toISOString();

            if (args.force || newContent !== skill.content) {
              const parsed = parseSkillContent(newContent);
              updateSkill(skill.id, {
                content: newContent,
                name: parsed.name,
                description: parsed.description,
                allowedTools: parsed.allowedTools,
                model: parsed.model,
                effort: parsed.effort,
                context: parsed.context,
                agent: parsed.agent,
                disableModelInvocation: parsed.disableModelInvocation,
                userInvocable: parsed.userInvocable,
                sourceHash: crypto.randomUUID(),
              });
              updated++;
            }

            // Update lastFetchedAt regardless
            getDb().prepare("UPDATE skills SET lastFetchedAt = ? WHERE id = ?").run(now, skill.id);
          } catch (err) {
            errors.push(`${skill.name}: ${err instanceof Error ? err.message : "Unknown error"}`);
          }
        }

        return {
          content: [
            {
              type: "text",
              text: `Synced remote skills: ${updated} updated, ${skills.length} checked, ${errors.length} errors.`,
            },
          ],
          structuredContent: {
            yourAgentId: requestInfo.agentId,
            success: true,
            message: `${updated} updated, ${skills.length} checked.`,
            updated,
            checked: skills.length,
            errors,
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
            updated: 0,
            checked: 0,
            errors: [message],
          },
        };
      }
    },
  );
};

// Import getDb for direct lastFetchedAt update
import { getDb } from "@/be/db";
