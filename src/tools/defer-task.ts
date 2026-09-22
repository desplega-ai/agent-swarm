import { ensure } from "@desplega.ai/business-use";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { resolveTaskAuditUserId } from "@/be/audit-user";
import {
  completeTask,
  createLogEntry,
  createScheduledTask,
  getAgentById,
  getDbClient,
  getTaskById,
  getUserById,
  updateAgentStatusFromCapacity,
} from "@/be/db";
import { reconcileDeferredTaskWaits } from "@/scheduler/deferred-task-waits";
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

/** Date/time parts of `date` as rendered in IANA zone `tz`. */
function partsInTz(date: Date, tz: string) {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  const parts = Object.fromEntries(fmt.formatToParts(date).map((p) => [p.type, p.value]));
  // Some locales render midnight as "24" under hour12: false.
  const hour = parts.hour === "24" ? "00" : parts.hour;
  return {
    year: parts.year!,
    month: parts.month!,
    day: parts.day!,
    hour: hour!,
    minute: parts.minute!,
    second: parts.second!,
  };
}

/**
 * "today"/"tomorrow" or "MM-dd" plus "HH:MM", both computed in `tz`.
 * Falls back to UTC (parts still computed correctly) if `tz` is not a valid
 * IANA zone — the caller decides whether to label the fallback.
 */
function formatDeferralDateTime(
  target: Date,
  now: Date,
  tz: string,
): { date: string; time: string } {
  let zone = tz;
  try {
    Intl.DateTimeFormat("en-US", { timeZone: zone });
  } catch {
    zone = "UTC";
  }
  const t = partsInTz(target, zone);
  // Minute precision: this string is read by a human deciding whether to wait,
  // and the wake-up is scheduler-polled anyway, so seconds were false precision.
  const time = `${t.hour}:${t.minute}`;
  const n = partsInTz(now, zone);
  if (t.year === n.year && t.month === n.month && t.day === n.day) return { date: "today", time };
  const tm = partsInTz(new Date(now.getTime() + 86_400_000), zone);
  if (t.year === tm.year && t.month === tm.month && t.day === tm.day) {
    return { date: "tomorrow", time };
  }
  return { date: `${t.month}-${t.day}`, time };
}

/**
 * Resolve the requesting human's IANA timezone from `users.timezone` via
 * `task.requestedByUserId`. We do not currently capture a Slack profile `tz`
 * anywhere in the ingest path (checked `src/slack/enrich.ts`, the only place
 * that reads `users.info`) — a user only has a timezone here if someone set
 * it explicitly via `manage-user`. Falls back to UTC, flagged as such.
 */
async function resolveRequesterTimezone(
  requestedByUserId: string | undefined,
): Promise<{ tz: string; isFallback: boolean }> {
  if (requestedByUserId) {
    const user = await getUserById(requestedByUserId);
    if (user?.timezone) return { tz: user.timezone, isFallback: false };
  }
  return { tz: "UTC", isFallback: true };
}

