import { WebClient } from "@slack/web-api";
import { scrubSecrets } from "../../utils/secret-scrubber";

export type SlackSurfaceVerification = {
  status: "pending" | "verified" | "failed";
  errorMessage?: string;
};

export type SlackSurfaceVerifier = (input: {
  workspaceId: string;
  channelId: string;
}) => Promise<SlackSurfaceVerification>;

let verifierOverride: SlackSurfaceVerifier | null = null;

export function setSlackSurfaceVerifierForTests(verifier: SlackSurfaceVerifier | null): void {
  verifierOverride = verifier;
}

const liveVerifier: SlackSurfaceVerifier = async ({ workspaceId, channelId }) => {
  const token = process.env.SLACK_BOT_TOKEN;
  if (!token) {
    return { status: "pending", errorMessage: "Slack bot credentials are not configured" };
  }
  try {
    const client = new WebClient(token);
    const auth = await client.auth.test();
    if (auth.team_id !== workspaceId) {
      return { status: "failed", errorMessage: "Slack workspace does not match the bot token" };
    }
    const response = await client.conversations.info({ channel: channelId });
    const channel = response.channel as { id?: string; is_member?: boolean } | undefined;
    if (!channel || channel.id !== channelId) {
      return { status: "failed", errorMessage: "Slack channel was not found" };
    }
    if (channel.is_member !== true) {
      return { status: "failed", errorMessage: "Aria must be invited to the Slack channel" };
    }
    return { status: "verified" };
  } catch (error) {
    return {
      status: "failed",
      errorMessage: scrubSecrets(error instanceof Error ? error.message : String(error)),
    };
  }
};

export function verifySlackSurface(input: {
  workspaceId: string;
  channelId: string;
}): Promise<SlackSurfaceVerification> {
  return (verifierOverride ?? liveVerifier)(input);
}
