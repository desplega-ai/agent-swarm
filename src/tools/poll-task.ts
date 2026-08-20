import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { addMinutes } from "date-fns";
import * as z from "zod";
import {
  getActiveTaskCount,
  getAgentById,
  getDbClient,
  getOfferedTasksForAgent,
  getPendingTaskForAgent,
  getUnassignedTasksCount,
  hasCapacity,
  incrementEmptyPollCount,
  MAX_EMPTY_POLLS,
  resetEmptyPollCount,
  startTask,
  updateAgentStatus,
} from "@/be/db";
import { touchRuntimeInstance } from "@/be/multi-runtime";
import { createToolRegistrar, swarmToolOutputSchema, toolErr, toolOk } from "@/tools/utils";
import type { AgentTask } from "@/types";
import { isMultiRuntimeEnabled } from "@/utils/multi-runtime";
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

      // Second dispatch entrypoint alongside HTTP /api/poll, so it needs the
      // same gate: a process whose runtime is gone must not pick up work
      // beside its replacement. Touch validates ownership+liveness and
      // refreshes it; it cannot revive a retired runtime.
      if (
        isMultiRuntimeEnabled() &&
        !(
          requestInfo.runtimeInstanceId &&
          (await touchRuntimeInstance(requestInfo.runtimeInstanceId, agentId))
        )
      ) {
        return toolOk("No task available.", {
          details: "No task available for this runtime.",
          data: {
            yourAgentId: requestInfo.agentId,
            offeredTasks: [],
            availableCount: 0,
            waitedForSeconds: 0,
          },
        });
      }

      const agent = await getAgentById(agentId);
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
      const offeredTasks = await getOfferedTasksForAgent(agentId);
      const availableCount = await getUnassignedTasksCount();

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
        const outcome = await getDbClient().transaction(
          async (): Promise<AgentTask | "at-capacity" | "runtime-unavailable" | null> => {
            // The entry gate only proves liveness when the long poll began;
            // the runtime must be live at the exact moment work is acquired,
            // so revalidate in the same transaction that can start the task.
            // Touch refreshes an already-live row and cannot revive one.
            if (
              isMultiRuntimeEnabled() &&
              !(
                requestInfo.runtimeInstanceId &&
                (await touchRuntimeInstance(requestInfo.runtimeInstanceId, agentId))
              )
            ) {
              return "runtime-unavailable";
            }

            const agentNow = (await getAgentById(agentId))!;

            if (agentNow.status !== "busy") {
              await updateAgentStatus(agentId, "idle");
            }

            const pendingTask = await getPendingTaskForAgent(agentId);
            if (!pendingTask) return null;

            // Logical capacity is decided inside the same transaction as the
            // start transition: several runtimes of one agent race this
            // dispatch, and a check outside it would let each of them start a
            // task past the agent's limit. Same gate as HTTP /api/poll.
            if (!(await hasCapacity(agentId))) return "at-capacity";

            const maybeTask = await startTask(pendingTask.id);

            if (maybeTask) {
              // Update automatically in case the agent forgets xd
              await updateAgentStatus(agentId, "busy");
            }

            return maybeTask;
          },
        );

        if (outcome === "runtime-unavailable") {
          // The runtime was retired while this call waited: stop immediately
          // rather than keep polling as it, and skip the exit counter — this
          // is a refusal, not an empty poll.
          return toolOk("No task available.", {
            details: "No task available for this runtime.",
            data: {
              yourAgentId: requestInfo.agentId,
              offeredTasks: [],
              availableCount: 0,
              waitedForSeconds: Math.round((Date.now() - now.getTime()) / 1000),
            },
          });
        }

        if (outcome === "at-capacity") {
          // A capacity refusal is not an empty poll (refused ≠ empty, D-R3):
          // return without advancing the exit counter.
          return toolOk("No task available.", {
            details: `You are at capacity (${await getActiveTaskCount(agentId)} active task(s)). Complete a task before polling for more.`,
            data: {
              yourAgentId: requestInfo.agentId,
              offeredTasks: [],
              availableCount: await getUnassignedTasksCount(),
              waitedForSeconds: Math.round((Date.now() - now.getTime()) / 1000),
            },
          });
        }

        const startedTask = outcome;
        if (startedTask) {
          // Reset empty poll count when task is assigned
          await resetEmptyPollCount(agentId);

          const waitedFor = Math.round((Date.now() - now.getTime()) / 1000);

          return toolOk(`Task "${startedTask.id}" assigned and started.`, {
            data: {
              yourAgentId: requestInfo.agentId,
              task: startedTask,
              offeredTasks: [],
              availableCount: await getUnassignedTasksCount(),
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
        ? ((await getAgentById(agentId))?.emptyPollCount ?? 0)
        : await incrementEmptyPollCount(agentId);
      const shouldExit = newCount >= MAX_EMPTY_POLLS;
      const unassignedCount = await getUnassignedTasksCount();

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
            : `No task assigned within the polling duration (${waitedForSeconds}s). ${unassignedCount} unassigned task(s) available in pool.`,
          data: {
            yourAgentId: requestInfo.agentId,
            offeredTasks: [],
            availableCount: unassignedCount,
            waitedForSeconds,
            shouldExit,
            emptyPollCount: newCount,
          },
        },
      );
    },
  );
};
