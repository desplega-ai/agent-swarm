import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { getAgentById, getContextVersionHistory } from "@/be/db";
import { createToolRegistrar } from "@/tools/utils";
import type { VersionableField } from "@/types";

export const registerContextHistoryTool = (server: McpServer) => {
  createToolRegistrar(server)(
    "context-history",
    {
      title: "Context History",
      description:
        "View version history for an agent's context files (soulMd, identityMd, toolsMd, claudeMd, setupScript). Returns metadata for each version without full content.",
      inputSchema: z.object({
        agentId: z
          .string()
          .uuid()
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
      outputSchema: z.object({
        yourAgentId: z.string().uuid().optional(),
        success: z.boolean(),
        message: z.string(),
        versions: z
          .array(
            z.object({
              id: z.string().uuid(),
              field: z.string(),
              version: z.number(),
              changeSource: z.string(),
              changedByAgentId: z.string().uuid().nullable(),
              changeReason: z.string().nullable(),
              contentLength: z.number(),
              createdAt: z.string(),
            }),
          )
          .optional(),
      }),
    },
    async ({ agentId, field, limit }, requestInfo, _meta) => {
      if (!requestInfo.agentId) {
        return {
          content: [{ type: "text", text: 'Agent ID not found. Set the "X-Agent-ID" header.' }],
          structuredContent: {
            success: false,
            message: 'Agent ID not found. Set the "X-Agent-ID" header.',
          },
        };
      }

      const targetAgentId = agentId ?? requestInfo.agentId;

      // Verify target agent exists
      const targetAgent = getAgentById(targetAgentId);
      if (!targetAgent) {
        return {
          content: [{ type: "text", text: "Agent not found." }],
          structuredContent: {
            yourAgentId: requestInfo.agentId,
            success: false,
            message: "Agent not found.",
          },
        };
      }

      // Access control: agents can see their own history, lead can see any
      if (targetAgentId !== requestInfo.agentId) {
        const callerAgent = getAgentById(requestInfo.agentId);
        if (!callerAgent?.isLead) {
          return {
            content: [
              {
                type: "text",
                text: "Permission denied. Only the lead can view other agents' context history.",
              },
            ],
            structuredContent: {
              yourAgentId: requestInfo.agentId,
              success: false,
              message: "Permission denied. Only the lead can view other agents' context history.",
            },
          };
        }
      }

      const versions = getContextVersionHistory({
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

      const text =
        versions.length === 0
          ? `No context versions found for agent ${targetAgentId}${field ? ` field ${field}` : ""}.`
          : versionSummaries
              .map(
                (v) =>
                  `v${v.version} ${v.field} [${v.changeSource}] ${v.createdAt} (${v.contentLength} chars)${v.changeReason ? ` — ${v.changeReason}` : ""}`,
              )
              .join("\n");

      return {
        content: [{ type: "text", text }],
        structuredContent: {
          yourAgentId: requestInfo.agentId,
          success: true,
          message: `Found ${versions.length} version(s).`,
          versions: versionSummaries,
        },
      };
    },
  );
};
