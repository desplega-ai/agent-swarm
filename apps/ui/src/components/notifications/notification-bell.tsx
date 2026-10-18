import { Bell } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useAgentFsMentions } from "@/api/hooks/use-agent-fs";
import { useInboxState, useUpdateInboxItem } from "@/api/hooks/use-inbox-state";
import { useNotificationEvents } from "@/api/hooks/use-notification-events";
import type { InboxItemState, SlackConnectMoment } from "@/api/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useCurrentUser } from "@/contexts/current-user-context";
import { SLACK_CONNECT_INVITE_KEY } from "@/hooks/use-slack-connect-invite";
import { NOTIFICATION_DEFINITIONS } from "@/lib/notifications/definitions";
import { unreadBadgeLabel } from "@/lib/notifications/unread";
import { NotificationPanel } from "./notification-panel";
import { useSlackConnectMoment } from "./use-slack-connect-moment";

/**
 * True when a definition still counts toward the unread badge: no
 * server-side row yet, or it hasn't been marked read (`readAt` unset).
 * `readAt` is independent of `status`: a dismissed or done item can still be
 * browsed in the panel, it just stops driving the badge count.
 */
function isUnread(state: InboxItemState | undefined): boolean {
  return !state?.readAt;
}

export function NotificationBell() {
  const currentUser = useCurrentUser();
  const inboxState = useInboxState({ userId: currentUser.userId, itemType: "notification" });
  const { trackEvent } = useNotificationEvents();
  const updateInboxItem = useUpdateInboxItem();
  // Comb mentions belong to the agent-fs identity, not the swarm user, so
  // they keep the bell visible without a current user.
  const mentions = useAgentFsMentions();
  const [open, setOpen] = useState(false);
  const hasUser = Boolean(currentUser.userId);
  const inviteRow = inboxState.data?.find((row) => row.itemId === SLACK_CONNECT_INVITE_KEY);
  // The moment polls failed tasks, so it runs only while the invite is still open.
  const inviteOpen =
    hasUser &&
    inboxState.data !== undefined &&
    inviteRow?.status !== "dismissed" &&
    inviteRow?.status !== "done";
  const liveMoment = useSlackConnectMoment(inviteOpen);
  // Pinned at the first resolved value after the bell opens, so the invite copy
  // and its view, dismiss and submit events use one moment.
  const [pinnedMoment, setPinnedMoment] = useState<SlackConnectMoment | null>(null);
  const inviteViewPending = useRef(false);
  useEffect(() => {
    if (!open || pinnedMoment || !liveMoment) return;
    setPinnedMoment(liveMoment);
    if (!inviteViewPending.current) return;
    inviteViewPending.current = false;
    trackEvent(SLACK_CONNECT_INVITE_KEY, "view", { moment: liveMoment });
  }, [open, pinnedMoment, liveMoment, trackEvent]);

  if (!hasUser && !mentions.drive) return null;

  const stateByKey = new Map((inboxState.data ?? []).map((row) => [row.itemId, row]));
  const staticUnread = hasUser
    ? NOTIFICATION_DEFINITIONS.filter((definition) => isUnread(stateByKey.get(definition.key)))
        .length
    : 0;
  // Static notifications (per swarm user) plus Comb mentions (per agent-fs identity).
  const unreadCount = staticUnread + (mentions.drive ? (mentions.query.data?.unreadCount ?? 0) : 0);

  // Opening marks the static definitions read. Mentions stay unread until
  // clicked or "Mark all read".
  function handleOpenChange(next: boolean) {
    setOpen(next);
    if (!next) {
      // A view still waiting for its moment goes out without one.
      if (inviteViewPending.current) trackEvent(SLACK_CONNECT_INVITE_KEY, "view");
      inviteViewPending.current = false;
      return;
    }
    // Kept through the close animation; the effect above fills it if it is still loading.
    setPinnedMoment(liveMoment);
    if (!hasUser) return;
    const nowIso = new Date().toISOString();
    for (const definition of NOTIFICATION_DEFINITIONS) {
      const state = stateByKey.get(definition.key);
      if (!isUnread(state)) continue;
      if (definition.key === SLACK_CONNECT_INVITE_KEY && inviteOpen) {
        if (liveMoment) trackEvent(definition.key, "view", { moment: liveMoment });
        else inviteViewPending.current = true;
      } else {
        trackEvent(definition.key, "view");
      }
      if (!currentUser.userId) continue;
      updateInboxItem.mutate({
        userId: currentUser.userId,
        itemType: "notification",
        itemId: definition.key,
        status: state?.status ?? "open",
        readAt: nowIso,
      });
    }
  }

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="relative size-8"
          aria-label={unreadCount > 0 ? `Notifications, ${unreadCount} unread` : "Notifications"}
        >
          <Bell className="size-4" />
          {unreadCount > 0 ? (
            <Badge
              variant="destructive"
              className="absolute -top-1 -right-1 size-4 min-w-4 justify-center rounded-full px-0 text-[10px] leading-none"
            >
              {unreadBadgeLabel(unreadCount)}
            </Badge>
          ) : null}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-96 p-0">
        <NotificationPanel
          definitions={NOTIFICATION_DEFINITIONS}
          onDismiss={(key) => {
            if (!currentUser.userId) return;
            updateInboxItem.mutate({
              userId: currentUser.userId,
              itemType: "notification",
              itemId: key,
              status: "dismissed",
              readAt: new Date().toISOString(),
            });
          }}
          stateByKey={stateByKey}
          inviteMoment={pinnedMoment}
          showStatic={hasUser}
          mentions={mentions}
          onNavigate={() => setOpen(false)}
        />
      </PopoverContent>
    </Popover>
  );
}
