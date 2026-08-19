import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { getSkillById, getSkillFile } from "@/be/db";
import { createToolRegistrar, swarmToolOutputSchema, toolErr, toolOk } from "@/tools/utils";

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
      outputSchema: swarmToolOutputSchema({
        yourAgentId: z.string().optional(),
        file: z.looseObject({}).optional(),
      }),
    },
    async (args, requestInfo, _meta) => {
      const skill = await getSkillById(args.skillId);
      if (!skill) {
        return toolErr("Skill not found.", { data: { yourAgentId: requestInfo.agentId } });
      }

      let file = null;
      try {
        file = await getSkillFile(args.skillId, args.path);
      } catch (err) {
        const message = err instanceof Error ? err.message : "Invalid file path.";
        return toolErr(message, { data: { yourAgentId: requestInfo.agentId } });
      }

      if (!file) {
        return toolErr("Skill file not found.", { data: { yourAgentId: requestInfo.agentId } });
      }

      return toolOk(`Found skill file "${file.path}".`, {
        details: `Skill file "${skill.name}/${file.path}" (${file.mimeType}):\n\n${file.content}`,
        data: { yourAgentId: requestInfo.agentId, file },
      });
    },
  );
};
