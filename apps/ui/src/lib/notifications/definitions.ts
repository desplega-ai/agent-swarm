/**
 * Notification-center definitions.
 *
 * A "notification" is a static, code-defined announcement shown in the
 * dashboard's bell/panel (see `NotificationBell`). Read/dismiss/done state
 * per user lives server-side in `inbox_item_state` (itemType "notification",
 * itemId = the definition's `key`) so it survives reloads and syncs across
 * devices — see migration 057 and `src/http/inbox-state.ts`.
 *
 * Add a new notification by appending to `NOTIFICATION_DEFINITIONS`. Order
 * here is display order (newest/most relevant first).
 */
export interface NotificationDefinition {
  /** Stable key — becomes the `itemId` in `inbox_item_state`. Never rename. */
  key: string;
  title: string;
  body: string;
}

export const NOTIFICATION_DEFINITIONS: NotificationDefinition[] = [
  {
    key: "slack_connect_invite",
    title: "Connect with us on Slack",
    body: "Share a Slack Connect channel with your team and ours, so we can see how you're using the swarm and help faster when something looks off.",
  },
];
