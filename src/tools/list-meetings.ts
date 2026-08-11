/**
 * `list_meetings` MCP tool — capability-gated ("meetings"). Lists meetings,
 * optionally filtered by status.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { listMeetings } from "@/be/db";
import { createToolRegistrar, swarmToolOutputSchema, toolOk } from "@/tools/utils";
import { MeetingStatusSchema } from "@/types";

export const registerListMeetingsTool = (server: McpServer) => {
  createToolRegistrar(server)(
    "list_meetings",
    {
      title: "List meetings",
      description: "List meetings, most-recently-updated first. Filter by status if given.",
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        status: MeetingStatusSchema.optional().describe("Filter: open | concluded | cancelled."),
        mineOnly: z
          .boolean()
          .optional()
          .describe("Only meetings you created (matched on your X-Agent-ID)."),
        limit: z.number().int().min(1).max(200).optional().describe("Max rows (default 50)."),
      }),
      outputSchema: swarmToolOutputSchema({
        count: z.number().optional(),
        meetings: z
          .array(
            z.object({
              id: z.string(),
              title: z.string(),
              status: z.string(),
              participantCount: z.number(),
              updatedAt: z.string(),
            }),
          )
          .optional(),
      }),
    },
    async (input, requestInfo, _meta) => {
      const meetings = listMeetings({
        status: input.status,
        agentId: input.mineOnly ? requestInfo.agentId : undefined,
        limit: input.limit ?? 50,
      });
      const rows = meetings.map((m) => ({
        id: m.id,
        title: m.title,
        status: m.status,
        participantCount: m.participants.length,
        updatedAt: m.updatedAt,
      }));
      return toolOk(`${rows.length} meeting(s).`, {
        data: { count: rows.length, meetings: rows },
      });
    },
  );
};
