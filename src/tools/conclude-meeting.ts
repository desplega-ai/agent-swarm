/**
 * `conclude_meeting` MCP tool — capability-gated ("meetings"). Closes a
 * meeting with an actionable conclusion. HARD GATE (enforced in
 * `concludeMeeting`): the meeting must be open, every participant must have
 * contributed, and the conclusion must be non-empty. This is what makes "we
 * talked but never decided" structurally impossible.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { concludeMeeting, MeetingConclusionError } from "@/be/db";
import { createToolRegistrar, swarmToolOutputSchema, toolErr, toolOk } from "@/tools/utils";

export const registerConcludeMeetingTool = (server: McpServer) => {
  createToolRegistrar(server)(
    "conclude_meeting",
    {
      title: "Conclude a meeting",
      description:
        "Record the meeting's actionable conclusion and close it. Rejected " +
        "unless every listed participant has contributed and the conclusion is " +
        "non-empty — the attendance + conclusion gate.",
      annotations: { destructiveHint: false },
      inputSchema: z.object({
        meetingId: z.string().min(1).describe("The meeting to conclude."),
        conclusion: z
          .string()
          .min(1)
          .describe("The decision / outcome / action items. Must be non-empty."),
      }),
      outputSchema: swarmToolOutputSchema({
        yourAgentId: z.string().optional(),
        id: z.string().optional(),
        status: z.string().optional(),
        missingParticipants: z.array(z.string()).optional(),
      }),
    },
    async (input, requestInfo, _meta) => {
      if (!requestInfo.agentId) {
        return toolErr("Agent ID required. Set the X-Agent-ID header on the MCP request.");
      }
      try {
        const detail = concludeMeeting({
          meetingId: input.meetingId,
          agentId: requestInfo.agentId,
          conclusion: input.conclusion,
        });
        return toolOk(`Meeting "${detail.title}" concluded.`, {
          details: detail.conclusion,
          data: {
            yourAgentId: requestInfo.agentId,
            id: detail.id,
            status: detail.status,
          },
        });
      } catch (err) {
        if (err instanceof MeetingConclusionError) {
          return toolErr(err.message, {
            data: {
              yourAgentId: requestInfo.agentId,
              id: input.meetingId,
              missingParticipants: err.missingParticipants,
            },
          });
        }
        const detail = err instanceof Error ? err.message : String(err);
        return toolErr(`Failed to conclude meeting: ${detail}`);
      }
    },
  );
};
