import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { resolveTaskAuditUserId } from "@/be/audit-user";
import {
  completeTask,
  createLogEntry,
  createScheduledTask,
  getAgentById,
  getTaskById,
  updateAgentStatusFromCapacity,
} from "@/be/db";
import { resolveRequesterTimezone } from "@/be/requester-timezone";
import { getStorage } from "@/be/storage";
import {
  describeEventWait,
  type EventMatch,
  EXTERNAL_EVENT_ADAPTERS,
  EXTERNAL_EVENT_NAMES,
  EXTERNAL_EVENTS_DOC,
  type ExternalEventAdapter,
  getExternalEventAdapter,
  matchKeyOf,
  toConfirmResult,
} from "@/event-waits";
import {
  MAX_PENDING_EVENT_WAITS_PER_AGENT,
  reconcileDeferredEventWaits,
  reconcileDeferredTaskWaits,
} from "@/scheduler/deferred-task-waits";
import { runTaskTerminalEffects } from "@/tasks/task-terminal-effects";
import { getTaskOutputValidationError } from "@/tasks/terminal-result-guard";
import { assertOwnsTask, ownerCtx } from "@/tools/task-tool-ctx";
import { createToolRegistrar, swarmToolOutputSchema, toolErr, toolOk } from "@/tools/utils";
import { isTerminalTaskStatus } from "@/types";
import { formatDeferralDateTime } from "@/utils/deferral-time";
import { ensure } from "../utils/business-use";
import { getCurrentRequestAuth } from "../utils/request-auth-context";

const isExternalEvent = (event: string) => EXTERNAL_EVENT_NAMES.includes(event);

/**
 * Resolve and vet an external-event wait before any write: the adapter exists and
 * serves the event, its integration is on, the match parses, and the event has not
 * already happened (a read, when the adapter can confirm). Returns a user-facing error otherwise.
 */
async function admitExternalWait(
  event: string,
  source: string,
  rawMatch: unknown,
): Promise<{ adapter: ExternalEventAdapter; match: EventMatch } | { error: string }> {
  const adapter = getExternalEventAdapter(source);
  if (!adapter?.events.includes(event)) {
    const served = EXTERNAL_EVENT_ADAPTERS.filter((a) => a.events.includes(event)).map(
      (a) => a.source,
    );
    return {
      error: `Source "${source}" does not serve ${event}; use one of: ${served.join(", ")}.`,
    };
  }
  let match: EventMatch;
  try {
    match = adapter.parseMatch(event, rawMatch);
  } catch (error) {
    return { error: error instanceof Error ? error.message : "Invalid match." };
  }
  const target = describeEventWait(source, event, match);
  // A confirm read may use server-held credentials: refuse the ACP task tokens that
  // /api/github/installation-token also refuses.
  const auth = getCurrentRequestAuth();
  if (adapter.readsWithServerCredentials && auth?.kind === "agent" && auth.tokenKind === "task") {
    return {
      error: "A task-scoped token cannot defer on an external event; defer on a timer instead.",
    };
  }
  if (!adapter.isEnabled()) {
    return {
      error: `The ${source} integration is off, so no event can wake you; defer on a timer instead.`,
    };
  }
  if (adapter.confirm) {
    try {
      const already = toConfirmResult(await adapter.confirm(event, match));
      if (already.happened) {
        return {
          error: `${target} already happened${already.detail ? ` (${already.detail})` : ""}; read its result instead of deferring.`,
        };
      }
    } catch (error) {
      return {
        error: `Could not read ${target} from ${source} (${error instanceof Error ? error.message : "unknown error"}); defer on a timer instead.`,
      };
    }
  }
  return { adapter, match };
}

/** Thrown inside the transaction to abort and roll back the schedule INSERT. */
class DeferAbortedError extends Error {}

