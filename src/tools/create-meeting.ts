/**
 * `create_meeting` MCP tool — capability-gated ("meetings"). Opens a
 * structured, gated multi-agent decision record. The meeting can only be
 * concluded once every listed participant has contributed AND an actionable
 * conclusion is supplied (see `conclude_meeting`).
 *
 * No silent auto-spawn: this tool creates the record and returns a
 * dispatch_plan the leader uses to actually bring participants in (via
 * send-task / delegate). Ported (concept) from CronusL-1141/AI-company.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { createMeeting } from "@/be/db";
import { getMeetingTemplate, MEETING_TEMPLATE_KEYS } from "@/meetings/templates";
import { createToolRegistrar, swarmToolOutputSchema, toolErr, toolOk } from "@/tools/utils";

export const registerCreateMeetingTool = (server: McpServer) => {
  createToolRegistrar(server)(
    "create_meeting",
    {
      title: "Open a structured meeting",
      description:
        "Creates a gated multi-agent decision record. List the agent IDs of " +
        "every expected participant; the meeting cannot be concluded until each " +
        "has contributed (attendance gate) and an actionable conclusion is " +
        "recorded. Optionally seed the agenda from a built-in template " +
        `(${MEETING_TEMPLATE_KEYS.join(", ")}). Returns a dispatch plan — you ` +
        "still bring participants in yourself via send-task / delegate.",
      annotations: { destructiveHint: false },
      inputSchema: z.object({
        title: z.string().min(1).describe("Short human-readable meeting title."),
        agenda: z
          .string()
          .min(1)
          .optional()
          .describe("The exact question/topic to decide. Defaults from template if given."),
        template: z
          .string()
          .optional()
          .describe(`Optional built-in template key: ${MEETING_TEMPLATE_KEYS.join(", ")}.`),
        participants: z
          .array(z.string().min(1))
          .min(1)
          .describe(
            "Agent IDs expected to attend. Attendance is matched against the " +
              "X-Agent-ID of each contribution, so list agent IDs (not display names).",
          ),
      }),
      outputSchema: swarmToolOutputSchema({
        yourAgentId: z.string().optional(),
        id: z.string().optional(),
        status: z.string().optional(),
        participants: z.array(z.string()).optional(),
        dispatch_plan: z.array(z.string()).optional(),
      }),
    },
    async (input, requestInfo, _meta) => {
      if (!requestInfo.agentId) {
        return toolErr("Agent ID required. Set the X-Agent-ID header on the MCP request.");
      }

      let agenda = input.agenda?.trim();
      let rounds: string[] = [];
      if (input.template) {
        const tpl = getMeetingTemplate(input.template);
        if (!tpl) {
          return toolErr(
            `Unknown template "${input.template}". Valid keys: ${MEETING_TEMPLATE_KEYS.join(", ")}.`,
          );
        }
        agenda = agenda || tpl.agenda;
        rounds = tpl.rounds;
      }
      if (!agenda) {
        return toolErr("An agenda is required (pass `agenda`, or a `template` to seed it).");
      }

      let meeting: ReturnType<typeof createMeeting>;
      try {
        meeting = createMeeting({
          agentId: requestInfo.agentId,
          title: input.title,
          agenda,
          template: input.template,
          participants: input.participants,
        });
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        return toolErr(`Failed to create meeting: ${detail}`);
      }

      const dispatchPlan = [
        `Meeting "${meeting.title}" is open (id=${meeting.id}).`,
        `Bring each participant in and have them call contribute_to_meeting with meetingId=${meeting.id}:`,
        ...meeting.participants.map((p) => `  - dispatch to ${p}`),
        ...(rounds.length > 0
          ? ["Suggested rounds:", ...rounds.map((r, i) => `  ${i + 1}. ${r}`)]
          : []),
        `Conclude with conclude_meeting once all ${meeting.participants.length} have contributed.`,
      ];

      return toolOk(`Meeting "${meeting.title}" opened (id=${meeting.id}).`, {
        details: dispatchPlan.join("\n"),
        data: {
          yourAgentId: requestInfo.agentId,
          id: meeting.id,
          status: meeting.status,
          participants: meeting.participants,
          dispatch_plan: dispatchPlan,
        },
      });
    },
  );
};
