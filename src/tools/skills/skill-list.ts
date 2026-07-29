import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { getAgentSkills, listSkills } from "@/be/db";
import { createToolRegistrar, swarmToolOutputSchema, toolErr, toolOk } from "@/tools/utils";

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

export const registerSkillListTool = (server: McpServer) => {
  createToolRegistrar(server)(
    "skill-list",
    {
      title: "List Skills",
      annotations: { destructiveHint: false },
      description: "List available skills with optional filters.",
      inputSchema: z.object({
        type: z.enum(["remote", "personal"]).optional().describe("Filter by type"),
        scope: z.enum(["global", "swarm", "agent"]).optional().describe("Filter by scope"),
        agentId: z.string().optional().describe("Filter by owning agent"),
        installedOnly: z
          .boolean()
          .optional()
          .describe("Only show skills installed for calling agent"),
        includeContent: z
          .boolean()
          .default(false)
          .optional()
          .describe("Include full content (default false)"),
      }),
      outputSchema: swarmToolOutputSchema({
        yourAgentId: z.string().optional(),
        skills: z.array(z.looseObject({})).optional(),
        total: z.number().optional(),
      }),
    },
    async (args, requestInfo, _meta) => {
      try {
        const skills =
          args.installedOnly && requestInfo.agentId
            ? getAgentSkills(requestInfo.agentId)
            : listSkills({
                type: args.type,
                scope: args.scope,
                ownerAgentId: args.agentId,
                includeContent: args.includeContent,
              });

        // Strip content if not requested
        const result = args.includeContent
          ? skills
          : skills.map(({ content: _content, ...rest }) => rest);

        return toolOk(`Found ${result.length} skill(s).`, {
          details: renderSkillList(result),
          data: { yourAgentId: requestInfo.agentId, skills: result, total: result.length },
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error";
        return toolErr(`Failed: ${message}`, {
          data: { yourAgentId: requestInfo.agentId, skills: [], total: 0 },
        });
      }
    },
  );
};
