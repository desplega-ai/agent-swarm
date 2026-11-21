import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { resolveTaskAuditUserId } from "@/be/audit-user";
import { getAgentById, getSkillById, listSkills, updateSkill } from "@/be/db";
import { parseSkillContent } from "@/be/skill-parser";
import { can } from "@/rbac";
import { createToolRegistrar, swarmToolOutputSchema, toolErr, toolOk } from "@/tools/utils";

function contentHash(content: string): string {
  const hash = new Bun.CryptoHasher("sha256").update(content).digest("hex");
  return hash;
}

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
      outputSchema: swarmToolOutputSchema({
        yourAgentId: z.string().optional(),
        updated: z.number().optional(),
        checked: z.number().optional(),
        errors: z.array(z.string()).optional(),
      }),
    },
    async (args, requestInfo, _meta) => {
      try {
        // Same gate as POST /api/skills/sync-remote: it rewrites skill content, so it needs the
        // right to update the target skill (its owner, or a lead); with no skillId, a lead.
        const target = args.skillId ? await getSkillById(args.skillId) : null;
        const caller = requestInfo.agentId ? await getAgentById(requestInfo.agentId) : null;
        const decision = can({
          principal: {
            kind: "agent",
            agentId: requestInfo.agentId ?? "",
            isLead: caller?.isLead ?? false,
          },
          verb: "skill.update.any",
          resource: {
            kind: "owned",
            ownerAgentId: target?.ownerAgentId ?? null,
            scope: target?.scope,
          },
          source: "mcp",
        });
        if (!decision.allow) {
          return toolErr(
            "Forbidden: syncing remote skills needs the lead agent, or the skill's owner",
            { data: { yourAgentId: requestInfo.agentId } },
          );
        }

        const skills = args.skillId
          ? target && target.type === "remote"
            ? [target]
            : []
          : await listSkills({ type: "remote" });

        let updated = 0;
        const errors: string[] = [];
        // A content change is attributed to the caller; a lastFetchedAt-only
        // touch is a fetch, not an edit, and leaves the audit pair alone.
        const updatedBy = await resolveTaskAuditUserId(
          requestInfo.auditSourceTaskId,
          requestInfo.agentId,
        );

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
            const newHash = contentHash(newContent);
            const now = new Date().toISOString();

            if (args.force || newHash !== skill.sourceHash) {
              const parsed = parseSkillContent(newContent);
              await updateSkill(skill.id, {
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
                sourceHash: newHash,
                lastFetchedAt: now,
                updatedByAgentId: requestInfo.agentId ?? null,
                updatedBy,
              });
              updated++;
            } else {
              // Content unchanged — still update lastFetchedAt
              await updateSkill(skill.id, { lastFetchedAt: now });
            }
          } catch (err) {
            errors.push(`${skill.name}: ${err instanceof Error ? err.message : "Unknown error"}`);
          }
        }

        return toolOk(`${updated} updated, ${skills.length} checked.`, {
          details: `Synced remote skills: ${updated} updated, ${skills.length} checked, ${errors.length} errors.`,
          data: {
            yourAgentId: requestInfo.agentId,
            updated,
            checked: skills.length,
            errors,
          },
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error";
        return toolErr(`Failed: ${message}`, {
          data: {
            yourAgentId: requestInfo.agentId,
            updated: 0,
            checked: 0,
            errors: [message],
          },
        });
      }
    },
  );
};
