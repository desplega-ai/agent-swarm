import { finalizeTerminalSlackReactions } from "../slack/ack";
import type { AgentTask } from "../types";
import { scrubSecrets } from "../utils/secret-scrubber";

/**
 * The one-line reason a `skipped` finish carries. Accept it from output too,
 * since that is where a finishing call usually puts its text; the caller keeps
 * output empty so nothing that publishes a task result has text to post.
 * Undefined when neither field has text.
 */
export function skipReasonFrom(failureReason?: string, output?: string): string | undefined {
  return (failureReason ?? output)?.replace(/\s+/g, " ").trim() || undefined;
}

/**
 * A skip posts nothing to the thread: no outcome card, no relay, no lead
 * follow-up. It only swaps the trigger message's ack reaction for the skip
 * reaction. Call it once, after a fresh skip committed.
 */
export function finalizeSkippedTaskReaction(task: AgentTask, caller: string): void {
  if (!task.slackChannelId) return;
  void finalizeTerminalSlackReactions([task]).catch((error) =>
    console.error(
      `[${caller}] skip reaction failed:`,
      scrubSecrets(error instanceof Error ? error.message : String(error)),
    ),
  );
}
