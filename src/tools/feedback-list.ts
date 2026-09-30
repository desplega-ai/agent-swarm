import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { listTaskFeedback } from "@/be/db-queries/task-feedback";
import { createToolRegistrar, swarmToolOutputSchema, toolOk } from "@/tools/utils";

const FeedbackOutputSchema = z.looseObject({
  id: z.string().optional(),
  taskId: z.string().optional(),
  agentId: z.string().nullable().optional(),
  rating: z.number().optional(),
  note: z.string().nullable().optional(),
  source: z.string().optional(),
  sourceRef: z.record(z.string(), z.unknown()).nullable().optional(),
  requestedByUserId: z.string().nullable().optional(),
  createdAt: z.string().optional(),
});

export const registerFeedbackListTool = (server: McpServer) => {
  createToolRegistrar(server)(
    "feedback-list",
    {
      title: "List task feedback",
      description:
        "Lists human ratings of task outcomes (+1 / -1 with an optional note), newest first. Ratings come from the Slack outcome card today (source 'slack'). Use it in self-improvement loops: pull the -1s since your last run, read each task with get-task-details, and turn the pattern into a memory or a fix.",
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        since: z.iso
          .datetime()
          .optional()
          .describe("Only feedback at or after this ISO timestamp."),
        rating: z
          .union([z.literal(1), z.literal(-1)])
          .optional()
          .describe("1 for 👍, -1 for 👎."),
        source: z.enum(["slack", "ui", "api"]).optional(),
        agentId: z.string().optional().describe("Only feedback on tasks assigned to this agent."),
        taskId: z.string().optional(),
        limit: z.number().int().min(1).max(500).optional().describe("Default 50, max 500."),
      }),
      outputSchema: swarmToolOutputSchema({
        feedback: z.array(FeedbackOutputSchema).optional(),
      }),
    },
    async (input) => {
      const feedback = await listTaskFeedback(input);
      const details = feedback.length
        ? feedback
            .map(
              (item) =>
                `- ${item.createdAt} ${item.rating > 0 ? "+1" : "-1"} task ${item.taskId}` +
                `${item.agentId ? ` (agent ${item.agentId})` : ""} via ${item.source}` +
                `${item.note ? `: ${item.note}` : ""}`,
            )
            .join("\n")
        : undefined;
      const down = feedback.filter((item) => item.rating < 0).length;
      return toolOk(
        `Found ${feedback.length} feedback item(s): ${feedback.length - down} positive, ${down} negative.`,
        { details, data: { feedback } },
      );
    },
  );
};
