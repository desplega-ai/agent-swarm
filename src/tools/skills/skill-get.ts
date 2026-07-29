import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { getSkillById, getSkillByName } from "@/be/db";
import { createToolRegistrar, swarmToolOutputSchema, toolErr, toolOk } from "@/tools/utils";

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
      outputSchema: swarmToolOutputSchema({
        yourAgentId: z.string().optional(),
        skill: z.looseObject({}).optional(),
      }),
    },
    async (args, requestInfo, _meta) => {
      if (!args.skillId && !args.name) {
        return toolErr("Provide skillId or name.", { data: { yourAgentId: requestInfo.agentId } });
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
        return toolErr("Skill not found.", { data: { yourAgentId: requestInfo.agentId } });
      }

      return toolOk(`Found skill "${skill.name}".`, {
        details: `Skill "${skill.name}" (${skill.id}):\n\n${skill.content}`,
        data: { yourAgentId: requestInfo.agentId, skill },
      });
    },
  );
};
