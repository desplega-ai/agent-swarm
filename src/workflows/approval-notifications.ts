import {
  type ApprovalRequest,
  claimApprovalCancellationNotification,
  completeApprovalCancellationNotificationClaim,
  releaseApprovalCancellationNotificationClaim,
} from "../be/db";
import { getSlackApp } from "../slack/app";
import { scrubSecrets } from "../utils/secret-scrubber";

export interface ApprovalSlackClient {
  chat: {
    postMessage(input: {
      channel: string;
      thread_ts: string;
      text: string;
      unfurl_links: false;
      unfurl_media: false;
    }): Promise<unknown>;
  };
}

export async function postApprovalCancellationUpdates(
  approvals: ApprovalRequest[],
  reason: string,
  client: ApprovalSlackClient | undefined = getSlackApp()?.client,
): Promise<void> {
  if (!client) return;

  const text = `This approval is no longer actionable: ${reason}`;
  for (const approval of approvals) {
    const channels = approval.notificationChannels as Array<{
      channel: string;
      target: string;
      messageTs?: string;
    }> | null;
    const slackThreads = (channels ?? []).filter(
      (notification) => notification.channel === "slack" && notification.messageTs,
    );
    if (slackThreads.length === 0) continue;

    for (const notification of slackThreads) {
      if (notification.channel !== "slack" || !notification.messageTs) continue;
      const notificationKey = `${notification.target}:${notification.messageTs}`;
      const claim = await claimApprovalCancellationNotification(approval.id, notificationKey);
      if (!claim) continue;
      try {
        await client.chat.postMessage({
          channel: notification.target,
          thread_ts: notification.messageTs,
          text,
          unfurl_links: false,
          unfurl_media: false,
        });
        await completeApprovalCancellationNotificationClaim(
          approval.id,
          notificationKey,
          claim.leaseToken,
        );
      } catch (error) {
        await releaseApprovalCancellationNotificationClaim(
          approval.id,
          notificationKey,
          claim.leaseToken,
        );
        console.error(
          `[HITL] Failed to post cancellation update for approval ${approval.id}:`,
          scrubSecrets(error instanceof Error ? error.message : String(error)),
        );
      }
    }
  }
}
