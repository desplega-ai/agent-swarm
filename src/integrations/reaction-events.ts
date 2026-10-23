import type { AgentTaskStatus } from "@/types";

/**
 * The task lifecycle a chat channel shows as a reaction on the user's message.
 * Each channel maps these events to its own emoji: Slack in
 * `src/slack/reaction-shortcode.ts`, Chat SDK adapters in
 * `src/integrations/chat-sdk/reactions.ts`.
 *
 * - `accepted`: the swarm took the message.
 * - `buffered`: the message joined a batch that is still waiting.
 * - `now`: the message skipped the buffer (`!now`).
 * - `steered`: the message went to a running task, or was queued for it.
 * - `completed` / `failed`: the task that answers the message ended.
 */
export type ReactionEvent = "accepted" | "buffered" | "now" | "steered" | "completed" | "failed";

/** The terminal event for an ended task: anything but `completed` shows as `failed`. */
export function terminalReactionEvent(status: AgentTaskStatus): "completed" | "failed" {
  return status === "completed" ? "completed" : "failed";
}
