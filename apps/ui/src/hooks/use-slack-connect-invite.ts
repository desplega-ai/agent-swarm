/**
 * Request or dismiss the Slack Connect invite. Shared by the bell card, the
 * fleet benchmark perk, Settings > Branding and the org-name popup, so all of
 * them resolve the same per-user inbox row and send the same request.
 */
import { toast } from "sonner";
import { useInboxState, useUpdateInboxItem } from "@/api/hooks/use-inbox-state";
import { type NotifyUsExtra, useNotificationEvents } from "@/api/hooks/use-notification-events";
import type { SlackConnectMoment } from "@/api/types";
import { useCurrentUser } from "@/contexts/current-user-context";
import { domainOf } from "@/lib/company-profile";

export const SLACK_CONNECT_INVITE_KEY = "slack_connect_invite";

/** Optional answers sent with the request. Reuse `submission_id` to update an earlier request. */
export type SlackConnectInviteDetails = NotifyUsExtra;

function useResolveInvite(key: string) {
  const currentUser = useCurrentUser();
  const updateInboxItem = useUpdateInboxItem();
  return (status: "dismissed" | "done") => {
    if (!currentUser.userId) return;
    updateInboxItem.mutate({
      userId: currentUser.userId,
      itemType: "notification",
      itemId: key,
      status,
    });
  };
}

/**
 * Returns `requestSlackConnectInvite(email, details?)`. It sends the raw email
 * to Desplega (the feedback endpoint) and, once that lands, marks the bell
 * invite done, so the bell does not ask again. It rejects on a blank email or
 * a failed send. It sends no telemetry and shows no toast: the caller owns both.
 */
export function useRequestSlackConnectInvite() {
  const { notifyUs } = useNotificationEvents();
  const resolve = useResolveInvite(SLACK_CONNECT_INVITE_KEY);

  return async function requestSlackConnectInvite(
    email: string,
    details: SlackConnectInviteDetails = {},
  ): Promise<void> {
    const value = email.trim();
    if (!value) throw new Error("Enter your work email.");
    await notifyUs(
      SLACK_CONNECT_INVITE_KEY,
      "requested a Slack Connect channel invite",
      value,
      details,
    );
    resolve("done");
  };
}

/**
 * The Slack Connect perk on a one-shot form (Settings > Branding, the org-name
 * popup). `done`: this user already asked (there, in the bell or in another
 * perk), so the form skips a second request. `request` sends the request and,
 * once it lands, `notification.submitted` with the email domain only, never
 * the address. It rejects like `requestSlackConnectInvite` and shows no toast.
 */
export function useSlackConnectPerk() {
  const { userId } = useCurrentUser();
  const inbox = useInboxState({ userId, itemType: "notification" });
  const requestInvite = useRequestSlackConnectInvite();
  const { trackEvent } = useNotificationEvents();
  const done = Boolean(
    inbox.data?.some((row) => row.itemId === SLACK_CONNECT_INVITE_KEY && row.status === "done"),
  );

  async function request(email: string, details: SlackConnectInviteDetails = {}): Promise<void> {
    await requestInvite(email, details);
    trackEvent(SLACK_CONNECT_INVITE_KEY, "submit", {
      email_domain: domainOf(email) ?? undefined,
      user_function: details.user_function,
    });
  }

  return { done, request };
}

/** Dismiss, and the one-field request with a toast (the fleet benchmark perk). */
export function useSlackConnectInvite(
  key: string = SLACK_CONNECT_INVITE_KEY,
  moment?: SlackConnectMoment,
) {
  const { trackEvent } = useNotificationEvents();
  const requestInvite = useRequestSlackConnectInvite();
  const resolve = useResolveInvite(key);

  function dismiss() {
    trackEvent(key, "dismiss", { moment });
    resolve("dismissed");
  }

  /** Returns false when there is nothing to send. */
  function submit(email: string): boolean {
    const value = email.trim();
    if (!value) return false;
    requestInvite(value).then(
      () => {
        trackEvent(key, "submit", { email_domain: value.split("@")[1] || undefined, moment });
        toast.success("Thanks. We'll reach out to set up the Slack Connect channel.");
      },
      () => toast.error("Could not send the request. Try again."),
    );
    return true;
  }

  return { submit, dismiss };
}
