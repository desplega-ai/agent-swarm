import type { WebClient } from "@slack/web-api";
import { getLogsByTaskIdChronological, getSlackTasksInThread } from "../be/db";
import { recordSlackReactionInvalidName } from "../otel";
import { type AgentTask, isTerminalTaskStatus } from "../types";
import { scrubSecrets } from "../utils/secret-scrubber";
import { getSlackApp } from "./app";
import {
  reactionName,
  SLACK_REACTION_CONFIG_KEYS,
  SLACK_REACTION_DEFAULTS,
  type SlackReactionEvent,
} from "./reaction-shortcode";

export { reactionName, type SlackReactionEvent } from "./reaction-shortcode";

type SlackReactionClient = Pick<WebClient, "reactions">;

/**
 * The acceptance-stage events whose configured reaction is removed when a
 * task reaches a terminal state. This is the configurable form of the fixed
 * `["eyes", "heavy_plus_sign", "zap", "speech_balloon"]` list: the same four
 * events, resolved through the same `SLACK_REACTION_*` keys that applied them.
 */
const ACCEPTANCE_EVENTS: readonly SlackReactionEvent[] = ["accepted", "buffered", "now", "steered"];

function slackErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  const data = "data" in error ? error.data : undefined;
  if (!data || typeof data !== "object" || !("error" in data)) return undefined;
  return typeof data.error === "string" ? data.error : undefined;
}

/**
 * Add one reaction, with the shared `invalid_name` fallback and error
 * handling. When Slack rejects the configured name, log once, count it, and
 * retry once with the built-in default for that event.
 */
async function addReaction(
  client: SlackReactionClient,
  channel: string,
  timestamp: string,
  name: string,
  event: SlackReactionEvent | undefined,
): Promise<void> {
  try {
    await client.reactions.add({ channel, name, timestamp });
  } catch (error) {
    if (slackErrorCode(error) === "already_reacted") return;
    if (slackErrorCode(error) === "invalid_name") {
      const keyLabel = event ? SLACK_REACTION_CONFIG_KEYS[event] : "the SLACK_REACTION_* key";
      console.error(
        scrubSecrets(
          `[Slack] reaction "${name}" for event ${event ?? "unknown"} rejected by Slack (invalid_name); check ${keyLabel}`,
        ),
      );
      recordSlackReactionInvalidName(event ?? "unknown");
      // Always attempt the one default fallback, even when the rejected name
      // already equals it (Slack's rejection isn't assumed to be permanent)
      // and even when `event` is unknown (fall back to a universally-valid
      // built-in reaction rather than leaving the message with none at all).
      const fallback = event ? SLACK_REACTION_DEFAULTS[event] : SLACK_REACTION_DEFAULTS.completed;
      try {
        await client.reactions.add({ channel, name: fallback, timestamp });
      } catch (fallbackError) {
        console.log(
          scrubSecrets(
            `[Slack] ${fallback} acknowledgement reaction failed: ${fallbackError instanceof Error ? fallbackError.message : fallbackError}`,
          ),
        );
      }
      return;
    }
    console.log(
      scrubSecrets(
        `[Slack] ${name} acknowledgement reaction failed: ${error instanceof Error ? error.message : error}`,
      ),
    );
  }
}

/**
 * Acknowledge that the swarm accepted a Slack message.
 *
 * Reactions are best-effort feedback only: Slack API failures must never block
 * message ingestion or task creation. Slack reports repeated acknowledgements
 * as `already_reacted`, which is an expected no-op.
 */
export async function ackSlackMessage(
  client: SlackReactionClient,
  channel: string,
  timestamp: string,
  name: string,
  event?: SlackReactionEvent,
): Promise<void> {
  await addReaction(client, channel, timestamp, name, event);
}

/**
 * Replace this bot's acceptance reaction with the terminal task outcome.
 *
 * Removal is stateless: every currently configured acceptance-stage name is
 * removed, then the terminal reaction is added. `reactions.remove` only ever
 * removes the calling bot user's own reaction, so a human's or another bot's
 * same-named reaction is untouched, and `no_reaction` is the expected answer
 * for a name this bot never applied to the message. No process state is
 * consulted, so an API restart between acceptance and finalization does not
 * change the outcome.
 */
export async function finalizeSlackMessageReaction(
  client: SlackReactionClient,
  channel: string,
  timestamp: string,
  outcome: string,
  event?: SlackReactionEvent,
): Promise<void> {
  const names = new Set(ACCEPTANCE_EVENTS.map((acceptanceEvent) => reactionName(acceptanceEvent)));
  for (const name of names) {
    try {
      await client.reactions.remove({ channel, name, timestamp });
    } catch (error) {
      const code = slackErrorCode(error);
      if (code === "no_reaction" || code === "message_not_found" || code === "invalid_name")
        continue;
      console.log(
        scrubSecrets(
          `[Slack] ${name} acknowledgement reaction removal failed: ${error instanceof Error ? error.message : error}`,
        ),
      );
    }
  }

  await addReaction(client, channel, timestamp, outcome, event);
}

export async function finalizeTerminalSlackReactions(tasks: AgentTask[]): Promise<void> {
  const app = getSlackApp();
  if (!app) return;

  const triggers = new Map<string, { channelId: string; threadTs: string; timestamp: string }>();
  for (const task of tasks) {
    if (!task.slackChannelId || !task.slackThreadTs || !task.slackTriggerMessageTs) continue;
    const key = `${task.slackChannelId}\0${task.slackTriggerMessageTs}`;
    triggers.set(key, {
      channelId: task.slackChannelId,
      threadTs: task.slackThreadTs,
      timestamp: task.slackTriggerMessageTs,
    });
  }

  for (const { channelId, threadTs, timestamp } of triggers.values()) {
    const linkedTasks = (await getSlackTasksInThread(channelId, threadTs)).filter(
      (task) => task.slackTriggerMessageTs === timestamp,
    );
    if (
      linkedTasks.length === 0 ||
      linkedTasks.some((task) => !isTerminalTaskStatus(task.status))
    ) {
      continue;
    }
    const event: SlackReactionEvent = linkedTasks.every((task) => task.status === "completed")
      ? "completed"
      : "failed";
    void finalizeSlackMessageReaction(
      app.client,
      channelId,
      timestamp,
      reactionName(event),
      event,
    ).catch((error) =>
      console.error(`[Slack] Failed to finalize reaction for ${channelId}/${timestamp}:`, error),
    );
  }

  for (const task of tasks) {
    const event: SlackReactionEvent = task.status === "completed" ? "completed" : "failed";
    for (const log of await getLogsByTaskIdChronological(task.id)) {
      if (log.eventType !== "task_steering" || log.newValue !== "slack_reaction") continue;
      const { slackChannelId: channelId, slackMessageTs: timestamp } = JSON.parse(log.metadata!);
      void finalizeSlackMessageReaction(
        app.client,
        channelId,
        timestamp,
        reactionName(event),
        event,
      ).catch((error) =>
        console.error(
          `[Slack] Failed to finalize steer reaction for ${channelId}/${timestamp}:`,
          error,
        ),
      );
    }
  }
}
