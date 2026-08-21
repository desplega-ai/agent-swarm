import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { getAgentById, getContextVersionHistory } from "@/be/db";
import { can } from "@/rbac";
import { createToolRegistrar, swarmToolOutputSchema, toolErr, toolOk } from "@/tools/utils";
import type { VersionableField } from "@/types";

export const registerContextHistoryTool = (server: McpServer) => {
  createToolRegistrar(server)(
    "context-history",
    {
      title: "Context History",
      description:
        "View version history for an agent's context files (soulMd, identityMd, toolsMd, claudeMd, setupScript). Returns metadata for each version without full content.",
      annotations: { readOnlyHint: true },

      inputSchema: z.object({
        agentId: z
          .string()
          .optional()
          .describe("Agent ID to query. Default: your own agent. Lead can query any agent."),
        field: z
          .enum(["soulMd", "identityMd", "toolsMd", "claudeMd", "setupScript"])
          .optional()
          .describe("Filter by specific field. Omit for all fields."),
        limit: z
          .number()
          .int()
          .min(1)
          .max(100)
          .optional()
          .describe("Max versions to return (default: 10)."),
      }),
      outputSchema: swarmToolOutputSchema({
        yourAgentId: z.string().optional(),
        versions: z
          .array(
            z.looseObject({
              id: z.string().optional(),
              field: z.string().optional(),
              version: z.number().optional(),
              changeSource: z.string().optional(),
              changedByAgentId: z.string().nullable().optional(),
              changeReason: z.string().nullable().optional(),
              contentLength: z.number().optional(),
              createdAt: z.string().optional(),
            }),
          )
          .optional(),
      }),
    },
    async ({ agentId, field, limit }, requestInfo, _meta) => {
      if (!requestInfo.agentId) {
        return toolErr('Agent ID not found. Set the "X-Agent-ID" header.');
      }

      const targetAgentId = agentId ?? requestInfo.agentId;

      // Verify target agent exists
      const targetAgent = await getAgentById(targetAgentId);
      if (!targetAgent) {
        return toolErr("Agent not found.", { data: { yourAgentId: requestInfo.agentId } });
      }

      // Access control: agents can see their own history, lead can see any
      if (targetAgentId !== requestInfo.agentId) {
        const callerAgent = await getAgentById(requestInfo.agentId);
        const decision = can({
          principal: {
            kind: "agent",
            agentId: requestInfo.agentId,
            isLead: callerAgent?.isLead ?? false,
          },
          verb: "agent.context.read.any",
          resource: { kind: "agent", agentId: targetAgentId },
          source: "mcp",
        });
        if (!decision.allow) {
          return toolErr(
            "Permission denied. Only the lead can view other agents' context history.",
            { data: { yourAgentId: requestInfo.agentId } },
          );
        }
      }

      const versions = await getContextVersionHistory({
        agentId: targetAgentId,
        field: field as VersionableField | undefined,
        limit: limit ?? 10,
      });

      const versionSummaries = versions.map((v) => ({
        id: v.id,
        field: v.field,
        version: v.version,
        changeSource: v.changeSource,
        changedByAgentId: v.changedByAgentId,
        changeReason: v.changeReason,
        contentLength: v.content.length,
        createdAt: v.createdAt,
      }));

      const details =
        versions.length === 0
          ? `No context versions found for agent ${targetAgentId}${field ? ` field ${field}` : ""}.`
          : versionSummaries
              .map(
                (v) =>
                  `v${v.version} ${v.field} [${v.changeSource}] ${v.createdAt} (${v.contentLength} chars)${v.changeReason ? ` — ${v.changeReason}` : ""}`,
              )
              .join("\n");

      return toolOk(`Found ${versions.length} version(s).`, {
        details,
        data: { yourAgentId: requestInfo.agentId, versions: versionSummaries },
      });
    },
  );
};
