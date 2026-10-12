/**
 * Submit or dismiss the Slack Connect invite. Shared by the bell card and the
 * fleet benchmark perk, so both resolve the same per-user inbox row and send
 * the same events.
 */
import { toast } from "sonner";
import { useUpdateInboxItem } from "@/api/hooks/use-inbox-state";
import { useNotificationEvents } from "@/api/hooks/use-notification-events";
import { useCurrentUser } from "@/contexts/current-user-context";

export const SLACK_CONNECT_INVITE_KEY = "slack_connect_invite";

export function useSlackConnectInvite(key: string = SLACK_CONNECT_INVITE_KEY) {
  const currentUser = useCurrentUser();
  const updateInboxItem = useUpdateInboxItem();
  const { trackEvent, notifyUs } = useNotificationEvents();

  function resolve(status: "dismissed" | "done") {
    if (!currentUser.userId) return;
    updateInboxItem.mutate({
      userId: currentUser.userId,
      itemType: "notification",
      itemId: key,
      status,
    });
  }

  function dismiss() {
    trackEvent(key, "dismiss");
    resolve("dismissed");
  }

  /** Returns false when there is nothing to send. */
  function submit(email: string): boolean {
    const value = email.trim();
    if (!value) return false;
    const domain = value.split("@")[1] || undefined;
    notifyUs(key, "requested a Slack Connect channel invite", value);
    trackEvent(key, "submit", domain);
    resolve("done");
    toast.success("Thanks — we'll reach out to set up the Slack Connect channel.");
    return true;
  }

  return { submit, dismiss };
}
