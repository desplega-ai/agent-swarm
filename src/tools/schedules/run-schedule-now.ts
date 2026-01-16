import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { getScheduledTaskById, getScheduledTaskByName } from "@/be/db";
import { runScheduleNow } from "@/scheduler";
import { createToolRegistrar } from "@/tools/utils";

export const registerRunScheduleNowTool = (server: McpServer) => {
  createToolRegistrar(server)(
    "run-schedule-now",
    {
      title: "Run Schedule Now",
      description:
        "Immediately execute a scheduled task, creating a task right away. Does not affect the regular schedule timing.",
      inputSchema: z.object({
        scheduleId: z.string().uuid().optional().describe("Schedule ID to run"),
        name: z.string().optional().describe("Schedule name to run (alternative to ID)"),
      }),
      outputSchema: z.object({
        success: z.boolean(),
        message: z.string(),
        schedule: z
          .object({
            id: z.string(),
            name: z.string(),
            nextRunAt: z.string().optional(),
          })
          .optional(),
      }),
    },
    async ({ scheduleId, name }, requestInfo, _meta) => {
      if (!requestInfo.agentId) {
        return {
          content: [{ type: "text", text: 'Agent ID not found. Set the "X-Agent-ID" header.' }],
          structuredContent: {
            success: false,
            message: 'Agent ID not found. Set the "X-Agent-ID" header.',
          },
        };
      }

      if (!scheduleId && !name) {
        return {
          content: [{ type: "text", text: "Either scheduleId or name must be provided." }],
          structuredContent: {
            success: false,
            message: "Either scheduleId or name must be provided.",
          },
        };
      }

      // Find the schedule
      const schedule = scheduleId
        ? getScheduledTaskById(scheduleId)
        : name
          ? getScheduledTaskByName(name)
          : null;

      if (!schedule) {
        return {
          content: [{ type: "text", text: "Schedule not found." }],
          structuredContent: {
            success: false,
            message: "Schedule not found.",
          },
        };
      }

      if (!schedule.enabled) {
        return {
          content: [
            {
              type: "text",
              text: `Schedule "${schedule.name}" is disabled. Enable it first or use it as a template.`,
            },
          ],
          structuredContent: {
            success: false,
            message: `Schedule "${schedule.name}" is disabled.`,
          },
        };
      }

      try {
        await runScheduleNow(schedule.id);

        // Re-fetch to get updated lastRunAt
        const updated = getScheduledTaskById(schedule.id);

        return {
          content: [
            {
              type: "text",
              text: `Executed schedule "${schedule.name}". Task created. Next regular run: ${updated?.nextRunAt || "not scheduled"}`,
            },
          ],
          structuredContent: {
            yourAgentId: requestInfo.agentId,
            success: true,
            message: `Executed schedule "${schedule.name}".`,
            schedule: updated
              ? {
                  id: updated.id,
                  name: updated.name,
                  nextRunAt: updated.nextRunAt,
                }
              : undefined,
          },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error";
        return {
          content: [{ type: "text", text: `Failed to run schedule: ${message}` }],
          structuredContent: {
            yourAgentId: requestInfo.agentId,
            success: false,
            message: `Failed to run schedule: ${message}`,
          },
        };
      }
    },
  );
};
