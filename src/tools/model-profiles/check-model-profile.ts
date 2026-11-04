import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { getAgentById } from "@/be/db";
import { checkProfileForAgent } from "@/be/model-profile-check";
import { createToolRegistrar, swarmToolOutputSchema, toolErr, toolOk } from "@/tools/utils";

export const registerCheckModelProfileTool = (server: McpServer) => {
  createToolRegistrar(server)(
    "check-model-profile",
    {
      title: "Check Model Profile",
      description:
        "Check whether an agent can run a model profile before you pass it as `profile` or set it as the agent's default. Judges the harness, the model, the agent's credential report and the profile's credential allowlist. Each row is pass, warn, fail or unverified; only a fail blocks.",
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        agentId: z.string().min(1).describe("The agent that would run the profile."),
        profile: z.string().min(1).describe("Model profile name (see list-model-profiles)."),
      }),
      outputSchema: swarmToolOutputSchema({
        result: z
          .looseObject({
            agentId: z.string().optional(),
            ok: z.boolean().optional(),
            profiles: z
              .array(
                z.looseObject({
                  name: z.string().optional(),
                  ok: z.boolean().optional(),
                  checks: z
                    .array(
                      z.looseObject({
                        check: z.string().optional(),
                        state: z.string().optional(),
                        detail: z.string().optional(),
                      }),
                    )
                    .optional(),
                }),
              )
              .optional(),
          })
          .optional(),
      }),
    },
    async ({ agentId, profile }) => {
      if (!(await getAgentById(agentId))) return toolErr(`Agent ${agentId} not found.`);
      const result = await checkProfileForAgent(agentId, profile);
      if (!result) {
        return toolErr(
          `Unknown model profile "${profile}". List profiles with list-model-profiles.`,
        );
      }
      const primary = result.profiles[0];
      const lines = (primary?.checks ?? []).map(
        (row) => `${row.check}: ${row.state}${row.detail ? ` (${row.detail})` : ""}`,
      );
      return toolOk(
        `Agent ${agentId} ${result.ok ? "can" : "cannot"} run model profile "${profile}".`,
        { details: lines.join("\n"), data: { result } },
      );
    },
  );
};
