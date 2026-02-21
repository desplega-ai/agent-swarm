import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import {
  acceptTask,
  checkDependencies,
  claimTask,
  createTaskExtended,
  getActiveTaskCount,
  getAgentById,
  getDb,
  getTaskById,
  hasCapacity,
  moveTaskFromBacklog,
  moveTaskToBacklog,
  rejectTask,
  releaseTask,
} from "@/be/db";
import { createToolRegistrar } from "@/tools/utils";
import { AgentTaskSchema } from "@/types";

const TaskActionSchema = z.enum([
  "create",
  "claim",
  "release",
  "accept",
  "reject",
  "to_backlog",
  "from_backlog",
]);

export const registerTaskActionTool = (server: McpServer) => {
  createToolRegistrar(server)(
    "task-action",
    {
      title: "Task Pool Actions",
      description:
        "Perform task pool operations: create unassigned tasks, claim/release tasks from pool, accept/reject offered tasks.",
      inputSchema: z.object({
        action: TaskActionSchema.describe(
          "The action to perform: 'create' creates an unassigned task, 'claim' takes a task from pool, 'release' returns task to pool, 'accept' accepts offered task, 'reject' declines offered task, 'to_backlog' moves task to backlog, 'from_backlog' moves task from backlog to pool.",
        ),
        // For 'create' action:
        task: z.string().min(1).optional().describe("Task description (required for 'create')."),
        taskType: z.string().max(50).optional().describe("Task type (e.g., 'bug', 'feature')."),
        tags: z
          .array(z.string())
          .optional()
          .describe("Tags for filtering (e.g., ['urgent', 'frontend'])."),
        priority: z
          .number()
          .int()
          .min(0)
          .max(100)
          .optional()
          .describe("Priority 0-100, default 50."),
        dependsOn: z.array(z.uuid()).optional().describe("Task IDs this task depends on."),
        // For claim/release/accept/reject actions:
        taskId: z.uuid().optional().describe("Task ID (required for claim/release/accept/reject)."),
        // For 'reject' action:
        reason: z.string().optional().describe("Reason for rejection (optional for 'reject')."),
      }),
      outputSchema: z.object({
        yourAgentId: z.string().uuid().optional(),
        success: z.boolean(),
        message: z.string(),
        task: AgentTaskSchema.optional(),
      }),
    },
    async (input, requestInfo, _meta) => {
      const { action, task, taskType, tags, priority, dependsOn, taskId, reason } = input;

      if (!requestInfo.agentId) {
        return {
          content: [{ type: "text", text: 'Agent ID not found. Set the "X-Agent-ID" header.' }],
          structuredContent: {
            success: false,
            message: 'Agent ID not found. Set the "X-Agent-ID" header.',
          },
        };
      }

      const agentId = requestInfo.agentId;

      const txn = getDb().transaction(() => {
        switch (action) {
          case "create": {
            if (!task) {
              return {
                success: false,
                message: "Task description is required for 'create' action.",
              };
            }
            const newTask = createTaskExtended(task, {
              creatorAgentId: agentId,
              taskType,
              tags,
              priority,
              dependsOn,
            });
            return {
              success: true,
              message: `Created unassigned task "${newTask.id}".`,
              task: newTask,
            };
          }

          case "claim": {
            if (!taskId) {
              return { success: false, message: "Task ID is required for 'claim' action." };
            }
            // Check capacity before claiming
            if (!hasCapacity(agentId)) {
              const activeCount = getActiveTaskCount(agentId);
              const agent = getAgentById(agentId);
              return {
                success: false,
                message: `You have no capacity (${activeCount}/${agent?.maxTasks ?? 1} tasks). Complete a task first.`,
              };
            }
            // Pre-checks for informative error messages (the atomic UPDATE in
            // claimTask is the real guard against race conditions)
            const existingTask = getTaskById(taskId);
            if (!existingTask) {
              return { success: false, message: `Task "${taskId}" not found.` };
            }
            if (existingTask.status !== "unassigned") {
              return {
                success: false,
                message: `Task "${taskId}" is not unassigned (status: ${existingTask.status}). It may have been claimed by another agent.`,
              };
            }
            // Check if task dependencies are met
            const { ready, blockedBy } = checkDependencies(taskId);
            if (!ready) {
              return {
                success: false,
                message: `Task "${taskId}" has unmet dependencies: ${blockedBy.join(", ")}. Cannot claim until dependencies are completed.`,
              };
            }
            // Atomic claim — only one agent can win this race
            const claimedTask = claimTask(taskId, agentId);
            if (!claimedTask) {
              return {
                success: false,
                message: `Task "${taskId}" was already claimed by another agent. Try a different task.`,
              };
            }
            return {
              success: true,
              message: `Claimed task "${taskId}".`,
              task: claimedTask,
            };
          }

          case "release": {
            if (!taskId) {
              return { success: false, message: "Task ID is required for 'release' action." };
            }
            const existingTask = getTaskById(taskId);
            if (!existingTask) {
              return { success: false, message: `Task "${taskId}" not found.` };
            }
            if (existingTask.agentId !== agentId) {
              return { success: false, message: `Task "${taskId}" is not assigned to you.` };
            }
            if (existingTask.status !== "pending" && existingTask.status !== "in_progress") {
              return {
                success: false,
                message: `Cannot release task in status "${existingTask.status}". Only 'pending' or 'in_progress' tasks can be released.`,
              };
            }
            const releasedTask = releaseTask(taskId);
            if (!releasedTask) {
              return { success: false, message: `Failed to release task "${taskId}".` };
            }
            return {
              success: true,
              message: `Released task "${taskId}" back to pool.`,
              task: releasedTask,
            };
          }

          case "accept": {
            if (!taskId) {
              return { success: false, message: "Task ID is required for 'accept' action." };
            }
            const existingTask = getTaskById(taskId);
            if (!existingTask) {
              return { success: false, message: `Task "${taskId}" not found.` };
            }
            if (existingTask.status !== "offered") {
              return { success: false, message: `Task "${taskId}" is not offered.` };
            }
            if (existingTask.offeredTo !== agentId) {
              return { success: false, message: `Task "${taskId}" was not offered to you.` };
            }
            // Check if task dependencies are met
            const { ready, blockedBy } = checkDependencies(taskId);
            if (!ready) {
              return {
                success: false,
                message: `Task "${taskId}" has unmet dependencies: ${blockedBy.join(", ")}. Cannot accept until dependencies are completed.`,
              };
            }
            const acceptedTask = acceptTask(taskId, agentId);
            if (!acceptedTask) {
              return { success: false, message: `Failed to accept task "${taskId}".` };
            }
            return {
              success: true,
              message: `Accepted task "${taskId}".`,
              task: acceptedTask,
            };
          }

          case "reject": {
            if (!taskId) {
              return { success: false, message: "Task ID is required for 'reject' action." };
            }
            const existingTask = getTaskById(taskId);
            if (!existingTask) {
              return { success: false, message: `Task "${taskId}" not found.` };
            }
            if (existingTask.status !== "offered") {
              return { success: false, message: `Task "${taskId}" is not offered.` };
            }
            if (existingTask.offeredTo !== agentId) {
              return { success: false, message: `Task "${taskId}" was not offered to you.` };
            }
            const rejectedTask = rejectTask(taskId, agentId, reason);
            if (!rejectedTask) {
              return { success: false, message: `Failed to reject task "${taskId}".` };
            }
            return {
              success: true,
              message: `Rejected task "${taskId}". Task returned to pool.`,
              task: rejectedTask,
            };
          }

          case "to_backlog": {
            if (!taskId) {
              return { success: false, message: "Task ID is required for 'to_backlog' action." };
            }
            const existingTask = getTaskById(taskId);
            if (!existingTask) {
              return { success: false, message: `Task "${taskId}" not found.` };
            }
            if (existingTask.status !== "unassigned") {
              return {
                success: false,
                message: `Task "${taskId}" is not unassigned (status: ${existingTask.status}). Only unassigned tasks can be moved to backlog.`,
              };
            }
            const backlogTask = moveTaskToBacklog(taskId);
            if (!backlogTask) {
              return { success: false, message: `Failed to move task "${taskId}" to backlog.` };
            }
            return {
              success: true,
              message: `Moved task "${taskId}" to backlog.`,
              task: backlogTask,
            };
          }

          case "from_backlog": {
            if (!taskId) {
              return { success: false, message: "Task ID is required for 'from_backlog' action." };
            }
            const existingTask = getTaskById(taskId);
            if (!existingTask) {
              return { success: false, message: `Task "${taskId}" not found.` };
            }
            if (existingTask.status !== "backlog") {
              return {
                success: false,
                message: `Task "${taskId}" is not in backlog (status: ${existingTask.status}).`,
              };
            }
            const unassignedTask = moveTaskFromBacklog(taskId);
            if (!unassignedTask) {
              return { success: false, message: `Failed to move task "${taskId}" from backlog.` };
            }
            return {
              success: true,
              message: `Moved task "${taskId}" from backlog to pool.`,
              task: unassignedTask,
            };
          }

          default:
            return { success: false, message: `Unknown action: ${action}` };
        }
      });

      const result = txn();

      return {
        content: [{ type: "text", text: result.message }],
        structuredContent: {
          yourAgentId: agentId,
          ...result,
        },
      };
    },
  );
};
