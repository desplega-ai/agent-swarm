import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import {
  deleteScheduledTask,
  getAgentById,
  getScheduledTaskById,
  getScheduledTaskByName,
} from "@/be/db";
import { createEvent } from "@/be/events";
import { createToolRegistrar, swarmToolOutputSchema, toolErr, toolOk } from "@/tools/utils";

export const registerDeleteScheduleTool = (server: McpServer) => {
  createToolRegistrar(server)(
    "delete-schedule",
    {
      title: "Delete Scheduled Task",
      description:
        "Delete a scheduled task permanently. Any registered agent can delete schedules.",
      annotations: { destructiveHint: true },

      inputSchema: z.object({
        scheduleId: z.string().uuid().optional().describe("Schedule ID to delete"),
        name: z.string().optional().describe("Schedule name to delete (alternative to ID)"),
      }),
      outputSchema: swarmToolOutputSchema({
        yourAgentId: z.string().optional(),
        deletedSchedule: z
          .looseObject({
            id: z.string().optional(),
            name: z.string().optional(),
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

      const caller = await getAgentById(requestInfo.agentId);
      if (!caller) {
        return toolErr("Agent not found.");
      }

      try {
        const deleted = await deleteScheduledTask(schedule.id);

        if (!deleted) {
          return toolErr("Failed to delete schedule.");
        }

        await createEvent({
          category: "system",
          event: "schedule.deleted",
          source: "api",
          agentId: requestInfo.agentId,
          data: {
            scheduleId: schedule.id,
            name: schedule.name,
            deletedByAgentId: requestInfo.agentId,
            createdByAgentId: schedule.createdByAgentId,
          },
        });

        return toolOk(`Deleted schedule "${schedule.name}".`, {
          data: {
            yourAgentId: requestInfo.agentId,
            deletedSchedule: {
              id: schedule.id,
              name: schedule.name,
            },
          },
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error";
        return toolErr(`Failed to delete schedule: ${message}`, {
          data: { yourAgentId: requestInfo.agentId },
        });
      }
    },
  );
};
