import { getTaskById, markTaskAgentmailReplySent } from "../be/db";
import { getTaskUrl } from "../slack/blocks";
import { scrubSecrets } from "../utils/secret-scrubber";
import { workflowEventBus } from "../workflows/event-bus";
import { agentmailReplyToMessage } from "./client";

let subscribed = false;

const OUTPUT_TRUNCATE_CHARS = 4000;

/**
 * Subscribe AgentMail outbound reply delivery to swarm task lifecycle events.
 *
 * This is the email equivalent of the Slack outcome card: engine-owned, not
 * agent discretion. On `task.completed` / `task.failed`, if the task
 * originated from an inbound AgentMail message (`source === "agentmail"`
 * with an `agentmailInboxId` + `agentmailMessageId` to reply to), sends a
 * threaded reply on the original message carrying the result, then flips
 * `agentmailReplySent` so a retry or a `force` re-completion cannot double-send.
 *
 * `task.completed`/`task.failed` only fire once per task (idempotency guard
 * in `completeTask`/`failTask`), and `task.deferred` is not a terminal
 * transition — a deferring task is never seen here, matching the outcome-card
 * convention that a deferral is not a terminal outcome.
 *
 * A completion with empty/blank `output` is intentionally NOT sent — there is
 * nothing to relay, and an email with no body is worse than no email. A
 * failure always sends: `failureReason` falls back to a fixed string when
 * absent, mirroring the Jira outbound sync's failure handling.
 *
 * Idempotent — calling twice is a no-op.
 */
function observed(
  eventName: string,
  handler: (data: unknown) => Promise<void>,
): (data: unknown) => void {
  return (data: unknown): void => {
    handler(data).catch((error) => {
      console.error(
        `[AgentMail Outbound] ${eventName} handler failed:`,
        scrubSecrets(error instanceof Error ? error.message : String(error)),
      );
    });
  };
}

const onTaskCompleted = observed("task.completed", handleTaskCompleted);
const onTaskFailed = observed("task.failed", handleTaskFailed);

export function initAgentMailOutboundSync(): void {
  if (subscribed) return;
  subscribed = true;

  workflowEventBus.on("task.completed", onTaskCompleted);
  workflowEventBus.on("task.failed", onTaskFailed);
  console.log("[AgentMail] Outbound reply sync subscribed to event bus");
}

export function teardownAgentMailOutboundSync(): void {
  if (!subscribed) return;
  subscribed = false;

  workflowEventBus.off("task.completed", onTaskCompleted);
  workflowEventBus.off("task.failed", onTaskFailed);
  console.log("[AgentMail] Outbound reply sync unsubscribed from event bus");
}

async function handleTaskCompleted(data: unknown): Promise<void> {
  const { taskId, output } = data as { taskId?: string; output?: string };
  if (!taskId) return;

  const trimmed = (output ?? "").trim();
  if (!trimmed) {
    // Nothing to relay — do not send a blank email.
    return;
  }

  const truncated = trimmed.slice(0, OUTPUT_TRUNCATE_CHARS);
  const ellipsized = trimmed.length > OUTPUT_TRUNCATE_CHARS ? `${truncated}…` : truncated;

  await sendReply(taskId, ellipsized);
}

async function handleTaskFailed(data: unknown): Promise<void> {
  const { taskId, failureReason } = data as { taskId?: string; failureReason?: string };
  if (!taskId) return;

  const reason = failureReason?.trim() || "(no failure reason recorded)";
  await sendReply(taskId, `Task failed.\n\n${reason}`);
}

async function sendReply(taskId: string, bodyText: string): Promise<void> {
  const task = await getTaskById(taskId);
  if (!task) return;
  if (task.source !== "agentmail") return;
  if (task.agentmailReplySent) return;
  if (!task.agentmailInboxId || !task.agentmailMessageId) return;

  const text = `${bodyText}\n\n—\nView task: ${getTaskUrl(taskId)}`;

  try {
    const response = await agentmailReplyToMessage(task.agentmailInboxId, task.agentmailMessageId, {
      text,
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "<unreadable body>");
      console.error(
        `[AgentMail Outbound] Failed to send reply for task ${taskId} → message ${task.agentmailMessageId}: HTTP ${response.status} ${scrubSecrets(body)}`,
      );
      return;
    }

    const marked = await markTaskAgentmailReplySent(taskId);
    if (!marked) {
      // Lost the race to a concurrent send — the other caller already flipped
      // the flag. Nothing further to do; log for observability only.
      console.log(
        `[AgentMail Outbound] Reply sent for task ${taskId} but flag was already set (concurrent send)`,
      );
      return;
    }
    console.log(
      `[AgentMail Outbound] Sent reply for task ${taskId} → message ${task.agentmailMessageId}`,
    );
  } catch (error) {
    console.error(
      `[AgentMail Outbound] Error sending reply for task ${taskId}:`,
      scrubSecrets(error instanceof Error ? error.message : String(error)),
    );
  }
}
