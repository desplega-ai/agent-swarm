import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { getScheduledTaskById, getScheduledTaskByName } from "@/be/db";
import { runScheduleNow } from "@/scheduler";
import { createToolRegistrar, swarmToolOutputSchema, toolErr, toolOk } from "@/tools/utils";

export const registerRunScheduleNowTool = (server: McpServer) => {
  createToolRegistrar(server)(
    "run-schedule-now",
    {
      title: "Run Schedule Now",
      annotations: { destructiveHint: false },
      description:
        "Immediately execute a scheduled task, creating a task right away. Does not affect the regular schedule timing.",
      inputSchema: z.object({
        scheduleId: z.string().uuid().optional().describe("Schedule ID to run"),
        name: z.string().optional().describe("Schedule name to run (alternative to ID)"),
      }),
      outputSchema: swarmToolOutputSchema({
        yourAgentId: z.string().optional(),
        schedule: z
          .looseObject({
            id: z.string().optional(),
            name: z.string().optional(),
            nextRunAt: z.string().optional(),
          })
          .optional(),
      }),
    },
    async ({ scheduleId, name }, requestInfo, _meta) => {
      if (!requestInfo.agentId) {
        return toolErr('Agent ID not found. Set the "X-Agent-ID" header.');
      }

      if (!scheduleId && !name) {
        return toolErr("Either scheduleId or name must be provided.");
      }

      // Find the schedule
      const schedule = scheduleId
        ? await getScheduledTaskById(scheduleId)
        : name
          ? await getScheduledTaskByName(name)
          : null;

      if (!schedule) {
        return toolErr("Schedule not found.");
      }

      if (!schedule.enabled) {
        return toolErr(`Schedule "${schedule.name}" is disabled.`, {
          details: "Enable it first or use it as a template.",
        });
      }

      try {
        await runScheduleNow(schedule.id);

        // Re-fetch to get updated lastRunAt
        const updated = await getScheduledTaskById(schedule.id);

        return toolOk(`Executed schedule "${schedule.name}".`, {
          details: `Task created. Next regular run: ${updated?.nextRunAt || "not scheduled"}`,
          data: {
            yourAgentId: requestInfo.agentId,
            schedule: updated
              ? {
                  id: updated.id,
                  name: updated.name,
                  nextRunAt: updated.nextRunAt,
                }
              : undefined,
          },
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error";
        return toolErr(`Failed to run schedule: ${message}`, {
          data: { yourAgentId: requestInfo.agentId },
        });
      }
    },
  );
};
