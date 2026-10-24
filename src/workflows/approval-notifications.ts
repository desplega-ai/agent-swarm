import { formatConfigResult } from "../be/approval-config-question";
import {
  type ApprovalRequest,
  approvalCancellationNotificationKey,
  claimApprovalCancellationNotification,
  completeApprovalCancellationNotificationClaim,
  createTaskExtended,
  getApprovalRequestById,
  getTaskById,
  releaseApprovalCancellationNotificationClaim,
  updateApprovalRequestNotifications,
} from "../be/db";
import { resolveTemplate } from "../prompts/resolver";
import { getSlackApp } from "../slack/app";
import { resolveSlackConversationId } from "../slack/dm";
import {
  externalChannelToolError,
  getChannelBlockReason,
  isBlockExternalEnabled,
} from "../slack/external-channel";
import { TERMINAL_TASK_STATUSES } from "../types";
import { getAppUrl } from "../utils/constants";
import { scrubSecrets } from "../utils/secret-scrubber";

/** Slack Block Kit caps a section block's text at 3000 characters. */
const SLACK_SECTION_TEXT_LIMIT = 3000;

function escapeSlackMrkdwn(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

/**
 * Render the Slack "Questions" section text within Block Kit's 3000-character
 * section limit. Labels are escaped so upstream text cannot inject mentions or
 * links. When the list does not fit, the tail is replaced by a count; every
 * question stays answerable on the dashboard page the card's button opens.
 */
export function buildSlackQuestionsSummary(
  questions: ReadonlyArray<{ label?: string; type?: string }>,
  timeoutText = "",
): string {
  const header = "*Questions:*\n";
  // A config question is only ever answered on the dashboard, never in Slack.
  const lines = questions.map(
    (q) =>
      `• ${escapeSlackMrkdwn((q.label ?? "").replace(/\s+/g, " ").trim())}${q.type === "config" ? " (set on dashboard)" : ""}`,
  );
  const fits = (shown: string[], omitted: number) => {
    const tail =
      omitted > 0 ? `\n_…and ${omitted} more. Answer all of them on the dashboard._` : "";
    const text = `${header}${shown.join("\n")}${tail}${timeoutText}`;
    return text.length <= SLACK_SECTION_TEXT_LIMIT ? text : null;
  };

  const full = fits(lines, 0);
  if (full) return full;
  for (let count = lines.length - 1; count >= 0; count--) {
    const text = fits(lines.slice(0, count), lines.length - count);
    if (text) return text;
  }
  return `${header}_${questions.length} questions. Answer them on the dashboard._`;
}

function formatTimeout(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  const hours = Math.floor(seconds / 3600);
  const mins = Math.round((seconds % 3600) / 60);
  return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
}

export interface ApprovalNotificationChannel {
  channel: "slack" | "email";
  target: string;
}

export interface ApprovalNotificationsInput {
  requestId: string;
  title: string;
  questions: ReadonlyArray<{ label?: string; type?: string }>;
  timeoutSeconds?: number;
  notifications: ReadonlyArray<ApprovalNotificationChannel>;
}

/** The DB calls the dispatch makes; the HITL executor injects its own. */
export interface ApprovalNotificationsDb {
  updateApprovalRequestNotifications: typeof updateApprovalRequestNotifications;
  getApprovalRequestById: typeof getApprovalRequestById;
}

/**
 * Post the "Approval Required" card for each notification channel and store
 * the Slack `messageTs` on the request. Used by the workflow HITL executor and
 * by `POST /api/approval-requests`, which checks the caller may post to Slack.
 * Callers fire and forget: a Slack failure is logged and never fails the
 * request. Email is not supported yet and is skipped.
 */
export async function dispatchApprovalNotifications(
  input: ApprovalNotificationsInput,
  db: ApprovalNotificationsDb = { updateApprovalRequestNotifications, getApprovalRequestById },
): Promise<void> {
  const { requestId, title, questions, timeoutSeconds, notifications } = input;
  if (!notifications.length) return;

  const approvalUrl = `${getAppUrl()}/approval-requests/${requestId}`;
  const updatedChannels: Array<ApprovalNotificationChannel & { messageTs?: string }> = [
    ...notifications,
  ];
  let updated = false;

  for (let i = 0; i < notifications.length; i++) {
    const notification = notifications[i]!;

    if (notification.channel === "email") {
      console.warn(`[HITL] Email notifications not yet supported (target: ${notification.target})`);
      continue;
    }

    if (notification.channel === "slack") {
      try {
        const slackApp = getSlackApp();
        if (!slackApp) {
          console.warn("[HITL] Slack not initialized — cannot send notification");
          continue;
        }

        // Same guard as the Slack tools: never post into a channel shared with another org.
        if (isBlockExternalEnabled()) {
          const conversationId = await resolveSlackConversationId(
            slackApp.client,
            notification.target,
          );
          const blockReason = await getChannelBlockReason(slackApp.client, conversationId);
          if (blockReason) {
            console.warn(`[HITL] ${externalChannelToolError(conversationId, blockReason)}`);
            continue;
          }
        }

        const questionsText = buildSlackQuestionsSummary(questions);

        // The deadline is a caption under the button, not part of the ask.
        const timeoutCaption =
          timeoutSeconds !== undefined
            ? [
                {
                  type: "context",
                  elements: [
                    {
                      type: "mrkdwn",
                      text: `⏱ Timeout: ${formatTimeout(timeoutSeconds)} — times out if not responded`,
                    },
                  ],
                },
              ]
            : [];

        const blocks = [
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: `🔔 *Approval Required: ${escapeSlackMrkdwn(title)}*`,
            },
          },
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: questionsText,
            },
          },
          {
            type: "actions",
            elements: [
              {
                type: "button",
                text: { type: "plain_text", text: "Review & Respond" },
                url: approvalUrl,
                style: "primary",
              },
            ],
          },
          ...timeoutCaption,
        ];

        const result = await slackApp.client.chat.postMessage({
          channel: notification.target,
          text: `Approval Required: ${escapeSlackMrkdwn(title)} — ${approvalUrl}`,
          unfurl_links: false,
          unfurl_media: false,
          // biome-ignore lint/suspicious/noExplicitAny: Block Kit objects
          blocks: blocks as any,
        });

        if (result.ts) {
          updatedChannels[i] = { ...notification, messageTs: result.ts };
          updated = true;
        }

        console.log(
          `[HITL] Slack notification sent to ${notification.target} for request ${requestId}`,
        );
      } catch (err) {
        console.error(
          `[HITL] Failed to send Slack notification to ${notification.target}:`,
          scrubSecrets(err instanceof Error ? err.message : String(err)),
        );
      }
    }
  }

  // Persist messageTs values back to DB
  if (updated) {
    try {
      await db.updateApprovalRequestNotifications(requestId, updatedChannels);
      // A cancel that landed while the card was posting found no messageTs to thread under.
      const latest = await db.getApprovalRequestById(requestId);
      if (latest?.status === "cancelled") {
        await postApprovalCancellationUpdates(
          [latest],
          latest.resolutionReason ?? "Workflow run cancelled",
        );
      }
    } catch (err) {
      console.error(
        "[HITL] Failed to update notification channels in DB:",
        scrubSecrets(err instanceof Error ? err.message : String(err)),
      );
    }
  }
}

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
      const notificationKey = approvalCancellationNotificationKey(
        notification.target,
        notification.messageTs,
      );
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
      } else if (q.type === "config") {
        answerText = formatConfigResult(answer) ?? "(unreadable config result)";
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
