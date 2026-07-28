import type { IncomingMessage, ServerResponse } from "node:http";
import { ensure } from "@desplega.ai/business-use";
import { z } from "zod";
import { canClaim } from "../be/budget-admission";
import {
  type BudgetRefusalContext,
  emitBudgetRefusalSideEffects,
} from "../be/budget-refusal-notify";
import {
  claimMentions,
  claimOfferedTask,
  claimTask,
  getAgentById,
  getAllChannelActivityCursors,
  getDb,
  getInboxSummary,
  getOfferedTasksForAgent,
  getPendingTaskForAgent,
  getTaskAttachments,
  getTaskById,
  getUnassignedTaskIdsForAgent,
  getUserById,
  hasCapacity,
  recordBudgetRefusalNotification,
  startTask,
  upsertChannelActivityCursor,
} from "../be/db";
import { renderIdentity, resolveIdentity } from "../be/identity";
import { runClaimRouting } from "../routing/claim";
import { hasHandlersForVia } from "../routing/engine";
import { hasCapability } from "../server";
import { fetchChannelActivity } from "../slack/channel-activity";
import { telemetry } from "../telemetry";
import { route } from "./route-def";
import { json, jsonError } from "./utils";

// ─── Budget-refused trigger envelope ────────────────────────────────────────

/**
 * Build the `budget_refused` trigger envelope from a `canClaim` refusal. Lives
 * here (not in budget-admission) because it's the API-shape contract — workers
 * read this on the wire (Phase 4 teaches them how).
 *
 * Phase 5: each refusal site additionally calls
 * `recordBudgetRefusalNotification` (in-txn) and
 * `emitBudgetRefusalSideEffects` (after-commit) to drive the lead follow-up
 * + workflow bus emit. See `src/be/budget-refusal-notify.ts`.
 */
function buildBudgetRefusedTrigger(refusal: {
  cause: "agent" | "global" | "user";
  agentSpend?: number;
  agentBudget?: number;
  globalSpend?: number;
  globalBudget?: number;
  userSpend?: number;
  userBudget?: number;
  resetAt: string;
}): { type: "budget_refused"; [key: string]: unknown } {
  const trigger: { type: "budget_refused"; [key: string]: unknown } = {
    type: "budget_refused",
    cause: refusal.cause,
    resetAt: refusal.resetAt,
  };
  if (refusal.agentSpend !== undefined) trigger.agentSpend = refusal.agentSpend;
  if (refusal.agentBudget !== undefined) trigger.agentBudget = refusal.agentBudget;
  if (refusal.globalSpend !== undefined) trigger.globalSpend = refusal.globalSpend;
  if (refusal.globalBudget !== undefined) trigger.globalBudget = refusal.globalBudget;
  if (refusal.userSpend !== undefined) trigger.userSpend = refusal.userSpend;
  if (refusal.userBudget !== undefined) trigger.userBudget = refusal.userBudget;
  return trigger;
}

// ─── Route Definitions ───────────────────────────────────────────────────────

const pollTriggers = route({
  method: "get",
  path: "/api/poll",
  pattern: ["api", "poll"],
  summary: "Poll for triggers (tasks, mentions)",
  tags: ["Poll"],
  auth: { apiKey: true, agentId: true },
  responses: {
    200: { description: "Trigger data or null" },
    400: { description: "Missing X-Agent-ID" },
    404: { description: "Agent not found" },
  },
});

// ─── Channel Activity Throttle ──────────────────────────────────────────────

const CHANNEL_ACTIVITY_INTERVAL_MS = 60_000; // Check at most once per 60s
let lastChannelActivityCheckAt = 0;

// ─── Claim-routing pre-pass bounds ──────────────────────────────────────────

/**
 * How far down the eligible pool the claim pre-pass may look. Must exceed
 * `CLAIM_ROUTING_MAX_EVALUATIONS` so a blocked head of line cannot hide the
 * rows behind it from every subsequent poll.
 */
const CLAIM_ROUTING_SCAN_LIMIT = 25;

