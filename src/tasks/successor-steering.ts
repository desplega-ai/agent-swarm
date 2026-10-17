import { getSteeringMessagesForTask } from "../be/db";
import { resolveTemplate } from "../prompts/resolver";
import { scrubSecrets } from "../utils/secret-scrubber";
import "../tools/templates";

/**
 * Append the predecessor's unhandled steering to a successor task's text.
 *
 * A steer marked `delivered` reached the predecessor's session, but the row
 * stays unhandled until `accept-steer`. When the predecessor ends first (defer,
 * reboot-sweep failure, supersede), the successor starts a fresh session and
 * would never see the message. `accept-steer` is id-based, so the successor can
 * acknowledge these rows without re-pointing them.
 *
 * Never throws: losing the carry-forward must not block creating the successor.
 */
export async function withUnhandledSteering(
  description: string,
  predecessorTaskId: string,
): Promise<string> {
  try {
    // Still pending, or delivered with no `accept-steer`.
    const messages = (await getSteeringMessagesForTask(predecessorTaskId)).filter(
      (m) => (m.status === "pending" || m.status === "delivered") && !m.handledAt,
    );
    if (messages.length === 0) return description;
    const result = resolveTemplate("task.successor.unhandled_steering", {
      predecessor_task_id: predecessorTaskId,
      messages: messages
        .map((m) => `- [steering ${m.id}] From ${m.senderLabel ?? "Unknown sender"}:\n${m.body}`)
        .join("\n\n"),
    });
    if (result.skipped || !result.text.trim()) return description;
    return `${description}\n\n${result.text}`;
  } catch (error) {
    console.error(
      `[successor-steering] Failed to carry steering from ${predecessorTaskId}:`,
      scrubSecrets(error instanceof Error ? error.message : String(error)),
    );
    return description;
  }
}
