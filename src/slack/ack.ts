import type { WebClient } from "@slack/web-api";

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
  outcome: "white_check_mark" | "x",
): Promise<void> {
  for (const name of ["eyes", "heavy_plus_sign", "zap"]) {
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
