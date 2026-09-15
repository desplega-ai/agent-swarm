import type { ComponentType } from "react";
import type { InboxItemState } from "@/api/types";
import {
  NOTIFICATION_DEFINITIONS,
  type NotificationDefinition,
} from "@/lib/notifications/definitions";
import { SlackConnectInviteCard } from "./slack-connect-invite-card";

/** Per-key custom card. A definition without an entry falls back to a plain title+body render. */
const CARD_COMPONENTS: Record<
  string,
  ComponentType<{ definition: NotificationDefinition; state?: InboxItemState }>
> = {
  slack_connect_invite: SlackConnectInviteCard,
};

export function NotificationPanel({ stateByKey }: { stateByKey: Map<string, InboxItemState> }) {
  return (
    <div className="flex flex-col">
      <div className="border-b px-4 py-3">
        <h3 className="text-sm font-semibold">Notifications</h3>
      </div>
      <div className="max-h-96 divide-y overflow-y-auto">
        {NOTIFICATION_DEFINITIONS.length === 0 ? (
          <p className="px-4 py-6 text-center text-sm text-muted-foreground">
            No notifications yet.
          </p>
        ) : (
          NOTIFICATION_DEFINITIONS.map((definition) => {
            const Card = CARD_COMPONENTS[definition.key];
            const state = stateByKey.get(definition.key);
            return (
              <div key={definition.key} className="px-4 py-3">
                {Card ? (
                  <Card definition={definition} state={state} />
                ) : (
                  <div className="space-y-1">
                    <p className="text-sm font-medium">{definition.title}</p>
                    <p className="text-xs text-muted-foreground">{definition.body}</p>
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
