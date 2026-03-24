import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { getAgentSkills, listSkills } from "@/be/db";
import { createToolRegistrar } from "@/tools/utils";

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
      outputSchema: z.object({
        yourAgentId: z.string().uuid().optional(),
        success: z.boolean(),
        message: z.string(),
        skills: z.array(z.any()),
        total: z.number(),
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

        return {
          content: [{ type: "text", text: `Found ${result.length} skill(s).` }],
          structuredContent: {
            yourAgentId: requestInfo.agentId,
            success: true,
            message: `Found ${result.length} skill(s).`,
            skills: result,
            total: result.length,
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
            skills: [],
            total: 0,
          },
        };
      }
    },
  );
};
