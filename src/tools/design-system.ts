/**
 * `design-system-get` / `design-system-set`: the org design system that
 * restyles every designVersion 2 page without its own `theme`
 * (src/themes/design-system.ts). `design-system-set` is the only agent-facing
 * writer, so every value passes the theme importer's checks.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { resolveTaskAuditUserId } from "@/be/audit-user";
import { getAgentById } from "@/be/db";
import { getDesignSystem, saveDesignSystem } from "@/be/design-system";
import { can } from "@/rbac";
import { buildDesignSystem, DesignSystemError } from "@/themes/design-system";
import { createToolRegistrar, swarmToolOutputSchema, toolErr, toolOk } from "@/tools/utils";
import { DesignSystemInputSchema } from "@/types";

const outputSchema = swarmToolOutputSchema({
  status: z.string().optional(),
  designSystem: z.unknown().optional(),
  previous: z.unknown().optional(),
  invalidReason: z.string().optional(),
  ignoredTokens: z.array(z.string()).optional(),
  saved: z.boolean().optional(),
});

export const registerDesignSystemTools = (server: McpServer) => {
  const register = createToolRegistrar(server);

  register(
    "design-system-get",
    {
      title: "Get the org design system",
      description:
        'Returns the org design system that restyles every HTML page without its own theme. status is "none" (nobody asked yet), "declined" (the requester said no; do not ask again), "active", or "invalid" (the stored record fails validation and pages ignore it). previous is the value the last design-system-set replaced, for a one-step undo.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({}),
      outputSchema,
    },
    async () => {
      const { current, previous } = await getDesignSystem();
      return toolOk(`Design system status: ${current.status}.`, {
        data: {
          status: current.status,
          ...("record" in current ? { designSystem: current.record } : {}),
          ...("reason" in current ? { invalidReason: current.reason } : {}),
          ...("record" in previous ? { previous: previous.record } : {}),
        },
      });
    },
  );

  register(
    "design-system-set",
    {
      title: "Set the org design system",
      description:
        'Saves the org design system: a base preset plus token overrides, fonts, logo, mode lock and chart palette. Every HTML page without its own theme picks it up on its next view. Save only what the requester approved, after they saw a preview (the design-system-seed script builds one). To record a "no", pass status "declined". dryRun: true validates and returns the normalized record without saving. The replaced value is kept as previous (see design-system-get).',
      annotations: { destructiveHint: false },
      rbac: { permission: "design-system.write" },
      inputSchema: DesignSystemInputSchema.extend({
        dryRun: z
          .boolean()
          .optional()
          .describe("Validate and return the normalized record without saving."),
      }),
      outputSchema,
    },
    async ({ dryRun, ...input }, requestInfo) => {
      if (!requestInfo.agentId) return toolErr('Agent ID not found. Set the "X-Agent-ID" header.');
      const agent = await getAgentById(requestInfo.agentId);
      const decision = can({
        principal: { kind: "agent", agentId: requestInfo.agentId, isLead: agent?.isLead ?? false },
        verb: "design-system.write",
        source: "mcp",
      });
      if (!decision.allow) return toolErr(decision.reason);

      const userId = await resolveTaskAuditUserId(requestInfo.sourceTaskId, requestInfo.agentId);
      let built: ReturnType<typeof buildDesignSystem>;
      try {
        built = buildDesignSystem(input, { userId, agentId: requestInfo.agentId });
      } catch (err) {
        if (err instanceof DesignSystemError) return toolErr(err.message);
        throw err;
      }
      if (!dryRun) await saveDesignSystem(built.record);
      const { record, ignored } = built;
      return toolOk(
        `${dryRun ? "Validated" : "Saved"} ${record.status} design system (basePreset=${record.basePreset}, mode=${record.mode}).` +
          (ignored.length > 0 ? ` Ignored tokens: ${ignored.join(", ")}.` : ""),
        {
          data: {
            status: record.status,
            designSystem: record,
            saved: !dryRun,
            ...(ignored.length > 0 ? { ignoredTokens: ignored } : {}),
          },
        },
      );
    },
  );
};
