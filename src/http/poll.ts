import type { IncomingMessage, ServerResponse } from "node:http";
import {
  claimInboxMessages,
  claimMentions,
  claimOfferedTask,
  getAgentById,
  getDb,
  getEpicsWithProgressUpdates,
  getInboxSummary,
  getOfferedTasksForAgent,
  getPendingTaskForAgent,
  getUnassignedTasksCount,
  hasCapacity,
  markEpicsProgressNotified,
  startTask,
} from "../be/db";

export async function handlePoll(
  req: IncomingMessage,
  res: ServerResponse,
  pathSegments: string[],
  myAgentId: string | undefined,
): Promise<boolean> {
  if (req.method === "GET" && pathSegments[0] === "api" && pathSegments[1] === "poll") {
    if (!myAgentId) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Missing X-Agent-ID header" }));
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

          // Check for unread Slack inbox messages
          // Atomically claim messages to prevent duplicate processing
          const claimedInbox = claimInboxMessages(myAgentId, 5);
          if (claimedInbox.length > 0) {
            return {
              trigger: {
                type: "slack_inbox_message",
                count: claimedInbox.length,
                messages: claimedInbox,
              },
            };
          }

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

          // Check for unassigned tasks in pool (workers can claim)
          // NOTE: This trigger is intentionally unprotected from duplicate processing.
          // Multiple workers should all receive this notification so they can compete
          // to claim tasks. The actual claiming happens via task-action tool with
          // atomic SQL guards in claimTask().
          const unassignedCount = getUnassignedTasksCount();
          if (unassignedCount > 0) {
            return {
              trigger: {
                type: "pool_tasks_available",
                count: unassignedCount,
              },
            };
          }
        }

        // No trigger found
        return { trigger: null };
      })();
    } catch (error) {
      console.error("[/api/poll] Database error:", error);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          error: "Database error occurred while polling for triggers",
          details: error instanceof Error ? error.message : String(error),
        }),
      );
      return true;

    }

    // Handle error case
    if ("error" in result) {
      res.writeHead(result.status ?? 500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: result.error }));
      return true;

    }

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(result));
    return true;

  }

  return false;
}
