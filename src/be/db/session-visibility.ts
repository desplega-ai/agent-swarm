/**
 * Session-list visibility for session sharing. `all`: sessions the viewer
 * owns, ownerless sessions, and sessions shared with the viewer or everyone.
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
    sql: `(r.requestedByUserId IS NULL OR r.requestedByUserId = ? OR ${shared})`,
    params: [viewer.userId, viewer.userId],
  };
}
