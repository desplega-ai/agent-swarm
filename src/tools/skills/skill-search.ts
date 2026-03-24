import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { searchSkills } from "@/be/db";
import { createToolRegistrar } from "@/tools/utils";

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
      outputSchema: z.object({
        yourAgentId: z.string().uuid().optional(),
        success: z.boolean(),
        message: z.string(),
        skills: z.array(z.any()),
        total: z.number(),
      }),
    },
    async (args, requestInfo, _meta) => {
      const skills = searchSkills(args.query, args.limit ?? 20);
      const result = skills.map(({ content: _content, ...rest }) => rest);

      return {
        content: [
          { type: "text", text: `Found ${result.length} skill(s) matching "${args.query}".` },
        ],
        structuredContent: {
          yourAgentId: requestInfo.agentId,
          success: true,
          message: `Found ${result.length} skill(s).`,
          skills: result,
          total: result.length,
        },
      };
    },
  );
};
