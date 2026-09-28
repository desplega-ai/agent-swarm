import {
  type ApprovalRequest,
  claimApprovalCancellationNotification,
  completeApprovalCancellationNotificationClaim,
  createTaskExtended,
  getTaskById,
  releaseApprovalCancellationNotificationClaim,
} from "../be/db";
import { resolveTemplate } from "../prompts/resolver";
import { getSlackApp } from "../slack/app";
import { TERMINAL_TASK_STATUSES } from "../types";
import { scrubSecrets } from "../utils/secret-scrubber";

export interface ApprovalSlackClient {
  chat: {
    postMessage(input: {
      channel: string;
      thread_ts: string;
      text: string;
      unfurl_links: false;
      unfurl_media: false;
    }): Promise<unknown>;
  };
}

export async function postApprovalCancellationUpdates(
  approvals: ApprovalRequest[],
  reason: string,
  client: ApprovalSlackClient | undefined = getSlackApp()?.client,
): Promise<void> {
  if (!client) return;

  const text = `This approval is no longer actionable: ${reason}`;
  for (const approval of approvals) {
    const channels = approval.notificationChannels as Array<{
      channel: string;
      target: string;
      messageTs?: string;
    }> | null;
    const slackThreads = (channels ?? []).filter(
      (notification) => notification.channel === "slack" && notification.messageTs,
    );
    if (slackThreads.length === 0) continue;

    for (const notification of slackThreads) {
      if (notification.channel !== "slack" || !notification.messageTs) continue;
      const notificationKey = `${notification.target}:${notification.messageTs}`;
      const claim = await claimApprovalCancellationNotification(approval.id, notificationKey);
      if (!claim) continue;
      try {
        await client.chat.postMessage({
          channel: notification.target,
          thread_ts: notification.messageTs,
          text,
          unfurl_links: false,
          unfurl_media: false,
        });
        await completeApprovalCancellationNotificationClaim(
          approval.id,
          notificationKey,
          claim.leaseToken,
        );
      } catch (error) {
        await releaseApprovalCancellationNotificationClaim(
          approval.id,
          notificationKey,
          claim.leaseToken,
        );
        console.error(
          `[HITL] Failed to post cancellation update for approval ${approval.id}:`,
          scrubSecrets(error instanceof Error ? error.message : String(error)),
        );
      }
    }
  }
}

/**
 * Create the `hitl-follow-up` task that tells the requesting agent how a
 * standalone approval request ended. Returns false when no task is created.
 */
export async function createApprovalFollowUpTask(
  request: ApprovalRequest,
  templateEventType: "hitl.follow_up" | "hitl.timeout",
): Promise<boolean> {
  if (request.workflowRunId || !request.sourceTaskId) return false;
  const sourceTask = await getTaskById(request.sourceTaskId);
  if (!sourceTask) return false;
  // Timeouts only: the first sweep after deploy would otherwise create one task per finished backlog row.
  // A human answer still gets a follow-up after the source task finishes, as before.
  if (
    templateEventType === "hitl.timeout" &&
    (TERMINAL_TASK_STATUSES as readonly string[]).includes(sourceTask.status)
  ) {
    return false;
  }

  const { text: taskText } =
    templateEventType === "hitl.follow_up"
      ? resolveTemplate("hitl.follow_up", {
          request_id: request.id,
          title: request.title,
          status: request.status,
          responses: formatResponses(
            request.questions as Array<{ id: string; type: string; label: string }>,
            (request.responses ?? {}) as Record<string, unknown>,
          ),
        })
      : resolveTemplate("hitl.timeout", {
          request_id: request.id,
          title: request.title,
          expires_at: request.expiresAt ?? "",
          reason: request.resolutionReason ?? "",
        });

  await createTaskExtended(taskText, {
    agentId: sourceTask.agentId,
    routingReason: sourceTask.agentId ? "continuity" : undefined,
    routingSource: sourceTask.agentId ? "engine_default" : undefined,
    parentTaskId: request.sourceTaskId,
    source: "system",
    taskType: "hitl-follow-up",
    tags: ["hitl", "follow-up"],
    // Explicit Slack metadata — parentTaskId auto-inherits too,
    // but being explicit ensures the follow-up task always gets
    // the right thread context even if inheritance logic changes.
    slackChannelId: sourceTask.slackChannelId ?? undefined,
    slackThreadTs: sourceTask.slackThreadTs ?? undefined,
    slackUserId: sourceTask.slackUserId ?? undefined,
  });
  return true;
}

function formatResponses(
  questions: Array<{ id: string; type: string; label: string }>,
  responses: Record<string, unknown>,
): string {
  return questions
    .map((q) => {
      const answer = responses[q.id];
      let answerText: string;
      if (answer == null) {
        answerText = "(no answer)";
      } else if (q.type === "approval") {
        const a = answer as { approved?: boolean; comment?: string };
        answerText = a.approved ? "Approved" : "Rejected";
        if (a.comment) answerText += ` — ${a.comment}`;
      } else if (typeof answer === "object") {
        answerText = JSON.stringify(answer);
      } else {
        answerText = String(answer);
      }
      return `- ${q.label}: ${answerText}`;
    })
    .join("\n");
}
