import { getLatestLeadTaskByContextKey } from "@/be/db";
import { requestSteering, SteeringRequestError } from "@/be/steering";
import type { AgentTask, SteerResult } from "@/types";
import { scrubSecrets } from "@/utils/secret-scrubber";
import { isSteeringEnabled } from "@/utils/steering-enabled";

export interface ChatThreadSteeringResult {
  task: AgentTask;
  result: SteerResult;
}

/**
 * Steer the lead's in-progress task on this thread with a new message. Same
 * rule as the Slack default (`SLACK_THREAD_STEERING=lead`, queue mode) as
 * constants: `isSteeringEnabled()` is the only switch. Returns null when the
 * caller should buffer the message into a follow-up task instead.
 */
export async function requestChatThreadSteering(args: {
  contextKey: string;
  message: string;
}): Promise<ChatThreadSteeringResult | null> {
  if (!isSteeringEnabled()) return null;

  const task = await getLatestLeadTaskByContextKey(args.contextKey, "chat");
  if (!task || task.status !== "in_progress") return null;

  try {
    const result = await requestSteering({
      taskId: task.id,
      message: args.message,
      mode: "queue",
      onUnsupported: "degrade",
      source: "chat",
      createdByKind: "user",
    });
    return { task, result };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const what = error instanceof SteeringRequestError ? "was refused" : "failed";
    console.warn(
      scrubSecrets(
        `[chat-sdk] Steering task ${task.id} ${what} (${detail}); creating a follow-up task`,
      ),
    );
    return null;
  }
}

/** Thread acknowledgement for the steering outcome. Constants, not prompts. */
export function formatChatSteeringAck(result: SteerResult): string {
  if (result.outcome === "promoted") return "_Your message was queued as a follow-up task._";
  if (result.degradedFrom) {
    return "_Interrupt steering is unavailable for this task, so your message was queued._";
  }
  return result.outcome === "steered"
    ? "_Your message was sent to the active task._"
    : "_Your message was queued for the active task._";
}