/** "Researcher", "Researcher and Picateclas", "A, B and C". */
function joinNames(names: string[]): string {
  if (names.length < 2) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/**
 * Who a `wakeOn` deferral is waiting on, in the card's words: the distinct
 * agent names behind the watched tasks, or a bare count when none of them is
 * assigned (an unassigned watched task has no name a human would recognise).
 */
export function renderWaitingOn(agentNames: string[], watchedCount: number): string {
  const named = joinNames([...new Set(agentNames.filter((name) => name.trim()))]);
  if (named) return named;
  return `${watchedCount} task${watchedCount === 1 ? "" : "s"}`;
}

/** "today at 18:38" / "tomorrow at 18:38" / "on 09-24 at 18:38". */
function renderWhen(nextRunAt: string, tz: string, isFallbackTz: boolean): string {
  const { date, time } = formatDeferralDateTime(new Date(nextRunAt), new Date(), tz);
  const timeLabel = isFallbackTz ? `${time} UTC` : time;
  const day = date === "today" || date === "tomorrow" ? date : `on ${date}`;
  return `${day} at ${timeLabel}`;
}

/**
 * Human-facing deferral text for tasks without an outputSchema — this is what
 * lands verbatim in a human's Slack thread as the task's terminal output, and
 * in the UI's task-detail output row.
 *
 * It answers one question — when does this come back — in the two shapes a
 * deferral actually has:
 *
 *   time-based  (no wakeOn)  `Checking back today at 18:38`
 *   event-based (wakeOn)     `Waiting on Researcher — or today at 18:38 at the latest`
 *
 * A wakeOn deferral always carries a time ceiling too (`delayMs`/`runAt` is
 * required), so the "both" wording is the only event shape reachable — which
 * is also the honest one: the event resumes it, the ceiling guarantees it.
 *
 * Deliberately absent: the agent's `note` (written for the wake-up agent, not
 * for a human — it goes to the task log and the wake-up task's template), the
 * `checks` list, the schedule UUID and its app.agent-swarm.dev link. The glyph
 * is added by the Slack renderer, matching how ✅/❌ outcomes are composed.
 */
function renderHumanFacingDeferral(
  nextRunAt: string,
  tz: string,
  isFallbackTz: boolean,
  waitingOn: string | undefined,
): string {
  const when = renderWhen(nextRunAt, tz, isFallbackTz);
  return waitingOn ? `Waiting on ${waitingOn} — or ${when} at the latest` : `Checking back ${when}`;
}

export const registerDeferTaskTool = (server: McpServer) => {
  createToolRegistrar(server)(
    "defer-task",
    {
      title: "Defer Task",
      annotations: { destructiveHint: false, idempotentHint: false },
      description:
        "Completes this task now with status `completed` and books a wake-up for you. Use when the result needs time: a build, a deploy, a reply. The task reaches its final state on this call; the lead sees your summary as its output unless the task has an outputSchema. For a task with an outputSchema, provide output as a JSON string matching that schema; it is stored verbatim as terminal output, while deferral details remain visible in the task log. A one-off schedule wakes you up later with a child task that carries this task as its parent. Optionally provide wakeOn with taskId or taskIds to wake early on task outcomes; mode defaults to all, or use any for the first match. delayMs or runAt remains required as the ceiling for the whole set. Provide delayMs or runAt, a summary of what you did, and a note that says what is pending and what to check.",
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
        wakeOn: z
          .object({
            event: z.enum(["task.completed", "task.failed", "settled"]),
            taskId: z.string().min(1).optional(),
            taskIds: z.array(z.string().min(1)).min(1).optional(),
            mode: z.enum(["all", "any"]).optional(),
          })
          .strict()
          .refine((wake) => (wake.taskId !== undefined) !== (wake.taskIds !== undefined), {
            message: "Provide exactly one of wakeOn.taskId or wakeOn.taskIds.",
          })
          .refine((wake) => !wake.taskIds || new Set(wake.taskIds).size === wake.taskIds.length, {
            message: "wakeOn.taskIds must not contain duplicates.",
          })
          .optional()
          .describe(
            "Wake early on a task event. Provide taskId or nonempty, unique taskIds. mode defaults to all (every member must match); any wakes on the first match. settled covers completed, failed, or cancelled. Deferred and superseded members follow their continuations; a superseded member without a resume child holds to the ceiling. Any already-terminal member rejects the request; one delayMs/runAt ceiling is still required for the whole set.",
          ),
        summary: z
          .string()
          .min(1)
          .max(4000)
          .describe(
            "What you did so far and where things stand. Stored in the task log for tasks with an outputSchema; otherwise becomes the task's output.",
          ),
        output: z
          .string()
          .optional()
          .describe(
            "Required when the task has an outputSchema: a JSON string matching that schema, stored verbatim as terminal output. Ignored for tasks without an outputSchema.",
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
    async (
      { taskId, delayMs, runAt, wakeOn, summary, output, note, checks },
      requestInfo,
      _meta,
    ) => {
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

      const watchedTaskIds = wakeOn?.taskIds ?? (wakeOn?.taskId ? [wakeOn.taskId] : []);
      const wakeMode = wakeOn?.mode ?? "all";
      const wakeDescription = wakeOn
        ? `on ${wakeOn.event} for ${wakeMode} of tasks ${watchedTaskIds.join(", ")}, or by ${nextRunAt}`
        : `at ${nextRunAt}`;
      const checksBlock = renderChecks(checks);
      const taskTemplate = `Resume task ${taskId}: ${note}${checksBlock}`;
      const createdBy =
        (await resolveTaskAuditUserId(requestInfo.sourceTaskId, requestInfo.agentId)) ?? undefined;

      // Validate before creating the schedule or changing the task.
      if (task.outputSchema) {
        if (!output) {
          return toolErr(
            `Task ${taskId} has an outputSchema. Call defer-task with output: a JSON string matching that schema. Summary and note are stored separately in the task log.`,
          );
        }
        const outputValidationError = getTaskOutputValidationError(task.outputSchema, output);
        if (outputValidationError) return toolErr(outputValidationError);
      }

      const { tz: requesterTz, isFallback: isFallbackTz } = await resolveRequesterTimezone(
        task.requestedByUserId,
      );

      try {
        const committed = await getDbClient().transaction(async () => {
          const watchedAgentNames: string[] = [];
          for (const watchedId of watchedTaskIds) {
            if (watchedId === taskId)
              throw new DeferAbortedError("Cannot wake on the task being deferred.");
            const watched = await getTaskById(watchedId);
            if (!watched) throw new DeferAbortedError(`Watched task ${watchedId} not found.`);
            if (isTerminalTaskStatus(watched.status))
              throw new DeferAbortedError(
                `Watched task ${watchedId} is already ${watched.status}; read its result instead of deferring.`,
              );
            // Resolved now, not at render time: the card is baked into the
            // task's terminal output, and an agent can be renamed or removed
            // between the deferral and whoever reads the thread later.
            const watchedAgent = watched.agentId ? await getAgentById(watched.agentId) : null;
            if (watchedAgent?.name) watchedAgentNames.push(watchedAgent.name);
          }
          const schedule = await createScheduledTask({
            // Unique name (`getScheduledTaskByName` is a unique lookup). The UUID
            // prevents concurrent deferrals of the same task from colliding.
            name: `deferred-${taskId.slice(0, 8)}-${Date.now()}-${crypto.randomUUID()}`,
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
            // Provenance: `nextRunAt` is cleared once this one_time schedule
            // fires, so the requested delay is only recoverable from here.
            requestedDelayMs: delayMs,
            requestedRunAt: runAt,
            // No `model`: a concrete provider model pinned now can be
            // incompatible with the assignee/provider at wake-up, especially
            // after a delay. Only the portable modelTier travels — mirrors
            // the non-inheriting continuation path in `src/be/db.ts`.
            modelTier: task.modelTier,
            parentTaskId: taskId,
            createdBy,
          });

          if (wakeOn) {
            await getDbClient().run(
              "INSERT INTO deferred_task_waits (scheduleId, eventName, mode, created_by, updated_by) VALUES (?, ?, ?, ?, ?)",
              [schedule.id, wakeOn.event, wakeMode, createdBy ?? null, createdBy ?? null],
            );
            for (const watchedId of watchedTaskIds) {
              await getDbClient().run(
                "INSERT INTO deferred_task_wait_members (scheduleId, taskId, created_by, updated_by) VALUES (?, ?, ?, ?)",
                [schedule.id, watchedId, createdBy ?? null, createdBy ?? null],
              );
            }
            getDbClient().afterCommit(() => {
              void Promise.all(watchedTaskIds.map((id) => reconcileDeferredTaskWaits(id))).catch(
                (err) => {
                  console.error("[defer-task] Event wake reconciliation failed:", err);
                },
              );
            });
          }

          // Full detail for the task log — ISO timestamp, schedule id, checks.
          // Never shown to a human directly; the wake-up task gets note+checks
          // through taskTemplate instead.
          const deferralDetails = `${summary}\n\nDeferred until ${nextRunAt} (schedule ${schedule.id}). Pending: ${note}${checksBlock}`;

          const terminalOutput = task.outputSchema
            ? output!
            : renderHumanFacingDeferral(
                nextRunAt,
                requesterTz,
                isFallbackTz,
                wakeOn ? renderWaitingOn(watchedAgentNames, watchedTaskIds.length) : undefined,
              );
          const completed = await completeTask(taskId, terminalOutput, {
            addTags: ["deferred"],
            deferredAt: new Date().toISOString(),
          });
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

          await createLogEntry({
            eventType: "task_progress",
            taskId,
            agentId: requestInfo.agentId,
            newValue: deferralDetails,
          });

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

          return { scheduleId: schedule.id, output: terminalOutput, completed };
        });

        await runTaskTerminalEffects({
          task: committed.completed,
          status: "completed",
          output: committed.output,
          agentId: requestInfo.agentId,
        });

        return toolOk(
          `Task ${taskId} completed and deferred. Wake-up ${wakeDescription} (schedule ${committed.scheduleId}). This task is final; the wake-up task continues the work.`,
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
