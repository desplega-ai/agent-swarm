import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { listModelProfiles } from "@/be/db/model-profiles";
import { createToolRegistrar, swarmToolOutputSchema, toolOk } from "@/tools/utils";
import { ProviderNameSchema } from "@/types";

export const registerListModelProfilesTool = (server: McpServer) => {
  createToolRegistrar(server)(
    "list-model-profiles",
    {
      title: "List Model Profiles",
      description:
        "List model profiles: named harness + model + effort combinations. Pass a profile's name as `profile` on send-task to run that task on it, or set it as an agent's default through PATCH /api/agents/{id}/runtime. A profile runs only on its own harness. `fallbacks` are the same-harness profiles a task hops to, in order, when a provider error (rate limit, seat, overload, auth, empty key pool) ends it. Filter by `harness` to see what an agent on that harness can run.",
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        harness: ProviderNameSchema.optional().describe(
          "Only profiles for this harness (claude, codex, pi, ...).",
        ),
      }),
      outputSchema: swarmToolOutputSchema({
        profiles: z
          .array(
            z.looseObject({
              name: z.string().optional(),
              harness: z.string().optional(),
              model: z.string().optional(),
              effort: z.string().nullable().optional(),
              description: z.string().nullable().optional(),
              fallbacks: z.array(z.string()).optional(),
            }),
          )
          .optional(),
      }),
    },
    async ({ harness }) => {
      const profiles = await listModelProfiles({ harness });
      const lines = profiles.map(
        (p) =>
          `${p.name}: ${p.harness} / ${p.model}${p.effort ? ` / effort ${p.effort}` : ""}${p.fallbacks.length > 0 ? ` → fallbacks ${p.fallbacks.join(", ")}` : ""}${p.description ? ` (${p.description})` : ""}`,
      );
      return toolOk(`${profiles.length} model profile(s)${harness ? ` for ${harness}` : ""}.`, {
        details: lines.join("\n"),
        data: {
          profiles: profiles.map((p) => ({
            name: p.name,
            harness: p.harness,
            model: p.model,
            effort: p.effort,
            description: p.description,
            fallbacks: p.fallbacks,
          })),
        },
      });
    },
  );
};
