import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { addMinutes } from "date-fns";
import * as z from "zod";
import {
  getAgentById,
  getDb,
  getOfferedTasksForAgent,
  getPendingTaskForAgent,
  getUnassignedTasksCount,
  incrementEmptyPollCount,
  MAX_EMPTY_POLLS,
  resetEmptyPollCount,
  startTask,
  updateAgentStatus,
} from "@/be/db";
import { createToolRegistrar, swarmToolOutputSchema, toolErr, toolOk } from "@/tools/utils";
import { looseAgentTaskOutputSchema } from "./get-task-details";

const DEFAULT_POLL_INTERVAL_MS = 2000;
const MAX_POLL_DURATION_MS = 1 * 60 * 1000;

export const registerPollTaskTool = (server: McpServer) => {
  createToolRegistrar(server)(
    "poll-task",
    {
      title: "Poll for a task",
      description:
        "Poll for a new task assignment. Returns immediately if there are offered tasks awaiting accept/reject. Also returns count of unassigned tasks in the pool.",
      annotations: { readOnlyHint: true },

      inputSchema: z.object({}),
      outputSchema: swarmToolOutputSchema({
        yourAgentId: z.string().optional(),
        task: looseAgentTaskOutputSchema.optional(),
        offeredTasks: z
          .array(looseAgentTaskOutputSchema)
          .optional()
          .describe("Tasks offered to you awaiting accept/reject."),
        availableCount: z.number().optional().describe("Count of unassigned tasks in the pool."),
        waitedForSeconds: z
          .number()
          .optional()
          .describe("Seconds waited before receiving the task."),
        shouldExit: z.boolean().optional().describe("If true, agent should exit immediately."),
        emptyPollCount: z.number().optional().describe("Current consecutive empty poll count."),
      }),
    },
    async (_input, requestInfo, meta) => {
      // Check if agent ID is set
      if (!requestInfo.agentId) {
        const message = 'Agent ID not found. The MCP client should define the "X-Agent-ID" header.';
        return toolErr(message, {
          data: {
            yourAgentId: requestInfo.agentId,
            offeredTasks: [],
            availableCount: 0,
            waitedForSeconds: 0,
          },
        });
      }

      const agentId = requestInfo.agentId;
      const now = new Date();
      const maxTime = addMinutes(now, MAX_POLL_DURATION_MS / 60000);
      // Phase 3 (D-R3): when a budget refusal occurs, the empty-poll counter
      // must NOT advance — refused ≠ empty. The MCP `poll-task` tool is NOT
      // gated by `canClaim` in V1 (per plan §"What We're NOT Doing" — D-R1),
      // so this is structural / forward-compat plumbing: future revisions
      // that gate poll-task flip this to true at the refusal site instead of
      // touching the bookkeeping path below.
      const wasBudgetRefused: boolean = false;

      const agent = getAgentById(agentId);
      if (!agent) {
        return toolErr(`Agent with ID "${agentId}" not found in the swarm.`, {
          data: {
            yourAgentId: requestInfo.agentId,
            offeredTasks: [],
            availableCount: 0,
            waitedForSeconds: 0,
          },
        });
      }

      // Check for offered tasks first - these need immediate attention
      const offeredTasks = getOfferedTasksForAgent(agentId);
      const availableCount = getUnassignedTasksCount();

      if (offeredTasks.length > 0) {
        return toolOk(
          `You have ${offeredTasks.length} task(s) offered to you awaiting accept/reject.`,
          {
            details: `Use task-action with action='accept' or 'reject'.`,
            data: {
              yourAgentId: requestInfo.agentId,
              offeredTasks,
              availableCount,
              waitedForSeconds: 0,
            },
          },
        );
      }

      // Poll for pending tasks
      while (new Date() < maxTime) {
        // Fetch and update in a single transaction to avoid race conditions
        const startedTask = getDb().transaction(() => {
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
          // Reset empty poll count when task is assigned
          resetEmptyPollCount(agentId);

          const waitedFor = Math.round((Date.now() - now.getTime()) / 1000);

          return toolOk(`Task "${startedTask.id}" assigned and started.`, {
            data: {
              yourAgentId: requestInfo.agentId,
              task: startedTask,
              offeredTasks: [],
              availableCount: getUnassignedTasksCount(),
              waitedForSeconds: waitedFor,
              emptyPollCount: 0,
            },
          });
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

      // Increment empty poll count and check if agent should exit.
      // Refused ≠ empty (D-R3) — skip bookkeeping when a budget refusal
      // occurred during this poll window.
      const newCount = wasBudgetRefused
        ? (getAgentById(agentId)?.emptyPollCount ?? 0)
        : incrementEmptyPollCount(agentId);
      const shouldExit = newCount >= MAX_EMPTY_POLLS;

      // If no task was found within the time limit. An empty poll is a routine
      // outcome, not a tool failure — isError:true here would make every idle
      // poll look like a failed call to harnesses and retry logic.
      return toolOk(
        shouldExit
          ? `Polling limit reached (${newCount}/${MAX_EMPTY_POLLS}). You must exit now.`
          : `No task assigned within the polling duration.`,
        {
          details: shouldExit
            ? `No task assigned after ${newCount} polling attempts. EXIT NOW - do not poll again.`
            : `No task assigned within the polling duration (${waitedForSeconds}s). ${getUnassignedTasksCount()} unassigned task(s) available in pool.`,
          data: {
            yourAgentId: requestInfo.agentId,
            offeredTasks: [],
            availableCount: getUnassignedTasksCount(),
            waitedForSeconds,
            shouldExit,
            emptyPollCount: newCount,
          },
        },
      );
    },
  );
};
