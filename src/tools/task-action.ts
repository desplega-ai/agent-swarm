import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { canClaim } from "@/be/budget-admission";
import {
  type BudgetRefusalContext,
  emitBudgetRefusalSideEffects,
} from "@/be/budget-refusal-notify";
import {
  acceptTask,
  checkDependencies,
  claimTask,
  createTaskExtended,
  getActiveSessions,
  getActiveTaskCount,
  getAgentById,
  getDb,
  getTaskById,
  hasCapacity,
  moveTaskFromBacklog,
  moveTaskToBacklog,
  reassociateSessionLogs,
  recordBudgetRefusalNotification,
  rejectTask,
  releaseTask,
  updateTaskClaudeSessionId,
} from "@/be/db";
import { createToolRegistrar } from "@/tools/utils";
import { AgentTaskSchema, BudgetRefusalCauseSchema } from "@/types";

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
      annotations: { destructiveHint: false },
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
        // For 'create' action:
        dir: z
          .string()
          .min(1)
          .startsWith("/")
          .optional()
          .describe(
            "Working directory (absolute path) for the agent to start in. Only used with 'create' action.",
          ),
        model: z
          .enum(["haiku", "sonnet", "opus"])
          .optional()
          .describe(
            "Model to use for the created task ('haiku', 'sonnet', or 'opus'). Only used with 'create' action.",
          ),
      }),
      outputSchema: z.object({
        yourAgentId: z.string().uuid().optional(),
        success: z.boolean(),
        message: z.string(),
        task: AgentTaskSchema.optional(),
        // Phase 3: budget-admission refusal fields. Populated only on
        // `accept` action when the per-agent or global daily budget is blown.
        refusalCause: BudgetRefusalCauseSchema.optional(),
        agentSpend: z.number().optional(),
        agentBudget: z.number().optional(),
        globalSpend: z.number().optional(),
        globalBudget: z.number().optional(),
        resetAt: z.string().optional(),
      }),
    },
    async (input, requestInfo, _meta) => {
      const { action, task, taskType, tags, priority, dependsOn, taskId, reason, dir, model } =
        input;

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
              dir,
              model,
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

            // Reassociate session logs from pool trigger's random UUID to real task ID
            const sessions = getActiveSessions(agentId);
            const activeSession = sessions.find((s) => s.runnerSessionId);
            if (activeSession?.runnerSessionId) {
              const count = reassociateSessionLogs(activeSession.runnerSessionId, taskId);
              if (count > 0) {
                console.log(
                  `[task-action] Reassociated ${count} session logs for claimed task ${taskId.slice(0, 8)}`,
                );
              }
              // Propagate provider session ID (e.g. claudeSessionId) to the task
              if (activeSession.providerSessionId) {
                updateTaskClaudeSessionId(taskId, activeSession.providerSessionId);
              }
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
            // Budget admission gate (Phase 3). Same in-transaction placement
            // as the /api/poll gates so capacity AND budget share atomicity.
            // Phase 5: record dedup row + capture side-effect context for the
            // after-commit lead follow-up + workflow event-bus emit.
            const admission = canClaim(agentId, new Date());
            if (!admission.allowed) {
              const causeMsg =
                admission.cause === "agent"
                  ? "agent daily budget exceeded"
                  : "global daily budget exceeded";
              const utcDate = new Date().toISOString().slice(0, 10);
              const dedup = recordBudgetRefusalNotification({
                taskId,
                date: utcDate,
                agentId,
                cause: admission.cause,
                agentSpendUsd: admission.agentSpend,
                agentBudgetUsd: admission.agentBudget,
                globalSpendUsd: admission.globalSpend,
                globalBudgetUsd: admission.globalBudget,
              });
              return {
                success: false,
                message: `Refused: ${causeMsg}. Resets at ${admission.resetAt}.`,
                refusalCause: admission.cause,
                ...(admission.agentSpend !== undefined && { agentSpend: admission.agentSpend }),
                ...(admission.agentBudget !== undefined && { agentBudget: admission.agentBudget }),
                ...(admission.globalSpend !== undefined && { globalSpend: admission.globalSpend }),
                ...(admission.globalBudget !== undefined && {
                  globalBudget: admission.globalBudget,
                }),
                resetAt: admission.resetAt,
                refusalSideEffects: {
                  context: {
                    task: {
                      id: existingTask.id,
                      task: existingTask.task,
                      slackChannelId: existingTask.slackChannelId,
                      slackThreadTs: existingTask.slackThreadTs,
                      slackUserId: existingTask.slackUserId,
                    },
                    agentId,
                    date: utcDate,
                    cause: admission.cause,
                    agentSpendUsd: admission.agentSpend,
                    agentBudgetUsd: admission.agentBudget,
                    globalSpendUsd: admission.globalSpend,
                    globalBudgetUsd: admission.globalBudget,
                    resetAt: admission.resetAt,
                  } satisfies BudgetRefusalContext,
                  inserted: dedup.inserted,
                },
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

      // Phase 5: when the accept gate refused, run after-commit side
      // effects (lead follow-up + workflow bus). The dedup row was recorded
      // inside the txn; this just consumes the captured context.
      if (
        "refusalSideEffects" in result &&
        result.refusalSideEffects &&
        typeof result.refusalSideEffects === "object"
      ) {
        const sideEffects = result.refusalSideEffects as {
          context: BudgetRefusalContext;
          inserted: boolean;
        };
        emitBudgetRefusalSideEffects(sideEffects.context, sideEffects.inserted);
      }

      // Strip the internal-only `refusalSideEffects` field from the wire
      // response — workers receive only the public refusal envelope.
      const { refusalSideEffects: _omit, ...publicResult } = result as {
        refusalSideEffects?: unknown;
        [key: string]: unknown;
      };

      return {
        content: [{ type: "text", text: result.message }],
        structuredContent: {
          yourAgentId: agentId,
          ...publicResult,
        },
      };
    },
  );
};
