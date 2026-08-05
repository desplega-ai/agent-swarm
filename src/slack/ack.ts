import type { WebClient } from "@slack/web-api";
import {
  failSlackReactionGroup,
  getPendingSlackTaskReactionGroups,
  markSlackTaskReactionFinalized,
  openSlackReactionGroup,
  recordSlackSteeringReaction,
  recordSlackTaskReaction,
  type SlackAcceptanceReaction,
  sealSlackReactionGroup,
} from "../be/db";
import type { AgentTaskStatus } from "../types";
import { scrubSecrets } from "../utils/secret-scrubber";

type SlackReactionClient = Pick<WebClient, "reactions">;
type SlackTerminalReaction = "white_check_mark" | "x";

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
  name: SlackAcceptanceReaction,
): Promise<void> {
  try {
    await client.reactions.add({ channel, name, timestamp });
  } catch (error) {
    if (slackErrorCode(error) === "already_reacted") return;
    console.log(
      `[Slack] ${name} acknowledgement reaction failed: ${scrubSecrets(error instanceof Error ? error.message : String(error))}`,
    );
  }
}

export async function ackSlackTaskMessage(
  client: SlackReactionClient,
  input: {
    channel: string;
    timestamp: string;
    name: SlackAcceptanceReaction;
    taskId: string;
  },
): Promise<void> {
  if (!linkSlackTaskMessage(input) || !sealSlackTaskMessage(input.channel, input.timestamp)) return;
  await ackSlackMessage(client, input.channel, input.timestamp, input.name);
}

export function openSlackTaskMessage(input: {
  channel: string;
  timestamp: string;
  name: SlackAcceptanceReaction;
}): boolean {
  try {
    openSlackReactionGroup({
      channelId: input.channel,
      messageTs: input.timestamp,
      acceptanceReaction: input.name,
    });
    return true;
  } catch (error) {
    console.log(
      `[Slack] ${input.name} reaction lifecycle open failed: ${scrubSecrets(error instanceof Error ? error.message : String(error))}`,
    );
    return false;
  }
}

export function linkSlackTaskMessage(input: {
  channel: string;
  timestamp: string;
  name: SlackAcceptanceReaction;
  taskId: string;
}): boolean {
  try {
    recordSlackTaskReaction({
      channelId: input.channel,
      messageTs: input.timestamp,
      taskId: input.taskId,
      acceptanceReaction: input.name,
    });
    return true;
  } catch (error) {
    console.log(
      `[Slack] ${input.name} reaction correlation failed: ${scrubSecrets(error instanceof Error ? error.message : String(error))}`,
    );
    return false;
  }
}

export function linkSlackSteeringMessage(input: {
  channel: string;
  timestamp: string;
  name: SlackAcceptanceReaction;
  steeringMessageId: string;
}): boolean {
  try {
    recordSlackSteeringReaction({
      channelId: input.channel,
      messageTs: input.timestamp,
      steeringMessageId: input.steeringMessageId,
      acceptanceReaction: input.name,
    });
    return true;
  } catch (error) {
    console.log(
      `[Slack] ${input.name} steering reaction correlation failed: ${scrubSecrets(error instanceof Error ? error.message : String(error))}`,
    );
    return false;
  }
}

export function sealSlackTaskMessage(channel: string, timestamp: string): boolean {
  try {
    return sealSlackReactionGroup(channel, timestamp);
  } catch (error) {
    console.log(
      `[Slack] reaction lifecycle seal failed: ${scrubSecrets(error instanceof Error ? error.message : String(error))}`,
    );
    return false;
  }
}

export function failSlackTaskMessage(channel: string, timestamp: string): boolean {
  try {
    return failSlackReactionGroup(channel, timestamp);
  } catch (error) {
    console.log(
      `[Slack] reaction lifecycle failure seal failed: ${scrubSecrets(error instanceof Error ? error.message : String(error))}`,
    );
    return false;
  }
}

export function terminalSlackReaction(statuses: AgentTaskStatus[]): SlackTerminalReaction | null {
  if (
    statuses.length === 0 ||
    statuses.some(
      (status) =>
        status !== "completed" &&
        status !== "failed" &&
        status !== "cancelled" &&
        status !== "superseded",
    )
  ) {
    return null;
  }
  return statuses.every((status) => status === "completed") ? "white_check_mark" : "x";
}

type ReactionMutationResult = "ok" | "message_not_found" | "retry";

async function mutateReaction(
  operation: "add" | "remove",
  client: SlackReactionClient,
  channel: string,
  timestamp: string,
  name: string,
): Promise<ReactionMutationResult> {
  try {
    await client.reactions[operation]({ channel, name, timestamp });
    return "ok";
  } catch (error) {
    const code = slackErrorCode(error);
    if (code === "message_not_found") return "message_not_found";
    if (operation === "remove" && code === "no_reaction") return "ok";
    if (operation === "add" && code === "already_reacted") return "ok";
    console.log(
      `[Slack] ${name} terminal reaction ${operation} failed: ${scrubSecrets(error instanceof Error ? error.message : String(error))}`,
    );
    return "retry";
  }
}

/**
 * Replace accepted-message reactions once every task linked to that exact
 * human message has reached a completed/failed outcome.
 *
 * Slack mutations are best effort. Benign idempotency errors finalize the
 * local record, while transient failures remain pending for the next watcher
 * pass and never affect task or outcome-card processing.
 */
export async function processSlackTerminalReactions(client: SlackReactionClient): Promise<void> {
  for (const group of getPendingSlackTaskReactionGroups()) {
    const terminal = terminalSlackReaction(group.tasks.map((task) => task.status));
    if (!terminal) continue;

    let shouldRetry = false;
    let messageMissing = false;
    for (const acceptance of group.acceptanceReactions) {
      const result = await mutateReaction(
        "remove",
        client,
        group.channelId,
        group.messageTs,
        acceptance,
      );
      if (result === "message_not_found") {
        messageMissing = true;
        break;
      }
      shouldRetry ||= result === "retry";
    }
    if (messageMissing) {
      markSlackTaskReactionFinalized(group.channelId, group.messageTs);
      continue;
    }
    if (shouldRetry) continue;

    const added = await mutateReaction("add", client, group.channelId, group.messageTs, terminal);
    if (added === "ok" || added === "message_not_found") {
      markSlackTaskReactionFinalized(group.channelId, group.messageTs);
    }
  }
}
