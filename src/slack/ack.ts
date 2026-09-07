import type { WebClient } from "@slack/web-api";
import { getLogsByTaskIdChronological, getSlackTasksInThread } from "../be/db";
import { type AgentTask, isTerminalTaskStatus } from "../types";
import { getSlackApp } from "./app";

type SlackReactionClient = Pick<WebClient, "reactions">;

function slackErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  const data = "data" in error ? error.data : undefined;
  if (!data || typeof data !== "object" || !("error" in data)) return undefined;
  return typeof data.error === "string" ? data.error : undefined;
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
): Promise<void> {
  try {
    await client.reactions.add({ channel, name, timestamp });
  } catch (error) {
    if (slackErrorCode(error) === "already_reacted") return;
    console.log(
      `[Slack] ${name} acknowledgement reaction failed: ${error instanceof Error ? error.message : error}`,
    );
  }
}

/** Replace this bot's acceptance reaction with the terminal task outcome. */
export async function finalizeSlackMessageReaction(
  client: SlackReactionClient,
  channel: string,
  timestamp: string,
  outcome: "white_check_mark" | "x" | "warning",
): Promise<void> {
  for (const name of ["eyes", "heavy_plus_sign", "zap", "speech_balloon"]) {
    try {
      await client.reactions.remove({ channel, name, timestamp });
    } catch (error) {
      const code = slackErrorCode(error);
      if (code === "no_reaction" || code === "message_not_found") continue;
      console.log(
        `[Slack] ${name} acknowledgement reaction removal failed: ${error instanceof Error ? error.message : error}`,
      );
    }
  }

  await ackSlackMessage(client, channel, timestamp, outcome);
}

/** Finalize acknowledgement reactions that were added to Slack steer messages. */
export async function finalizeSlackSteerReactions(
  tasks: AgentTask[],
  outcomeFor: (task: AgentTask) => "white_check_mark" | "x" | "warning",
): Promise<void> {
  const app = getSlackApp();
  if (!app) return;

  for (const task of tasks) {
    const outcome = outcomeFor(task);
    for (const log of await getLogsByTaskIdChronological(task.id)) {
      if (log.eventType !== "task_steering" || log.newValue !== "slack_reaction") continue;
      const { slackChannelId: channelId, slackMessageTs: timestamp } = JSON.parse(log.metadata!);
      void finalizeSlackMessageReaction(app.client, channelId, timestamp, outcome).catch((error) =>
        console.error(
          `[Slack] Failed to finalize steer reaction for ${channelId}/${timestamp}:`,
          error,
        ),
      );
    }
  }
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
    const outcome = linkedTasks.every((task) => task.status === "completed")
      ? "white_check_mark"
      : "x";
    void finalizeSlackMessageReaction(app.client, channelId, timestamp, outcome).catch((error) =>
      console.error(`[Slack] Failed to finalize reaction for ${channelId}/${timestamp}:`, error),
    );
  }

  await finalizeSlackSteerReactions(tasks, (task) =>
    task.status === "completed" ? "white_check_mark" : "x",
  );
}
