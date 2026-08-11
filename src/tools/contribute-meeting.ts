/**
 * `contribute_to_meeting` MCP tool — capability-gated ("meetings"). Records
 * one contribution ("turn") for a meeting. This is how a participant satisfies
 * the attendance gate: their X-Agent-ID is the identity checked at conclude
 * time against the meeting's participant list.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { addMeetingContribution, getMeetingDetail, MeetingConclusionError } from "@/be/db";
import { createToolRegistrar, swarmToolOutputSchema, toolErr, toolOk } from "@/tools/utils";

export const registerContributeMeetingTool = (server: McpServer) => {
  createToolRegistrar(server)(
    "contribute_to_meeting",
    {
      title: "Contribute to a meeting",
      description:
        "Record your turn in an open meeting. Your X-Agent-ID is logged as the " +
        "speaker and counts toward the attendance gate if you are a listed " +
        "participant. Non-participants may also contribute as observers.",
      annotations: { destructiveHint: false },
      inputSchema: z.object({
        meetingId: z.string().min(1).describe("The meeting to contribute to."),
        content: z.string().min(1).describe("Your contribution text for this round."),
        round: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe("Optional round number (defaults to 1)."),
      }),
      outputSchema: swarmToolOutputSchema({
        yourAgentId: z.string().optional(),
        meetingId: z.string().optional(),
        contributionId: z.string().optional(),
        fullyAttended: z.boolean().optional(),
        pendingParticipants: z.array(z.string()).optional(),
      }),
    },
    async (input, requestInfo, _meta) => {
      if (!requestInfo.agentId) {
        return toolErr("Agent ID required. Set the X-Agent-ID header on the MCP request.");
      }
      try {
        const contribution = addMeetingContribution({
          meetingId: input.meetingId,
          agentId: requestInfo.agentId,
          content: input.content,
          round: input.round,
        });
        const detail = getMeetingDetail(input.meetingId);
        const pending = (detail?.attendance ?? [])
          .filter((a) => !a.present)
          .map((a) => a.participant);
        return toolOk(
          detail?.fullyAttended
            ? "Contribution recorded. All participants have now contributed — ready to conclude."
            : `Contribution recorded. Still waiting on: ${pending.join(", ") || "(none)"}.`,
          {
            data: {
              yourAgentId: requestInfo.agentId,
              meetingId: input.meetingId,
              contributionId: contribution.id,
              fullyAttended: detail?.fullyAttended ?? false,
              pendingParticipants: pending,
            },
          },
        );
      } catch (err) {
        if (err instanceof MeetingConclusionError) {
          return toolErr(err.message);
        }
        const detail = err instanceof Error ? err.message : String(err);
        return toolErr(`Failed to record contribution: ${detail}`);
      }
    },
  );
};
