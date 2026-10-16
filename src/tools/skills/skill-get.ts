import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { getSkillById, getSkillByName } from "@/be/db";
import { resolveSwarmSkillByName } from "@/be/db/skill-name-resolution";
import { createToolRegistrar, swarmToolOutputSchema, toolErr, toolOk } from "@/tools/utils";

export const registerSkillGetTool = (server: McpServer) => {
  createToolRegistrar(server)(
    "skill-get",
    {
      title: "Get Skill",
      annotations: { destructiveHint: false },
      description:
        "Get full skill content by ID or name. Name resolution checks agent scope first, then swarm, then global. In swarm scope the ownerless skill wins, then your own, then the only agent-owned one; when several other agents own that name, it errors with their IDs: pass skillId instead.",
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
        skill = await getSkillById(args.skillId);
      } else if (args.name) {
        // Precedence: agent (personal) → swarm → global
        if (requestInfo.agentId) {
          skill = await getSkillByName(args.name, "agent", requestInfo.agentId);
        }
        if (!skill) {
          const swarm = await resolveSwarmSkillByName(args.name, requestInfo.agentId);
          if (swarm.kind === "ambiguous") {
            return toolErr(
              `Skill name "${args.name}" matches ${swarm.skillIds.length} swarm skills owned by other agents: ${swarm.skillIds.join(", ")}. Call skill-get with skillId instead.`,
              { data: { yourAgentId: requestInfo.agentId } },
            );
          }
          if (swarm.kind === "found") skill = await getSkillById(swarm.skillId);
        }
        if (!skill) skill = await getSkillByName(args.name, "global");
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
