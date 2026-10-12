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
  href?: string;
  actionLabel?: string;
}

export const NOTIFICATION_DEFINITIONS: NotificationDefinition[] = [
  {
    key: "slack_connect_invite",
    title: "Connect with us on Slack",
    body: "A shared Slack channel with the team that builds Agent Swarm. We reply within a business day.",
  },
];

export const ORGANIZATION_NAME_NOTIFICATION: NotificationDefinition = {
  key: "organization_name",
  title: "Name your organization",
  body: "Add a name for your dashboard and messages.",
  href: "/settings/configuration?search=SWARM_ORG_NAME#setting-SWARM_ORG_NAME",
  actionLabel: "Add name",
};
