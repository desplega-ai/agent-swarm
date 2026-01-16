import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import {
  deleteScheduledTask,
  getAgentById,
  getScheduledTaskById,
  getScheduledTaskByName,
} from "@/be/db";
import { createToolRegistrar } from "@/tools/utils";

export const registerDeleteScheduleTool = (server: McpServer) => {
  createToolRegistrar(server)(
    "delete-schedule",
    {
      title: "Delete Scheduled Task",
      description:
        "Delete a scheduled task permanently. Only the creator or lead agent can delete schedules.",
      inputSchema: z.object({
        scheduleId: z.string().uuid().optional().describe("Schedule ID to delete"),
        name: z.string().optional().describe("Schedule name to delete (alternative to ID)"),
      }),
      outputSchema: z.object({
        success: z.boolean(),
        message: z.string(),
        deletedSchedule: z
          .object({
            id: z.string(),
            name: z.string(),
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

      // Check authorization (creator or lead)
      const caller = getAgentById(requestInfo.agentId);
      const isCreator = schedule.createdByAgentId === requestInfo.agentId;
      const isLead = caller?.isLead === true;

      if (!isCreator && !isLead) {
        return {
          content: [{ type: "text", text: "Only the creator or lead can delete this schedule." }],
          structuredContent: {
            success: false,
            message: "Only the creator or lead can delete this schedule.",
          },
        };
      }

      try {
        const deleted = deleteScheduledTask(schedule.id);

        if (!deleted) {
          return {
            content: [{ type: "text", text: "Failed to delete schedule." }],
            structuredContent: {
              success: false,
              message: "Failed to delete schedule.",
            },
          };
        }

        return {
          content: [{ type: "text", text: `Deleted schedule "${schedule.name}".` }],
          structuredContent: {
            yourAgentId: requestInfo.agentId,
            success: true,
            message: `Deleted schedule "${schedule.name}".`,
            deletedSchedule: {
              id: schedule.id,
              name: schedule.name,
            },
          },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error";
        return {
          content: [{ type: "text", text: `Failed to delete schedule: ${message}` }],
          structuredContent: {
            yourAgentId: requestInfo.agentId,
            success: false,
            message: `Failed to delete schedule: ${message}`,
          },
        };
      }
    },
  );
};
