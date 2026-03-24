import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { getSkillById, getSkillByName } from "@/be/db";
import { createToolRegistrar } from "@/tools/utils";

export const registerSkillGetTool = (server: McpServer) => {
  createToolRegistrar(server)(
    "skill-get",
    {
      title: "Get Skill",
      annotations: { destructiveHint: false },
      description:
        "Get full skill content by ID or name. Name resolution checks agent scope first, then swarm, then global.",
      inputSchema: z.object({
        skillId: z.string().optional().describe("Skill ID"),
        name: z.string().optional().describe("Skill name (resolved with precedence)"),
      }),
      outputSchema: z.object({
        yourAgentId: z.string().uuid().optional(),
        success: z.boolean(),
        message: z.string(),
        skill: z.any().optional(),
      }),
    },
    async (args, requestInfo, _meta) => {
      if (!args.skillId && !args.name) {
        return {
          content: [{ type: "text", text: "Provide skillId or name." }],
          structuredContent: {
            yourAgentId: requestInfo.agentId,
            success: false,
            message: "Provide skillId or name.",
          },
        };
      }

      let skill = null;

      if (args.skillId) {
        skill = getSkillById(args.skillId);
      } else if (args.name && requestInfo.agentId) {
        // Precedence: agent (personal) → swarm → global
        skill =
          getSkillByName(args.name, "agent", requestInfo.agentId) ||
          getSkillByName(args.name, "swarm") ||
          getSkillByName(args.name, "global");
      } else if (args.name) {
        skill = getSkillByName(args.name, "swarm") || getSkillByName(args.name, "global");
      }

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

      return {
        content: [
          { type: "text", text: `Skill "${skill.name}" (${skill.id}):\n\n${skill.content}` },
        ],
        structuredContent: {
          yourAgentId: requestInfo.agentId,
          success: true,
          message: `Found skill "${skill.name}".`,
          skill,
        },
      };
    },
  );
};
