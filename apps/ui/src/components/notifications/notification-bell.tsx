import { Bell } from "lucide-react";
import { useState } from "react";
import { useLocation } from "react-router-dom";
import { useAgentFsMentions } from "@/api/hooks/use-agent-fs";
import { useInboxState, useUpdateInboxItem } from "@/api/hooks/use-inbox-state";
import { useEnvPresence } from "@/api/hooks/use-integrations-meta";
import { useNotificationEvents } from "@/api/hooks/use-notification-events";
import { useOnboardingOwnsFirstRun } from "@/api/hooks/use-onboarding";
import type { InboxItemState } from "@/api/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useCurrentUser } from "@/contexts/current-user-context";
import { useConfig } from "@/hooks/use-config";
import {
  NOTIFICATION_DEFINITIONS,
  ORGANIZATION_NAME_NOTIFICATION,
} from "@/lib/notifications/definitions";
import { unreadBadgeLabel } from "@/lib/notifications/unread";
import { useOrgNamePromptDeferred } from "@/lib/org-name-prompt";
import { isAdminLike } from "@/lib/user-role";
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
  const { pathname } = useLocation();
  const presence = useEnvPresence(["SWARM_ORG_NAME"]);
  const onboardingOwnsName = useOnboardingOwnsFirstRun();
  const { config } = useConfig();
  const orgPromptDeferred = useOrgNamePromptDeferred(config.apiUrl);
  const inboxState = useInboxState({ userId: currentUser.userId, itemType: "notification" });
  const { trackEvent } = useNotificationEvents();
  const updateInboxItem = useUpdateInboxItem();
  // Comb mentions belong to the agent-fs identity, not the swarm user, so
  // they keep the bell visible without a current user.
  const mentions = useAgentFsMentions();
  const [open, setOpen] = useState(false);
  const [mountedAt] = useState(Date.now);

  const hasUser = Boolean(currentUser.userId);
  if (!hasUser && !mentions.drive) return null;

  const stateByKey = new Map((inboxState.data ?? []).map((row) => [row.itemId, row]));
  const orgState = stateByKey.get(ORGANIZATION_NAME_NOTIFICATION.key);
  // Home asks with the org-name dialog until Later; only then does the bell ask there.
  const showOrgName =
    (pathname !== "/" || orgPromptDeferred) &&
    isAdminLike(currentUser.user) &&
    !onboardingOwnsName &&
    !presence.isError &&
    presence.dataUpdatedAt >= mountedAt &&
    presence.data?.SWARM_ORG_NAME === false &&
    orgState?.status !== "dismissed" &&
    orgState?.status !== "done";
  const definitions = showOrgName
    ? [ORGANIZATION_NAME_NOTIFICATION, ...NOTIFICATION_DEFINITIONS]
    : NOTIFICATION_DEFINITIONS;
  const staticUnread = hasUser
    ? definitions.filter((definition) => isUnread(stateByKey.get(definition.key))).length
    : 0;
  // Static notifications (per swarm user) plus Comb mentions (per agent-fs identity).
  const unreadCount = staticUnread + (mentions.drive ? (mentions.query.data?.unreadCount ?? 0) : 0);

  // Opening marks the static definitions read. Mentions stay unread until
  // clicked or "Mark all read".
  function handleOpenChange(next: boolean) {
    setOpen(next);
    if (!next || !hasUser) return;
    const nowIso = new Date().toISOString();
    for (const definition of definitions) {
      const state = stateByKey.get(definition.key);
      if (!isUnread(state)) continue;
      if (definition.key !== ORGANIZATION_NAME_NOTIFICATION.key) trackEvent(definition.key, "view");
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
          definitions={definitions}
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
          showStatic={hasUser}
          mentions={mentions}
          onNavigate={() => setOpen(false)}
        />
      </PopoverContent>
    </Popover>
  );
}
