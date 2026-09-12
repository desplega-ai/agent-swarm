import { ensure } from "@desplega.ai/business-use";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { resolveTaskAuditUserId } from "@/be/audit-user";
import {
  completeTask,
  createScheduledTask,
  getAgentById,
  getDbClient,
  getTaskById,
  updateAgentStatusFromCapacity,
} from "@/be/db";
import { runTaskTerminalEffects } from "@/tasks/task-terminal-effects";
import { getTaskOutputValidationError } from "@/tasks/terminal-result-guard";
import { assertOwnsTask, ownerCtx } from "@/tools/task-tool-ctx";
import { createToolRegistrar, swarmToolOutputSchema, toolErr, toolOk } from "@/tools/utils";
import { isTerminalTaskStatus } from "@/types";

/** Thrown inside the transaction to abort and roll back the schedule INSERT. */
class DeferAbortedError extends Error {}

/** Render `note` + optional `checks` as the plain-text tail both texts share. */
function renderChecks(checks?: string[]): string {
  if (!checks || checks.length === 0) return "";
  return `\n\nChecks:\n${checks.map((c) => `- ${c}`).join("\n")}`;
}

export const registerDeferTaskTool = (server: McpServer) => {
  createToolRegistrar(server)(
    "defer-task",
    {
      title: "Defer Task",
      annotations: { destructiveHint: false, idempotentHint: false },
      description:
        "Completes this task now with status `completed` and books a wake-up for you. Use when the result needs time: a build, a deploy, a reply. The task reaches its final state on this call; the lead sees your summary as its output. A one-off schedule wakes you up later with a child task that carries this task as its parent. Provide delayMs or runAt, a summary of what you did, and a note that says what is pending and what to check.",
      inputSchema: z.object({
        taskId: z.string().describe("The ID of the task you are working on."),
        delayMs: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Wake up after this many milliseconds (e.g. 1800000 for 30 min)."),
        runAt: z
          .string()
          .datetime()
          .optional()
          .describe("Wake up at this ISO datetime (e.g. '2026-03-06T15:00:00Z'). Must be future."),
        summary: z
          .string()
          .min(1)
          .max(4000)
          .describe(
            "What you did so far and where things stand. This becomes the task's output; the lead and your wake-up run both read it.",
          ),
        note: z
          .string()
          .min(1)
          .max(2000)
          .describe("What is pending, and what to check on wake-up."),
        checks: z
          .array(z.string().min(1))
          .max(20)
          .optional()
          .describe("Concrete things to verify on wake-up, one per entry."),
      }),
      outputSchema: swarmToolOutputSchema({
        yourAgentId: z.string().optional(),
        taskId: z.string().optional(),
        scheduleId: z.string().optional(),
        nextRunAt: z.string().optional(),
      }),
    },
    async ({ taskId, delayMs, runAt, summary, note, checks }, requestInfo, _meta) => {
      if (!requestInfo.agentId) {
        return toolErr('Agent ID not found. Set the "X-Agent-ID" header.');
      }
      const agent = await getAgentById(requestInfo.agentId);
      if (!agent) {
        return toolErr(`Agent not found: ${requestInfo.agentId}`);
      }

      const task = await getTaskById(taskId);
      if (!task) {
        return toolErr(`Task with ID "${taskId}" not found.`);
      }

      const forbidden = assertOwnsTask(ownerCtx(requestInfo), task);
      if (forbidden) return forbidden;

      // A deferral completes the task and books a wake-up for the CALLER, so
      // only the assignee may defer. `assertOwnsTask` above is the RBAC
      // chokepoint; it does not (today) constrain agent-to-agent access.
      if (task.agentId !== requestInfo.agentId) {
        return toolErr(`Task "${taskId}" is not assigned to you.`);
      }

      if (isTerminalTaskStatus(task.status)) {
        return toolErr(`Task ${taskId} is already ${task.status}; nothing to defer.`);
      }

      // A workflow step's completion drives `src/workflows/resume.ts` to advance
      // `next` nodes immediately using this call's output. The scheduled wake-up
      // task runs outside that workflow run and has no way to feed its eventual
      // result back into the step, so the workflow would advance on a deferral
      // note instead of the real result. Not supported: fail the step normally
      // (or use a workflow-native wait) instead of deferring it.
      if (task.workflowRunId) {
        return toolErr(
          `Task ${taskId} is owned by workflow run ${task.workflowRunId}; workflow-owned tasks cannot be deferred.`,
        );
      }

      if (!delayMs && !runAt) {
        return toolErr("Provide either delayMs or runAt.");
      }
      if (delayMs && runAt) {
        return toolErr("Provide either delayMs or runAt, not both.");
      }
      if (runAt && new Date(runAt).getTime() <= Date.now()) {
        return toolErr("runAt must be in the future.");
      }
      const nextRunAt = delayMs ? new Date(Date.now() + delayMs).toISOString() : runAt!;

      const checksBlock = renderChecks(checks);
      const taskTemplate = `Resume task ${taskId}: ${note}${checksBlock}`;
      const createdBy =
        (await resolveTaskAuditUserId(requestInfo.sourceTaskId, requestInfo.agentId)) ?? undefined;

      // The deferral note is written as the task's FINAL output — a task with
      // an outputSchema must satisfy it on completion (store-progress enforces
      // the same rule). Validate before creating anything: the real schedule
      // id isn't known yet, but it never changes whether this prose is valid
      // JSON against the schema, so a placeholder stands in for it here.
      const previewOutput = `${summary}\n\nDeferred until ${nextRunAt} (schedule pending). Pending: ${note}${checksBlock}`;
      const outputValidationError = getTaskOutputValidationError(task.outputSchema, previewOutput);
      if (outputValidationError) {
        return toolErr(
          `Task ${taskId} has an outputSchema; its terminal output must satisfy it, but a deferral note cannot. ${outputValidationError}`,
        );
      }

      try {
        const committed = await getDbClient().transaction(async () => {
          const schedule = await createScheduledTask({
            // Unique name (`getScheduledTaskByName` is a unique lookup). The ms
            // timestamp keeps repeated deferrals of the same task from colliding.
            name: `deferred-${taskId.slice(0, 8)}-${Date.now()}`,
            description: note,
            taskTemplate,
            targetType: "agent-task",
            scheduleType: "one_time",
            nextRunAt,
            targetAgentId: requestInfo.agentId,
            createdByAgentId: requestInfo.agentId,
            taskType: "deferred",
            tags: ["deferred"],
            priority: task.priority,
            // No `model`: a concrete provider model pinned now can be
            // incompatible with the assignee/provider at wake-up, especially
            // after a delay. Only the portable modelTier travels — mirrors
            // the non-inheriting continuation path in `src/be/db.ts`.
            modelTier: task.modelTier,
            parentTaskId: taskId,
            createdBy,
          });

          const output = `${summary}\n\nDeferred until ${nextRunAt} (schedule ${schedule.id}). Pending: ${note}${checksBlock}`;

          // Deliberately NOT running `getTaskOutputValidationError` again here:
          // already validated above against a placeholder id; re-run would be
          // redundant since the id never affects JSON-shape validity.
          const completed = await completeTask(taskId, output);
          if (!completed) {
            // Another writer terminally completed/failed/cancelled this task
            // between our early check and this transaction's write. Abort:
            // rolling back here discards the schedule INSERT so no orphan
            // wake-up is committed, and no terminal effects fire for a
            // completion that didn't happen on this call.
            throw new DeferAbortedError(
              `Task ${taskId} reached a terminal state before this deferral committed.`,
            );
          }

          // afterCommit: the transaction can still roll back; business-use must
          // not be told the task completed for a write that never landed.
          getDbClient().afterCommit(() => {
            ensure({
              id: "completed",
              flow: "task",
              runId: taskId,
              depIds: task.wasPaused ? ["started", "resumed"] : ["started"],
              data: {
                taskId,
                agentId: task.agentId,
                previousStatus: task.status,
                hasOutput: true,
              },
              validator: (data) => data.previousStatus === "in_progress",
              // biome-ignore lint/correctness/noEmptyPattern: data unused, ctx needed
              filter: ({}, ctx) => ctx.deps.length > 0,
              conditions: [{ timeout_ms: 3_600_000 }], // 1 hour
            });
          });

          if (task.agentId) {
            await updateAgentStatusFromCapacity(task.agentId);
          }

          return { scheduleId: schedule.id, output, completed };
        });

        await runTaskTerminalEffects({
          task: committed.completed,
          status: "completed",
          output: committed.output,
          agentId: requestInfo.agentId,
        });

        return toolOk(
          `Task ${taskId} completed and deferred. Wake-up at ${nextRunAt} (schedule ${committed.scheduleId}). This task is final; the wake-up task continues the work.`,
          {
            data: {
              yourAgentId: requestInfo.agentId,
              taskId,
              scheduleId: committed.scheduleId,
              nextRunAt,
            },
          },
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error";
        return toolErr(`Failed to defer task: ${message}`, {
          data: { yourAgentId: requestInfo.agentId, taskId },
        });
      }
    },
  );
};
