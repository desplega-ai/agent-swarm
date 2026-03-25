import type { IncomingMessage, ServerResponse } from "node:http";
import { ensure } from "@desplega.ai/business-use";
import { z } from "zod";
import {
  claimMentions,
  claimOfferedTask,
  claimTask,
  getAgentById,
  getAllChannelActivityCursors,
  getDb,
  getEpicsWithProgressUpdates,
  getInboxSummary,
  getOfferedTasksForAgent,
  getPendingTaskForAgent,
  getUnassignedTaskIds,
  hasCapacity,
  markEpicsProgressNotified,
  startTask,
  upsertChannelActivityCursor,
} from "../be/db";
import { fetchChannelActivity } from "../slack/channel-activity";
import { route } from "./route-def";
import { json, jsonError } from "./utils";

// ─── Route Definitions ───────────────────────────────────────────────────────

const pollTriggers = route({
  method: "get",
  path: "/api/poll",
  pattern: ["api", "poll"],
  summary: "Poll for triggers (tasks, mentions, epic updates)",
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
    let result:
      | { error: string; status: number }
      | { trigger: { type: string; [key: string]: unknown } | null };
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
            });

            return {
              trigger: {
                type: "task_assigned",
                taskId: pendingTask.id,
                task: { ...pendingTask, status: "in_progress" },
              },
            };
          }
        }

        // Check for unread mentions (internal chat) - all agents can be woken by @mentions
        // Uses atomic claiming via processing_since to prevent duplicate processing.
        // Only idle agents poll, so busy workers won't be interrupted.
        const claimedChannels = claimMentions(myAgentId);
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

          // Check for epic progress updates (tasks completed/failed for active epics)
          // This trigger helps lead plan next steps for epics - similar to ralph loop
          const epicsWithUpdates = getEpicsWithProgressUpdates();
          if (epicsWithUpdates.length > 0) {
            // Atomically mark as notified within this transaction
            const epicIds = epicsWithUpdates.map((e) => e.epic.id);
            markEpicsProgressNotified(epicIds);

            return {
              trigger: {
                type: "epic_progress_changed",
                count: epicsWithUpdates.length,
                epics: epicsWithUpdates,
              },
            };
          }
        } else {
          // === WORKER-SPECIFIC TRIGGERS ===

          // Auto-claim: atomically claim an unassigned task for this worker.
          // claimTask() uses an atomic UPDATE WHERE status='unassigned', so only
          // one worker wins if multiple poll simultaneously.
          // This ensures session logs are correctly associated with the real task ID
          // from the start (no reassociation needed).
          if (hasCapacity(myAgentId)) {
            const unassignedIds = getUnassignedTaskIds(5);
            for (const candidateId of unassignedIds) {
              const claimed = claimTask(candidateId, myAgentId);
              if (claimed) {
                return {
                  trigger: {
                    type: "task_assigned",
                    taskId: claimed.id,
                    task: claimed,
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

    json(res, result);
    return true;
  }

  return false;
}