/**
 * Handler evaluations (i.e. script subprocess spawns, ~180ms p50) allowed per
 * poll. Bounds worst-case poll latency; the heartbeat sweep picks up whatever
 * this budget doesn't reach.
 */
const CLAIM_ROUTING_MAX_EVALUATIONS = 5;

function getRequesterNotes(notes: string | undefined): string | undefined {
  return typeof notes === "string" && notes.trim().length > 0 ? notes : undefined;
}

/**
 * Slim attachment projection for the `task_assigned` poll trigger — just
 * enough (id, name, mimeType, sizeBytes) for the worker to build a one-shot
 * `/api/fs/tasks/{taskId}/files/{id}/raw` fetch recipe into the dispatch
 * prompt, without shipping the full capabilities/provider blob over poll.
 */
function attachmentsForTrigger(
  taskId: string,
): Array<{ id: string; name: string; mimeType?: string; sizeBytes?: number }> {
  return getTaskAttachments(taskId).map((a) => ({
    id: a.id,
    name: a.name,
    mimeType: a.mimeType,
    sizeBytes: a.sizeBytes,
  }));
}

// ─── Cursor Commit Endpoint ─────────────────────────────────────────────────

const commitCursorsRoute = route({
  method: "post",
  path: "/api/channel-activity/commit-cursors",
  pattern: ["api", "channel-activity", "commit-cursors"],
  summary: "Commit channel activity cursors after successful processing",
  tags: ["Poll"],
  auth: { apiKey: true },
  body: z.object({
    cursorUpdates: z.array(
      z.object({
        channelId: z.string(),
        ts: z.string(),
      }),
    ),
  }),
  responses: {
    200: { description: "Cursors committed" },
    400: { description: "Invalid request" },
  },
});

// ─── Handler ─────────────────────────────────────────────────────────────────

