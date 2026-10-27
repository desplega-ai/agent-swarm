/**
 * Session-list visibility for session sharing. `all`: sessions the viewer
 * owns, ownerless sessions, schedule runs (`scheduleId`, readable by every
 * user, as in `readableSessionCondition`), and sessions shared with the viewer
 * or everyone.
 * `mine`: owned by the viewer. `shared`: owned by someone else and shared with
 * the viewer or everyone. A null `userId` (a guest page session) owns nothing.
 */
export type SessionViewer = { userId: string | null; scope: "all" | "mine" | "shared" };

/** SQL condition + params restricting root tasks (alias `r`) to what `viewer` may open. */
export function sessionViewerCondition(viewer: SessionViewer): {
  sql: string;
  params: (string | null)[];
} {
  const shared = `EXISTS (SELECT 1 FROM session_shares s
      WHERE s.rootTaskId = r.id AND s.revokedAt IS NULL AND (s.userId IS NULL OR s.userId = ?))`;
  if (viewer.scope === "mine") {
    return { sql: "r.requestedByUserId = ?", params: [viewer.userId] };
  }
  if (viewer.scope === "shared") {
    return {
      sql: `(r.requestedByUserId IS NOT NULL AND r.requestedByUserId IS NOT ? AND ${shared})`,
      params: [viewer.userId, viewer.userId],
    };
  }
  return {
    sql: `(r.requestedByUserId IS NULL OR r.requestedByUserId = ? OR r.scheduleId IS NOT NULL OR ${shared})`,
    params: [viewer.userId, viewer.userId],
  };
}

/**
 * Root sources that a machine starts: a workflow run, a schedule, or the
 * swarm itself (heartbeat, follow-ups, budget and approval notices). A
 * workflow root carries the user whose trigger fired it, so the requester
 * alone does not tell a person's session from fan-out. `kapso-inbound` is the
 * exception: a WhatsApp message a person sent, written with `system`.
 */
export const MACHINE_SESSION_SOURCES = ["workflow", "schedule", "system"] as const;
const HUMAN_SYSTEM_TASK_TYPES = ["kapso-inbound"] as const;

/**
 * The sessions v2 "Mine" view (alias `r`): roots this user started from a
 * human channel (every source outside {@link MACHINE_SESSION_SOURCES}), plus
 * sessions shared with this user or everyone. A list filter only: it narrows
 * what a list shows and never changes who can open a session.
 */
export function sessionMineCondition(userId: string | null): {
  sql: string;
  params: (string | null)[];
} {
  const machine = MACHINE_SESSION_SOURCES.map(() => "?").join(",");
  const humanSystem = HUMAN_SYSTEM_TASK_TYPES.map(() => "?").join(",");
  return {
    sql: `((r.requestedByUserId = ? AND (r.source NOT IN (${machine})
        OR (r.source = 'system' AND r.taskType IN (${humanSystem}))))
      OR EXISTS (SELECT 1 FROM session_shares s
        WHERE s.rootTaskId = r.id AND s.revokedAt IS NULL AND (s.userId IS NULL OR s.userId = ?)))`,
    params: [userId, ...MACHINE_SESSION_SOURCES, ...HUMAN_SYSTEM_TASK_TYPES, userId],
  };
}
