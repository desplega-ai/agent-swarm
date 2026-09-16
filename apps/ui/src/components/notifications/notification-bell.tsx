import { Bell } from "lucide-react";
import { useState } from "react";
import { useInboxState, useUpdateInboxItem } from "@/api/hooks/use-inbox-state";
import { useNotificationEvents } from "@/api/hooks/use-notification-events";
import type { InboxItemState } from "@/api/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useCurrentUser } from "@/contexts/current-user-context";
import { NOTIFICATION_DEFINITIONS } from "@/lib/notifications/definitions";
import { NotificationPanel } from "./notification-panel";

/**
 * True when a definition still counts toward the unread badge: no
 * server-side row yet, or it hasn't been marked read (`readAt` unset).
 * `readAt` is independent of `status` — a dismissed/done item can still be
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
  const [open, setOpen] = useState(false);

  if (!currentUser.userId) return null;

  const stateByKey = new Map((inboxState.data ?? []).map((row) => [row.itemId, row]));
  const unreadCount = NOTIFICATION_DEFINITIONS.filter((definition) =>
    isUnread(stateByKey.get(definition.key)),
  ).length;

  function handleOpenChange(next: boolean) {
    setOpen(next);
    if (!next) return;
    const nowIso = new Date().toISOString();
    for (const definition of NOTIFICATION_DEFINITIONS) {
      const state = stateByKey.get(definition.key);
      if (!isUnread(state)) continue;
      trackEvent(definition.key, "view");
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
              {unreadCount}
            </Badge>
          ) : null}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-96 p-0">
        <NotificationPanel stateByKey={stateByKey} />
      </PopoverContent>
    </Popover>
  );
}
