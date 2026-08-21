import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { searchSkills } from "@/be/db";
import { createToolRegistrar, swarmToolOutputSchema, toolOk } from "@/tools/utils";

function renderSkillList(
  skills: Array<{ name?: unknown; description?: unknown }>,
): string | undefined {
  if (skills.length === 0) return undefined;
  return skills
    .map((skill) => {
      const description =
        typeof skill.description === "string" && skill.description ? ` — ${skill.description}` : "";
      return `- ${String(skill.name ?? "?")}${description}`;
    })
    .join("\n");
}

export const registerSkillSearchTool = (server: McpServer) => {
  createToolRegistrar(server)(
    "skill-search",
    {
      title: "Search Skills",
      annotations: { destructiveHint: false },
      description: "Search skills by keyword (name and description).",
      inputSchema: z.object({
        query: z.string().min(1).describe("Search query"),
        limit: z.number().int().min(1).max(100).default(20).optional(),
      }),
      outputSchema: swarmToolOutputSchema({
        yourAgentId: z.string().optional(),
        skills: z.array(z.looseObject({})).optional(),
        total: z.number().optional(),
      }),
    },
    async (args, requestInfo, _meta) => {
      const skills = await searchSkills(args.query, args.limit ?? 20);
      const result = skills.map(({ content: _content, ...rest }) => rest);

      return toolOk(`Found ${result.length} skill(s) matching "${args.query}".`, {
        details: renderSkillList(result),
        data: { yourAgentId: requestInfo.agentId, skills: result, total: result.length },
      });
    },
  );
};
