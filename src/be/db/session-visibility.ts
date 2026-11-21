/**
 * Session-list visibility for session sharing. `all`: sessions the viewer
 * owns, ownerless sessions, schedule runs (`scheduleId`, readable by every
 * user, as in `readableSessionCondition`), and sessions shared with the viewer
 * or everyone.
 * `mine`: owned by the viewer. `shared`: owned by someone else and shared with
 * the viewer or everyone. A null `userId` (a guest page session) owns nothing.
 * `readAll` (the all-users read scope) lifts the `all` filter: every root.
 * The SQL condition is the sessions repository's (`SessionViewerSpec`).
 */
export type SessionViewer = {
  userId: string | null;
  scope: "all" | "mine" | "shared";
  readAll?: boolean;
};

/**
 * Root sources that a machine starts: a workflow run, a schedule, or the
 * swarm itself (heartbeat, follow-ups, budget and approval notices). A
 * workflow root carries the user whose trigger fired it, so the requester
 * alone does not tell a person's session from fan-out. `kapso-inbound` is the
 * exception: a WhatsApp message a person sent, written with `system`.
 *
 * The sessions v2 "Mine" view keeps roots this user started from a human
 * channel (every source outside these), plus sessions shared with this user
 * or everyone. A list filter only: it narrows what a list shows and never
 * changes who can open a session. The all-users read scope widens the owner
 * check to every user's human-started roots.
 */
export const MACHINE_SESSION_SOURCES = ["workflow", "schedule", "system"] as const;
export const HUMAN_SYSTEM_TASK_TYPES = ["kapso-inbound"] as const;
