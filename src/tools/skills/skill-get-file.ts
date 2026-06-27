import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createToolRegistrar } from "@swarm/mcp-tool";
import { getSkillById, getSkillFile } from "@swarm/storage";
import * as z from "zod";

export const registerSkillGetFileTool = (server: McpServer) => {
  createToolRegistrar(server)(
    "skill-get-file",
    {
      title: "Get Skill File",
      annotations: { destructiveHint: false },
      description:
        "Fetch a bundled reference file from a complex skill by skillId and relative path. Use this when the file is not available on disk.",
      inputSchema: z.object({
        skillId: z.string().describe("Skill ID"),
        path: z.string().describe("Relative path, e.g. references/animations.md"),
      }),
      outputSchema: z.object({
        yourAgentId: z.string().uuid().optional(),
        success: z.boolean(),
        message: z.string(),
        file: z.any().optional(),
      }),
    },
    async (args, requestInfo, _meta) => {
      const skill = getSkillById(args.skillId);
      if (!skill) {
        return {
          content: [{ type: "text", text: "Skill not found." }],
          structuredContent: {
            yourAgentId: requestInfo.agentId,
            success: false,
            message: "Skill not found.",
          },
        };
      }

      let file = null;
      try {
        file = getSkillFile(args.skillId, args.path);
      } catch (err) {
        const message = err instanceof Error ? err.message : "Invalid file path.";
        return {
          content: [{ type: "text", text: message }],
          structuredContent: {
            yourAgentId: requestInfo.agentId,
            success: false,
            message,
          },
        };
      }

      if (!file) {
        return {
          content: [{ type: "text", text: "Skill file not found." }],
          structuredContent: {
            yourAgentId: requestInfo.agentId,
            success: false,
            message: "Skill file not found.",
          },
        };
      }

      return {
        content: [
          {
            type: "text",
            text: `Skill file "${skill.name}/${file.path}" (${file.mimeType}):\n\n${file.content}`,
          },
        ],
        structuredContent: {
          yourAgentId: requestInfo.agentId,
          success: true,
          message: `Found skill file "${file.path}".`,
          file,
        },
      };
    },
  );
};
