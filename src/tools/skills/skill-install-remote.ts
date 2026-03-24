import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { createSkill, getAgentById } from "@/be/db";
import { parseSkillContent } from "@/be/skill-parser";
import { createToolRegistrar } from "@/tools/utils";

export const registerSkillInstallRemoteTool = (server: McpServer) => {
  createToolRegistrar(server)(
    "skill-install-remote",
    {
      title: "Install Remote Skill",
      annotations: { destructiveHint: false },
      description:
        "Fetch and install a remote skill from a GitHub repository. Fetches SKILL.md via GitHub raw content API.",
      inputSchema: z.object({
        sourceRepo: z.string().describe('GitHub repo (e.g. "vercel-labs/skills")'),
        sourcePath: z.string().optional().describe('Path within repo (e.g. "skills/nextjs")'),
        scope: z
          .enum(["global", "swarm"])
          .default("global")
          .optional()
          .describe("Scope for the installed skill"),
        isComplex: z
          .boolean()
          .default(false)
          .optional()
          .describe("If true, registers for npx install (metadata only)"),
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

      // Only leads can install global/swarm remote skills
      const agent = getAgentById(requestInfo.agentId);
      if (!agent?.isLead) {
        return {
          content: [{ type: "text", text: "Only lead agents can install remote skills." }],
          structuredContent: {
            yourAgentId: requestInfo.agentId,
            success: false,
            message: "Only lead agents can install remote skills.",
          },
        };
      }

      try {
        const branch = "main";
        const filePath = args.sourcePath ? `${args.sourcePath}/SKILL.md` : "SKILL.md";
        const rawUrl = `https://raw.githubusercontent.com/${args.sourceRepo}/${branch}/${filePath}`;

        let content = "";
        let sourceHash: string | null = null;

        if (!args.isComplex) {
          // Fetch SKILL.md content
          const response = await fetch(rawUrl);
          if (!response.ok) {
            return {
              content: [
                {
                  type: "text",
                  text: `Failed to fetch SKILL.md from ${rawUrl}: ${response.status}`,
                },
              ],
              structuredContent: {
                yourAgentId: requestInfo.agentId,
                success: false,
                message: `Failed to fetch: HTTP ${response.status}`,
              },
            };
          }
          content = await response.text();
          sourceHash = crypto.randomUUID(); // Simple hash placeholder
        }

        let name: string;
        let description: string;
        let parsedMeta: Partial<ReturnType<typeof parseSkillContent>> = {};

        if (content) {
          const parsed = parseSkillContent(content);
          name = parsed.name;
          description = parsed.description;
          parsedMeta = parsed;
        } else {
          // Complex skill — use repo/path as name
          name = args.sourcePath
            ? args.sourcePath.split("/").pop() || args.sourceRepo
            : args.sourceRepo.split("/").pop() || args.sourceRepo;
          description = `Complex skill from ${args.sourceRepo}`;
        }

        const skill = createSkill({
          name,
          description,
          content,
          type: "remote",
          scope: args.scope ?? "global",
          sourceUrl: rawUrl,
          sourceRepo: args.sourceRepo,
          sourcePath: args.sourcePath,
          sourceBranch: branch,
          sourceHash: sourceHash ?? undefined,
          isComplex: args.isComplex ?? false,
          allowedTools: parsedMeta.allowedTools,
          model: parsedMeta.model,
          effort: parsedMeta.effort,
          context: parsedMeta.context,
          agent: parsedMeta.agent,
          disableModelInvocation: parsedMeta.disableModelInvocation,
          userInvocable: parsedMeta.userInvocable,
        });

        return {
          content: [
            {
              type: "text",
              text: `Installed remote skill "${skill.name}" from ${args.sourceRepo}`,
            },
          ],
          structuredContent: {
            yourAgentId: requestInfo.agentId,
            success: true,
            message: `Installed remote skill "${skill.name}".`,
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
