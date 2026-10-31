import { deleteKv, getKv, upsertKv } from "../be/db";
import { isEnvFlagEnabled } from "../utils/env-flag";

/**
 * Slack threads the swarm left, via the `slack-leave-thread` tool or a
 * human's `!leave` in the thread.
 *
 * A left thread drops every inbound message that does not @mention the bot,
 * in code, before buffering, routing, or any AI call. A mention clears the
 * state and the message is handled as usual. Stored in kv_entries so a
 * restart keeps it.
 */
export const SLACK_LEFT_THREAD_KV_NAMESPACE = "slack-left-thread";

/** Operator flag that turns leaving threads off: the tool and `!leave`. */
export const SLACK_LEAVE_THREAD_DISABLE = "SLACK_LEAVE_THREAD_DISABLE";

/**
 * Read at call time, not cached: a global swarm_config row is hydrated into
 * process.env on every config reload, so a flip applies without a restart.
 */
export function isSlackLeaveThreadDisabled(): boolean {
  return isEnvFlagEnabled(SLACK_LEAVE_THREAD_DISABLE, false);
}

/** Ephemeral reply to the human who sent `!leave`. */
export const SLACK_LEFT_THREAD_CONFIRMATION =
  "Left this thread. @mention the swarm to bring it back.";

/**
 * True when a thread message is the `!leave` command: exactly `!leave`,
 * optionally after @mentions of the bot. A message that mentions anyone else
 * is not addressed to the swarm and does not match.
 */
export function isSlackLeaveThreadCommand(
  text: string | undefined,
  botUserId: string | null,
): boolean {
  const withoutBotMentions = botUserId
    ? (text ?? "").replaceAll(`<@${botUserId}>`, "")
    : (text ?? "");
  return withoutBotMentions.trim() === "!leave";
}

function threadKey(channelId: string, threadTs: string): string {
  return `${channelId}:${threadTs}`;
}

/** Who left the thread: an agent via the tool, or a Slack user via `!leave`. */
export type SlackThreadLeftBy = { agentId: string } | { slackUserId: string };

export async function leaveSlackThread(
  channelId: string,
  threadTs: string,
  leftBy: SlackThreadLeftBy,
): Promise<void> {
  await upsertKv({
    namespace: SLACK_LEFT_THREAD_KV_NAMESPACE,
    key: threadKey(channelId, threadTs),
    value: { ...leftBy, leftAt: new Date().toISOString() },
    valueType: "json",
  });
}

export async function isSlackThreadLeft(channelId: string, threadTs: string): Promise<boolean> {
  return (await getKv(SLACK_LEFT_THREAD_KV_NAMESPACE, threadKey(channelId, threadTs))) !== null;
}

/**
 * Inbound gate for left threads. Returns true when the message must be dropped:
 * the thread is left and the message does not @mention the bot. A mention
 * clears the left state and returns false.
 */
export async function shouldSkipLeftSlackThread(
  channelId: string,
  threadTs: string | undefined,
  botMentioned: boolean,
): Promise<boolean> {
  if (!threadTs) return false;
  const key = threadKey(channelId, threadTs);
  if (botMentioned) {
    if (await deleteKv(SLACK_LEFT_THREAD_KV_NAMESPACE, key)) {
      console.log(`[Slack] Rejoined left thread ${key}: bot mentioned`);
    }
    return false;
  }
  return isSlackThreadLeft(channelId, threadTs);
}
