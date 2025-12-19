import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { addMinutes } from "date-fns";
import * as z from "zod";
import {
  getAgentById,
  getDb,
  getOfferedTasksForAgent,
  getPendingTaskForAgent,
  getUnassignedTasksCount,
  startTask,
  updateAgentStatus,
} from "@/be/db";
import { createToolRegistrar } from "@/tools/utils";
import { AgentTaskSchema } from "@/types";

const DEFAULT_POLL_INTERVAL_MS = 2000;
const MAX_POLL_DURATION_MS = 1 * 60 * 1000;

export const registerPollTaskTool = (server: McpServer) => {
  createToolRegistrar(server)(
    "poll-task",
    {
      title: "Poll for a task",
      description:
        "Poll for a new task assignment. Returns immediately if there are offered tasks awaiting accept/reject. Also returns count of unassigned tasks in the pool.",
      inputSchema: z.object({}),
      outputSchema: z.object({
        success: z.boolean(),
        message: z.string(),
        task: AgentTaskSchema.optional(),
        offeredTasks: z
          .array(AgentTaskSchema)
          .describe("Tasks offered to you awaiting accept/reject."),
        availableCount: z.number().describe("Count of unassigned tasks in the pool."),
        waitedForSeconds: z.number().describe("Seconds waited before receiving the task."),
      }),
    },
    async (_input, requestInfo, meta) => {
      // Check if agent ID is set
      if (!requestInfo.agentId) {
        return {
          content: [
            {
              type: "text",
              text: 'Agent ID not found. The MCP client should define the "X-Agent-ID" header.',
            },
          ],
          structuredContent: {
            yourAgentId: requestInfo.agentId,
            success: false,
            message: 'Agent ID not found. The MCP client should define the "X-Agent-ID" header.',
            offeredTasks: [],
            availableCount: 0,
            waitedForSeconds: 0,
          },
        };
      }

      const agentId = requestInfo.agentId;
      const now = new Date();
      const maxTime = addMinutes(now, MAX_POLL_DURATION_MS / 60000);

      const agent = getAgentById(agentId);
      if (!agent) {
        return {
          content: [
            {
              type: "text",
              text: `Agent with ID "${agentId}" not found in the swarm.`,
            },
          ],
          structuredContent: {
            yourAgentId: requestInfo.agentId,
            success: false,
            message: `Agent with ID "${agentId}" not found in the swarm.`,
            offeredTasks: [],
            availableCount: 0,
            waitedForSeconds: 0,
          },
        };
      }

      // Check for offered tasks first - these need immediate attention
      const offeredTasks = getOfferedTasksForAgent(agentId);
      const availableCount = getUnassignedTasksCount();

      if (offeredTasks.length > 0) {
        return {
          content: [
            {
              type: "text",
              text: `You have ${offeredTasks.length} task(s) offered to you awaiting accept/reject. Use task-action with action='accept' or 'reject'.`,
            },
          ],
          structuredContent: {
            yourAgentId: requestInfo.agentId,
            success: true,
            message: `You have ${offeredTasks.length} task(s) offered to you awaiting accept/reject.`,
            offeredTasks,
            availableCount,
            waitedForSeconds: 0,
          },
        };
      }

      // Poll for pending tasks
      while (new Date() < maxTime) {
        // Fetch and update in a single transaction to avoid race conditions
        const startedTask = getDb().transaction(() => {
          // biome-ignore lint/style/noNonNullAssertion: agent existence verified above
          const agentNow = getAgentById(agentId)!;

          if (agentNow.status !== "busy") {
            updateAgentStatus(agentId, "idle");
          }

          const pendingTask = getPendingTaskForAgent(agentId);
          if (!pendingTask) return null;

          const maybeTask = startTask(pendingTask.id);

          if (maybeTask) {
            // Update automatically in case the agent forgets xd
            updateAgentStatus(agentId, "busy");
          }

          return maybeTask;
        })();

        if (startedTask) {
          const waitedFor = Math.round((Date.now() - now.getTime()) / 1000);

          return {
            content: [
              {
                type: "text",
                text: `Task "${startedTask.id}" assigned and started.`,
              },
            ],
            structuredContent: {
              yourAgentId: requestInfo.agentId,
              success: true,
              message: `Task "${startedTask.id}" assigned and started.`,
              task: startedTask,
              offeredTasks: [],
              availableCount: getUnassignedTasksCount(),
              waitedForSeconds: waitedFor,
            },
          };
        }

        await meta.sendNotification({
          method: "notifications/message",
          params: {
            level: "info",
            data: `Polling for task assignment...`,
          },
        });

        // Wait for a short period before polling again
        await new Promise((resolve) => setTimeout(resolve, DEFAULT_POLL_INTERVAL_MS));
      }

      const waitedForSeconds = Math.round((Date.now() - now.getTime()) / 1000);

      // If no task was found within the time limit
      return {
        content: [
          {
            type: "text",
            text: `No task assigned within the polling duration. ${availableCount} unassigned task(s) available in pool.`,
          },
        ],
        structuredContent: {
          yourAgentId: requestInfo.agentId,
          success: false,
          message: `No task assigned within the polling duration, please keep polling until a task is assigned.`,
          offeredTasks: [],
          availableCount: getUnassignedTasksCount(),
          waitedForSeconds,
        },
      };
    },
  );
};