/** Render `note` + optional `checks` as the plain-text tail both texts share. */
function renderChecks(checks?: string[]): string {
  if (!checks || checks.length === 0) return "";
  return `\n\nChecks:\n${checks.map((c) => `- ${c}`).join("\n")}`;
}

/** "Researcher", "Researcher and Picateclas", "A, B and C". */
function joinNames(names: string[]): string {
  if (names.length < 2) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/**
 * Who a `wakeOn` deferral is waiting on, in the card's words: the distinct
 * agent names behind the watched tasks, else the title of a single watched
 * task, else a bare count (an unassigned task has no name a human would
 * recognise).
 */
export function renderWaitingOn(
  agentNames: string[],
  watchedCount: number,
  titles: string[] = [],
): string {
  const named = joinNames([...new Set(agentNames.filter((name) => name.trim()))]);
  if (named) return named;
  if (watchedCount === 1 && titles[0]?.trim()) return titles[0].trim();
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
 * Human-facing deferral text for tasks without an outputSchema — the task's
 * terminal output, shown in the UI's task-detail output row. Slack reads it
 * through `slackTaskOutput`, which re-renders the wake-up time from
 * `deferredUntil`.
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
        'Completes this task now with status `completed` and books a wake-up for you. Use when the result needs time: a build, a deploy, a reply. The task reaches its final state on this call; the lead sees your summary as its output unless the task has an outputSchema. For a task with an outputSchema, provide output as a JSON string matching that schema; it is stored verbatim as terminal output, while deferral details remain visible in the task log. A one-off schedule wakes you up later with a child task that carries this task as its parent. Optionally provide wakeOn with taskId or taskIds to wake early on task outcomes; mode defaults to all, or use any for the first match. Or provide wakeOn {event, source, match} to wake on an external event, e.g. {event: "vcs.pr.merged", source: "github", match: {repo, number}}. delayMs or runAt remains required as the ceiling for the whole set. Provide delayMs or runAt, a summary of what you did, and a note that says what is pending and what to check.',
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
            event: z.enum(["task.completed", "task.failed", "settled", ...EXTERNAL_EVENT_NAMES]),
            taskId: z.string().min(1).optional(),
            taskIds: z.array(z.string().min(1)).min(1).optional(),
            mode: z.enum(["all", "any"]).optional(),
            source: z.string().min(1).optional(),
            match: z.record(z.string(), z.union([z.string(), z.number()])).optional(),
          })
          .strict()
          .refine(
            (wake) =>
              isExternalEvent(wake.event) ||
              (wake.taskId !== undefined) !== (wake.taskIds !== undefined),
            { message: "Provide exactly one of wakeOn.taskId or wakeOn.taskIds." },
          )
          .refine(
            (wake) =>
              isExternalEvent(wake.event)
                ? wake.source !== undefined &&
                  wake.match !== undefined &&
                  wake.taskId === undefined &&
                  wake.taskIds === undefined &&
                  wake.mode === undefined
                : wake.source === undefined && wake.match === undefined,
            {
              message:
                "External events (e.g. vcs.pr.merged) take source and match only; task events take no source or match.",
            },
          )
          .refine((wake) => !wake.taskIds || new Set(wake.taskIds).size === wake.taskIds.length, {
            message: "wakeOn.taskIds must not contain duplicates.",
          })
          .optional()
          .describe(
            `Wake early on a task event. Provide taskId or nonempty, unique taskIds. mode defaults to all (every member must match); any wakes on the first match. settled covers completed, failed, cancelled, or skipped. Deferred and superseded members follow their continuations; a superseded member without a resume child holds to the ceiling, except a workflow step superseded by its queued retry, which counts as failed. Any already-terminal member rejects the request; one delayMs/runAt ceiling is still required for the whole set. External events: ${EXTERNAL_EVENTS_DOC}. They are rejected when the event already happened, the provider cannot be read, or its integration is off; an agent holds at most ${MAX_PENDING_EVENT_WAITS_PER_AGENT} pending external waits. The member whose settlement wakes you creates no separate lead follow-up for your agent unless its followUpConfig sets onCompleted/onFailed; an all-mode member that settles while others are pending still does.`,
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
      const eventWait = wakeOn && isExternalEvent(wakeOn.event) ? wakeOn : undefined;
      const wakeDescription = eventWait
        ? `on ${eventWait.event} from ${eventWait.source}, or by ${nextRunAt}`
        : wakeOn
          ? `on ${wakeOn.event} for ${wakeMode} of tasks ${watchedTaskIds.join(", ")}, or by ${nextRunAt}`
          : `at ${nextRunAt}`;
      const checksBlock = renderChecks(checks);
      const taskTemplate = `Resume task ${taskId}: ${note}${checksBlock}`;
      // Not the audit task: the wake-up task is requested by the schedule's created_by.
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

      // Read the provider before the transaction: no network call under the write lock.
      let admitted: { adapter: ExternalEventAdapter; match: EventMatch } | undefined;
      if (eventWait) {
        const result = await admitExternalWait(eventWait.event, eventWait.source!, eventWait.match);
        if ("error" in result) return toolErr(result.error);
        admitted = result;
      }

      try {
        const storage = getStorage();
        const tasks = storage.repos.tasks;
        const committed = await storage.transaction(async () => {
          if (admitted) {
            const pending = await tasks.countPendingEventWaitsForAgent(agent.id);
            if (pending >= MAX_PENDING_EVENT_WAITS_PER_AGENT) {
              throw new DeferAbortedError(
                `You already hold ${MAX_PENDING_EVENT_WAITS_PER_AGENT} pending external event waits; wait for one to fire.`,
              );
            }
          }
          // The transaction's write lock makes admission atomic with the INSERT.
          if (watchedTaskIds.length) {
            const existing = await tasks.findPendingTaskWaitWatching(agent.id, watchedTaskIds);
            if (existing) {
              throw new DeferAbortedError(
                `Pending watcher ${existing.scheduleId} (task ${existing.parentTaskId}) already watches these tasks for this agent.`,
              );
            }
          }
          const watchedAgentNames: string[] = [];
          const watchedTitles: string[] = [];
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
            if (watched.title) watchedTitles.push(watched.title);
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

          if (admitted && eventWait) {
            const matchKey = matchKeyOf(admitted.match);
            await tasks.insertDeferredEventWait({
              scheduleId: schedule.id,
              source: admitted.adapter.source,
              event: eventWait.event,
              matchKey,
              matchJson: JSON.stringify(admitted.match),
              userId: createdBy ?? null,
            });
            // The event may land between the read above and this commit; recheck after it.
            getStorage().afterCommit(() => {
              void reconcileDeferredEventWaits({
                source: admitted.adapter.source,
                event: eventWait.event,
                matchKey,
              }).catch((err) => {
                console.error("[defer-task] external event wake reconciliation failed:", err);
              });
            });
          } else if (wakeOn) {
            await tasks.insertDeferredTaskWait({
              scheduleId: schedule.id,
              eventName: wakeOn.event,
              mode: wakeMode,
              userId: createdBy ?? null,
            });
            for (const watchedId of watchedTaskIds) {
              await tasks.insertDeferredTaskWaitMember(schedule.id, watchedId, createdBy ?? null);
            }
            getStorage().afterCommit(() => {
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
                admitted && eventWait
                  ? describeEventWait(admitted.adapter.source, eventWait.event, admitted.match)
                  : wakeOn
                    ? renderWaitingOn(watchedAgentNames, watchedTaskIds.length, watchedTitles)
                    : undefined,
              );
          const completed = await completeTask(taskId, terminalOutput, {
            addTags: ["deferred"],
            deferredAt: new Date().toISOString(),
            deferredUntil: nextRunAt,
            statusKind: "deferred",
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
          getStorage().afterCommit(() => {
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