export async function handlePoll(
  req: IncomingMessage,
  res: ServerResponse,
  pathSegments: string[],
  queryParams: URLSearchParams,
  myAgentId: string | undefined,
): Promise<boolean> {
  // Handle cursor commit endpoint
  if (commitCursorsRoute.match(req.method, pathSegments)) {
    const parsed = await commitCursorsRoute.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    for (const { channelId, ts } of parsed.body.cursorUpdates) {
      if (channelId && ts) {
        upsertChannelActivityCursor(channelId, ts);
      }
    }
    json(res, { success: true, committed: parsed.body.cursorUpdates.length });
    return true;
  }

  if (pollTriggers.match(req.method, pathSegments)) {
    if (!myAgentId) {
      jsonError(res, "Missing X-Agent-ID header", 400);
      return true;
    }

    // Use transaction for consistent reads across all trigger checks
    type PollTxnResult =
      | { error: string; status: number }
      | {
          trigger: { type: string; [key: string]: unknown } | null;
          /**
           * Phase 5: when the trigger is `budget_refused`, the txn captures
           * the dedup-row state + the refused task's Slack context so the
           * after-commit step can resolve the template and create the lead
           * follow-up. Undefined for any other trigger.
           */
          refusalSideEffects?: { context: BudgetRefusalContext; inserted: boolean };
        };
    let result: PollTxnResult;

    // `runBeforeAssign` can spawn a script subprocess, so claim routing must
    // happen before the transaction below. When no claim-reachable handlers
    // exist this is one cheap declarative DB preflight and the hot path remains
    // unchanged. The transaction re-queries the pool and `claimTask` still
    // performs the final atomic status check after this async gap.
    let routedClaimCandidateIds: Set<string> | undefined;
    if (hasHandlersForVia("task.before_assign", "claim")) {
      routedClaimCandidateIds = new Set();
      const agent = getAgentById(myAgentId);
      // Only do the pool pre-pass when the poll will actually TAKE the pool
      // path. The transaction resolves offered → pending → pool, and neither
      // offered nor pending work consumes `hasCapacity`, so a worker sitting on
      // assigned work would otherwise spawn handler subprocesses for unrelated
      // pool tasks on every poll — writing traces/events/directives and
      // delaying its own trigger by several handler timeouts.
      //
      // Deliberately leaves the set EMPTY rather than undefined when skipping:
      // if a higher-priority trigger evaporates between here and the
      // transaction, the pool path finds no approved candidate and the worker
      // simply polls again, instead of claiming a task whose guards never ran.
      const hasHigherPriorityWork =
        getOfferedTasksForAgent(myAgentId).length > 0 || getPendingTaskForAgent(myAgentId) !== null;
      if (agent && !agent.isLead && !hasHigherPriorityWork && hasCapacity(myAgentId)) {
        // Scan deeper than the evaluation budget. Stopping at the first N rows
        // starved the pool: if routing rejected all N, every later poll
        // re-fetched the same ordered N, so lower-priority work this worker was
        // allowed to claim was never reached. Rows short-circuited as
        // `pending-decision` spawn no subprocess, so they don't consume budget
        // and the scan walks past a permanently-blocked head of line.
        const candidateIds = getUnassignedTaskIdsForAgent(myAgentId, CLAIM_ROUTING_SCAN_LIMIT);
        let evaluations = 0;
        for (const candidateId of candidateIds) {
          if (evaluations >= CLAIM_ROUTING_MAX_EVALUATIONS) break;
          const candidate = getTaskById(candidateId);
          if (!candidate) continue;
          const routing = await runClaimRouting(candidate, myAgentId, {
            // Pass the REMAINING budget into the run: without it, one
            // candidate matching more handlers than the budget allows would
            // execute all of them before the between-candidates check fires.
            maxHandlers: CLAIM_ROUTING_MAX_EVALUATIONS - evaluations,
          });
          // Budget on handlers actually EXECUTED, not candidates examined. A
          // candidate that short-circuits (`pending-decision`) or matches no
          // handler spawns no subprocess, so charging it would shrink how far
          // down the pool the scan reaches for no cost saved.
          evaluations += routing.ranHandlers;
          if (routing.kind === "proceed") {
            // The transaction claims at most one task — stop evaluating (and
            // spawning handler subprocesses for) further candidates.
            routedClaimCandidateIds.add(candidateId);
            break;
          }
        }
      }
    }

    try {
      result = getDb().transaction(() => {
        const agent = getAgentById(myAgentId);
        if (!agent) {
          return { error: "Agent not found", status: 404 };
        }

        // Check for offered tasks first (highest priority for both workers and leads)
        // Atomically claim the task for review to prevent duplicate processing
        const offeredTasks = getOfferedTasksForAgent(myAgentId);
        const firstOfferedTask = offeredTasks[0];
        if (firstOfferedTask) {
          const claimedTask = claimOfferedTask(firstOfferedTask.id, myAgentId);
          if (claimedTask) {
            return {
              trigger: {
                type: "task_offered",
                taskId: claimedTask.id,
                task: claimedTask,
              },
            };
          }
        }

        // Check for pending tasks (assigned directly to this agent)
        // Only return a task if agent has capacity (server-side enforcement)
        if (hasCapacity(myAgentId)) {
          const pendingTask = getPendingTaskForAgent(myAgentId);
          if (pendingTask) {
            // Budget admission gate (Phase 3). Runs in the same transaction as
            // the capacity check so capacity AND budget gates share atomicity.
            // Phase 5 also records the dedup row + captures the side-effect
            // context here so the after-commit step can notify the lead.
            const admission = canClaim(myAgentId, new Date(), pendingTask.requestedByUserId);
            if (!admission.allowed) {
              const utcDate = new Date().toISOString().slice(0, 10);
              const dedup = recordBudgetRefusalNotification({
                taskId: pendingTask.id,
                date: utcDate,
                agentId: myAgentId,
                cause: admission.cause,
                agentSpendUsd: admission.agentSpend,
                agentBudgetUsd: admission.agentBudget,
                globalSpendUsd: admission.globalSpend,
                globalBudgetUsd: admission.globalBudget,
                userSpendUsd: admission.userSpend,
                userBudgetUsd: admission.userBudget,
              });
              return {
                trigger: buildBudgetRefusedTrigger(admission),
                refusalSideEffects: {
                  context: {
                    task: {
                      id: pendingTask.id,
                      task: pendingTask.task,
                      requestedByUserId: pendingTask.requestedByUserId,
                      slackChannelId: pendingTask.slackChannelId,
                      slackThreadTs: pendingTask.slackThreadTs,
                      slackUserId: pendingTask.slackUserId,
                    },
                    agentId: myAgentId,
                    date: utcDate,
                    cause: admission.cause,
                    agentSpendUsd: admission.agentSpend,
                    agentBudgetUsd: admission.agentBudget,
                    globalSpendUsd: admission.globalSpend,
                    globalBudgetUsd: admission.globalBudget,
                    userSpendUsd: admission.userSpend,
                    userBudgetUsd: admission.userBudget,
                    resetAt: admission.resetAt,
                  },
                  inserted: dedup.inserted,
                },
              };
            }

            // Mark task as in_progress immediately to prevent duplicate polling
            startTask(pendingTask.id);

            ensure({
              id: "started",
              flow: "task",
              runId: pendingTask.id,
              depIds: ["created"],
              data: {
                taskId: pendingTask.id,
                agentId: myAgentId,
                previousStatus: pendingTask.status,
              },
              validator: (data) => data.previousStatus === "pending",
              // biome-ignore lint/correctness/noEmptyPattern: data unused, ctx needed
              filter: ({}, ctx) => ctx.deps.length > 0,
              conditions: [{ timeout_ms: 300_000 }], // 5 min: polling interval + queue wait
            });

            telemetry.taskEvent("started", {
              taskId: pendingTask.id,
              source: pendingTask.source,
              agentId: myAgentId,
            });

            // Resolve requesting user if available. If the task carries a
            // machine-recorded external id (today: the Slack user field) but
            // no requestedByUserId, render the explicit UNKNOWN sentinel
            // instead of silently omitting the section — never a substituted
            // human (Rule 33 / provenance-or-silence).
            const requestedByUser = pendingTask.requestedByUserId
              ? getUserById(pendingTask.requestedByUserId)
              : undefined;
            const requestedByNotes = getRequesterNotes(requestedByUser?.notes);
            const requestedByUnknownName =
              !requestedByUser && pendingTask.slackUserId
                ? renderIdentity(resolveIdentity("slack", pendingTask.slackUserId))
                : undefined;

            return {
              trigger: {
                type: "task_assigned",
                taskId: pendingTask.id,
                task: {
                  ...pendingTask,
                  status: "in_progress",
                  attachments: attachmentsForTrigger(pendingTask.id),
                },
                ...(requestedByUser && {
                  requestedBy: {
                    name: requestedByUser.name,
                    email: requestedByUser.email,
                    role: requestedByUser.role,
                    notes: requestedByNotes,
                  },
                }),
                ...(requestedByUnknownName && {
                  requestedBy: { name: requestedByUnknownName },
                }),
              },
            };
          }
        }

        // Check for unread mentions (internal chat) - all agents can be woken by @mentions
        // Uses atomic claiming via processing_since to prevent duplicate processing.
        // Only idle agents poll, so busy workers won't be interrupted.
        // Gated on the messaging capability: without it the read-messages /
        // post-message tools aren't registered, so an unread_mentions trigger
        // would instruct a missing tool and strand the claimed mentions.
        const claimedChannels = hasCapability("messaging") ? claimMentions(myAgentId) : [];
        if (claimedChannels.length > 0) {
          // Recalculate inbox summary now that we've claimed
          const inbox = getInboxSummary(myAgentId);
          return {
            trigger: {
              type: "unread_mentions",
              mentionsCount: inbox.mentionsCount,
              claimedChannels: claimedChannels.map((c) => c.channelId), // Include for tracking
            },
          };
        }

        if (agent.isLead) {
          // === LEAD-SPECIFIC TRIGGERS ===
          // NOTE: tasks_finished trigger has been replaced by follow-up task creation
          // in store-progress. When a worker completes/fails a task, a follow-up task
          // is created and assigned to the lead, which is picked up via the normal
          // task_assigned trigger above. This is more reliable and visible than the
          // old poll-based notification approach.
        } else {
          // === WORKER-SPECIFIC TRIGGERS ===

          // Auto-claim: atomically claim an unassigned task for this worker.
          // claimTask() uses an atomic UPDATE WHERE status='unassigned', so only
          // one worker wins if multiple poll simultaneously.
          // This ensures session logs are correctly associated with the real task ID
          // from the start (no reassociation needed).
          //
          // Routing affinity: `getUnassignedTaskIdsForAgent` (not the plain
          // `getUnassignedTaskIds`) pre-filters candidates through
          // `isAgentEligibleForTask`, so an ineligible task is never even
          // offered to the budget gate below or the claim loop.
          if (hasCapacity(myAgentId)) {
            // Must fetch as deep as the routing pre-pass scanned, otherwise a
            // candidate it approved below the top 5 is filtered out here and
            // never claimed — which would strand the worker even though a
            // claimable task exists. Without claim routing the original
            // shallow window is preserved exactly.
            const unassignedIds = getUnassignedTaskIdsForAgent(
              myAgentId,
              routedClaimCandidateIds === undefined ? 5 : CLAIM_ROUTING_SCAN_LIMIT,
            ).filter(
              (candidateId) =>
                routedClaimCandidateIds === undefined || routedClaimCandidateIds.has(candidateId),
            );
            // Budget admission gate (Phase 3). Pool path is workers-only —
            // per-agent budgets matter most here, but we still check global.
            // Only run the gate when there's at least one candidate task; an
            // empty pool is "no work", not "refused".
            // Phase 5: dedup row keyed on the FIRST candidate id (the one we
            // would have claimed). That id is stable for the duration of the
            // refusal, and the dedup is per-(task,date) so subsequent same-day
            // refusals on the same lead-candidate are suppressed.
            if (unassignedIds.length > 0) {
              const candidateId = unassignedIds[0]!;
              const candidateTask = getTaskById(candidateId);
              const admission = canClaim(myAgentId, new Date(), candidateTask?.requestedByUserId);
              if (!admission.allowed) {
                const utcDate = new Date().toISOString().slice(0, 10);
                const dedup = recordBudgetRefusalNotification({
                  taskId: candidateId,
                  date: utcDate,
                  agentId: myAgentId,
                  cause: admission.cause,
                  agentSpendUsd: admission.agentSpend,
                  agentBudgetUsd: admission.agentBudget,
                  globalSpendUsd: admission.globalSpend,
                  globalBudgetUsd: admission.globalBudget,
                  userSpendUsd: admission.userSpend,
                  userBudgetUsd: admission.userBudget,
                });
                return {
                  trigger: buildBudgetRefusedTrigger(admission),
                  refusalSideEffects: candidateTask
                    ? {
                        context: {
                          task: {
                            id: candidateTask.id,
                            task: candidateTask.task,
                            requestedByUserId: candidateTask.requestedByUserId,
                            slackChannelId: candidateTask.slackChannelId,
                            slackThreadTs: candidateTask.slackThreadTs,
                            slackUserId: candidateTask.slackUserId,
                          },
                          agentId: myAgentId,
                          date: utcDate,
                          cause: admission.cause,
                          agentSpendUsd: admission.agentSpend,
                          agentBudgetUsd: admission.agentBudget,
                          globalSpendUsd: admission.globalSpend,
                          globalBudgetUsd: admission.globalBudget,
                          userSpendUsd: admission.userSpend,
                          userBudgetUsd: admission.userBudget,
                          resetAt: admission.resetAt,
                        },
                        inserted: dedup.inserted,
                      }
                    : undefined,
                };
              }
            }
            for (const candidateId of unassignedIds) {
              const claimed = claimTask(candidateId, myAgentId);
              if (claimed) {
                telemetry.taskEvent("claimed", {
                  taskId: claimed.id,
                  source: claimed.source,
                  agentId: myAgentId,
                });
                return {
                  trigger: {
                    type: "task_assigned",
                    taskId: claimed.id,
                    task: { ...claimed, attachments: attachmentsForTrigger(claimed.id) },
                  },
                };
              }
              // Claim failed (another worker got it) — try next
            }
          }
        }

        // No trigger found
        return { trigger: null };
      })();
    } catch (error) {
      console.error("[/api/poll] Database error:", error);
      jsonError(
        res,
        `Database error occurred while polling for triggers: ${error instanceof Error ? error.message : String(error)}`,
        500,
      );
      return true;
    }

    // Handle error case
    if ("error" in result) {
      jsonError(res, result.error, result.status ?? 500);
      return true;
    }

    // Phase 5: after the refusal txn commits, run side effects (lead
    // follow-up + workflow event bus). Errors here are logged inside the
    // helper; we never let them affect the response the worker sees.
    if (result.refusalSideEffects) {
      emitBudgetRefusalSideEffects(
        result.refusalSideEffects.context,
        result.refusalSideEffects.inserted,
      );
    }

    // If no trigger found and agent is lead, check for Slack channel activity.
    // This is the lowest-priority trigger, checked AFTER all others.
    // Runs outside the transaction because it requires async Slack API calls.
    // Throttled to avoid Slack API rate limits (~50 calls/min).
    if (
      result.trigger === null &&
      process.env.LEAD_MONITOR_CHANNELS === "true" &&
      Date.now() - lastChannelActivityCheckAt >= CHANNEL_ACTIVITY_INTERVAL_MS
    ) {
      const agent = getAgentById(myAgentId);
      if (agent?.isLead) {
        lastChannelActivityCheckAt = Date.now();
        try {
          const cursors = getAllChannelActivityCursors();
          const cursorMap = new Map(cursors.map((c) => [c.channelId, c.lastSeenTs]));

          // Parse optional channel allowlist from env
          const allowedIds = process.env.LEAD_MONITOR_CHANNEL_IDS
            ? process.env.LEAD_MONITOR_CHANNEL_IDS.split(",")
                .map((s) => s.trim())
                .filter(Boolean)
            : undefined;

          const { messages, seedCursors } = await fetchChannelActivity(cursorMap, allowedIds);

          // Commit seed cursors immediately (cold-start initialization, no trigger)
          for (const [channelId, ts] of seedCursors) {
            upsertChannelActivityCursor(channelId, ts);
          }

          if (messages.length > 0) {
            // Compute cursor updates but DON'T commit them yet.
            // They're included in the trigger payload so the runner can commit
            // them after the lead successfully processes the messages.
            const latestPerChannel = new Map<string, string>();
            for (const msg of messages) {
              const existing = latestPerChannel.get(msg.channelId);
              if (!existing || Number.parseFloat(msg.ts) > Number.parseFloat(existing)) {
                latestPerChannel.set(msg.channelId, msg.ts);
              }
            }

            result = {
              trigger: {
                type: "channel_activity",
                count: messages.length,
                messages: messages.map((m) => ({
                  channelId: m.channelId,
                  channelName: m.channelName,
                  ts: m.ts,
                  user: m.user,
                  text: m.text.slice(0, 500),
                })),
                cursorUpdates: Array.from(latestPerChannel.entries()).map(([channelId, ts]) => ({
                  channelId,
                  ts,
                })),
              },
            };
          }
        } catch (err) {
          console.warn("[/api/poll] Channel activity check failed:", err);
          // Don't fail the poll — just skip this trigger
        }
      }
    }

    // Strip the internal-only `refusalSideEffects` field from the wire
    // response — workers receive only the public trigger envelope.
    const { refusalSideEffects: _omit, ...publicResult } = result as {
      refusalSideEffects?: unknown;
      [key: string]: unknown;
    };
    json(res, publicResult);
    return true;
  }

  return false;
}
