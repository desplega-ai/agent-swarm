import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { createSkill, getAgentById } from "@/be/db";
import { parseSkillContent } from "@/be/skill-parser";
import { can } from "@/rbac";
import { createToolRegistrar, swarmToolOutputSchema, toolErr, toolOk } from "@/tools/utils";

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
      outputSchema: swarmToolOutputSchema({
        yourAgentId: z.string().optional(),
        skill: z.looseObject({}).optional(),
      }),
    },
    async (args, requestInfo, _meta) => {
      if (!requestInfo.agentId) {
        return toolErr("Agent ID not found.");
      }

      // Only leads can install global/swarm remote skills
      const agent = getAgentById(requestInfo.agentId);
      const decision = can({
        principal: {
          kind: "agent",
          agentId: requestInfo.agentId,
          isLead: agent?.isLead ?? false,
        },
        verb: "skill.install.global",
        resource: { kind: "none" },
        source: "mcp",
      });
      if (!decision.allow) {
        return toolErr("Only lead agents can install remote skills.", {
          data: { yourAgentId: requestInfo.agentId },
        });
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
            return toolErr(`Failed to fetch: HTTP ${response.status}`, {
              details: `Failed to fetch SKILL.md from ${rawUrl}: ${response.status}`,
              data: { yourAgentId: requestInfo.agentId },
            });
          }
          content = await response.text();
          sourceHash = new Bun.CryptoHasher("sha256").update(content).digest("hex");
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

        return toolOk(`Installed remote skill "${skill.name}".`, {
          details: `Installed remote skill "${skill.name}" from ${args.sourceRepo}`,
          data: { yourAgentId: requestInfo.agentId, skill },
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error";
        return toolErr(`Failed: ${message}`, { data: { yourAgentId: requestInfo.agentId } });
      }
    },
  );
};
