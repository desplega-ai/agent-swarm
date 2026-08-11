/**
 * `get_meeting` MCP tool — capability-gated ("meetings"). Reads a meeting with
 * its contributions and computed per-participant attendance.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { getMeetingDetail } from "@/be/db";
import { createToolRegistrar, swarmToolOutputSchema, toolErr, toolOk } from "@/tools/utils";
import { MeetingAttendanceSchema, MeetingContributionSchema } from "@/types";

export const registerGetMeetingTool = (server: McpServer) => {
  createToolRegistrar(server)(
    "get_meeting",
    {
      title: "Get a meeting",
      description:
        "Read a meeting's agenda, status, conclusion, contributions, and " +
        "per-participant attendance (who has spoken vs who is still pending).",
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        meetingId: z.string().min(1).describe("The meeting id."),
      }),
      outputSchema: swarmToolOutputSchema({
        id: z.string().optional(),
        title: z.string().optional(),
        agenda: z.string().optional(),
        status: z.string().optional(),
        conclusion: z.string().optional(),
        fullyAttended: z.boolean().optional(),
        participants: z.array(z.string()).optional(),
        attendance: z.array(MeetingAttendanceSchema).optional(),
        contributions: z.array(MeetingContributionSchema).optional(),
      }),
    },
    async (input, _requestInfo, _meta) => {
      const detail = getMeetingDetail(input.meetingId);
      if (!detail) {
        return toolErr(`Meeting ${input.meetingId} not found.`);
      }
      const pending = detail.attendance.filter((a) => !a.present).map((a) => a.participant);
      return toolOk(
        `Meeting "${detail.title}" (${detail.status}) — ${detail.contributions.length} contribution(s), ` +
          `${detail.fullyAttended ? "fully attended" : `pending: ${pending.join(", ")}`}.`,
        {
          data: {
            id: detail.id,
            title: detail.title,
            agenda: detail.agenda,
            status: detail.status,
            conclusion: detail.conclusion,
            fullyAttended: detail.fullyAttended,
            participants: detail.participants,
            attendance: detail.attendance,
            contributions: detail.contributions,
          },
        },
      );
    },
  );
};
