import { getDbClient } from "./db";

/**
 * Session sharing store. A session is a root task (`parentTaskId IS NULL`) and
 * its descendants; its owner is the root's `requestedByUserId`.
 *
 * Rows in `session_shares` are never deleted. Revoking sets `revokedAt`, and an
 * access change revokes the active row and inserts a new one in the same
 * transaction, so the rows for a root are its full share history.
 */

export type SessionShareAccess = "read" | "write";
export type SessionAccess = "owner" | SessionShareAccess | "none";
export type SessionEveryoneAccess = SessionShareAccess | "none";

export type SessionShareRow = {
  id: string;
  rootTaskId: string;
  /** NULL = everyone. */
  userId: string | null;
  access: SessionShareAccess;
  createdAt: string;
  revokedAt: string | null;
  revokedBy: string | null;
};

/**
 * `scheduleId` is set when a schedule fired the root task. Such a session is
 * readable by every user, the same as the schedule itself.
 */
export type SessionRoot = {
  id: string;
  requestedByUserId: string | null;
  scheduleId?: string | null;
};

export type SessionSharesState = {
  everyone: SessionEveryoneAccess;
  users: { userId: string; access: SessionShareAccess; createdAt: string }[];
};

export type DesiredSessionShares = {
  everyone: SessionEveryoneAccess;
  users: { userId: string; access: SessionShareAccess }[];
};

const RANK: Record<SessionAccess, number> = { none: 0, read: 1, write: 2, owner: 3 };

/** True when `access` grants at least `needed`. */
export function hasSessionAccess(access: SessionAccess, needed: SessionAccess): boolean {
  return RANK[access] >= RANK[needed];
}

/**
 * The session root of any task: walk `parentTaskId` up to the topmost task
 * that still exists. No depth cap, so a chain of any length resolves to its
 * actual root; a corrupt parent cycle has no top and resolves to null.
 */
export async function getSessionRoot(taskId: string): Promise<SessionRoot | null> {
  return (await getSessionRoots([taskId])).get(taskId) ?? null;
}

const ROOT_LOOKUP_CHUNK = 500;

type AncestorRow = {
  id: string;
  parentTaskId: string | null;
  requestedByUserId: string | null;
  scheduleId: string | null;
};

/** `getSessionRoot` for many tasks; unknown tasks and tasks in a cycle are absent. */
export async function getSessionRoots(taskIds: string[]): Promise<Map<string, SessionRoot>> {
  const ids = [...new Set(taskIds)];
  // Every ancestor once (`UNION` drops revisits, which also ends a cycle),
  // then resolve each chain in memory: linear in the tasks involved.
  const tasks = new Map<string, AncestorRow>();
  for (let start = 0; start < ids.length; start += ROOT_LOOKUP_CHUNK) {
    const chunk = ids.slice(start, start + ROOT_LOOKUP_CHUNK).filter((id) => !tasks.has(id));
    if (chunk.length === 0) continue;
    const rows = await getDbClient().query<AncestorRow>(
      `WITH RECURSIVE up(id) AS (
           SELECT id FROM agent_tasks WHERE id IN (${chunk.map(() => "?").join(", ")})
           UNION
           SELECT t.parentTaskId FROM agent_tasks t JOIN up ON t.id = up.id
           WHERE t.parentTaskId IS NOT NULL
         )
         SELECT t.id, t.parentTaskId, t.requestedByUserId, t.scheduleId
         FROM up CROSS JOIN agent_tasks t ON t.id = up.id`,
      chunk,
    );
    for (const row of rows) tasks.set(row.id, row);
  }

  const resolved = new Map<string, SessionRoot | null>();
  const rootOf = (taskId: string): SessionRoot | null => {
    const path: string[] = [];
    const onPath = new Set<string>();
    let current = tasks.get(taskId);
    let root: SessionRoot | null = null;
    while (current) {
      const known = resolved.get(current.id);
      if (known !== undefined) {
        root = known;
        break;
      }
      if (onPath.has(current.id)) break;
      path.push(current.id);
      onPath.add(current.id);
      const parent = current.parentTaskId ? tasks.get(current.parentTaskId) : undefined;
      if (!parent) {
        root = {
          id: current.id,
          requestedByUserId: current.requestedByUserId,
          scheduleId: current.scheduleId,
        };
        break;
      }
      current = parent;
    }
    for (const id of path) resolved.set(id, root);
    return root;
  };

  const roots = new Map<string, SessionRoot>();
  for (const id of ids) {
    const root = rootOf(id);
    if (root) roots.set(id, root);
  }
  return roots;
}

/**
 * What `actingUserId` may do in the session rooted at `root`.
 *
 * - `owner` for the root's requester, and for every user when the root has no
 *   owner (Slack sessions stay open, as before sharing existed).
 * - Otherwise the best active share naming the user or everyone. A schedule
 *   session (the root has a `scheduleId`) is at least `read` for every user:
 *   the scheduler names the schedule's creator as the requester, but the
 *   schedule and its tasks are visible to all. Any other root with no rows is
 *   private to its owner (`none`).
 *
 * A null `actingUserId` is a viewer with no user (a guest page session): it
 * gets ownerless roots and everyone shares only. Callers that act for no user
 * (agents, operator-key calls with no picked dashboard user) skip this check
 * entirely; see `resolveSessionActor`.
 */
export async function sessionAccessForRoot(
  actingUserId: string | null,
  root: SessionRoot,
): Promise<SessionAccess> {
  if (!root.requestedByUserId) return "owner";
  if (actingUserId && root.requestedByUserId === actingUserId) return "owner";
  const rows = await getDbClient().query<{ access: SessionShareAccess }>(
    `SELECT access FROM session_shares
     WHERE rootTaskId = ? AND revokedAt IS NULL AND (userId IS NULL OR userId = ?)`,
    [root.id, actingUserId],
  );
  if (rows.some((row) => row.access === "write")) return "write";
  return rows.length > 0 || root.scheduleId ? "read" : "none";
}

/** `sessionAccessForRoot` for any task in the session; `none` for an unknown task. */
export async function sessionAccess(
  actingUserId: string | null,
  taskId: string,
): Promise<SessionAccess> {
  const root = await getSessionRoot(taskId);
  return root ? sessionAccessForRoot(actingUserId, root) : "none";
}

export async function listActiveSessionShares(rootTaskId: string): Promise<SessionShareRow[]> {
  return getDbClient().query<SessionShareRow>(
    `SELECT id, rootTaskId, userId, access, createdAt, revokedAt, revokedBy
     FROM session_shares
     WHERE rootTaskId = ? AND revokedAt IS NULL
     ORDER BY createdAt, rowid`,
    [rootTaskId],
  );
}

/** Every row for a root, revoked ones included, oldest first. */
export async function listSessionShareHistory(rootTaskId: string): Promise<SessionShareRow[]> {
  return getDbClient().query<SessionShareRow>(
    `SELECT id, rootTaskId, userId, access, createdAt, revokedAt, revokedBy
     FROM session_shares
     WHERE rootTaskId = ?
     ORDER BY createdAt, rowid`,
    [rootTaskId],
  );
}

export function toSessionSharesState(rows: SessionShareRow[]): SessionSharesState {
  const everyone = rows.find((row) => row.userId === null);
  return {
    everyone: everyone?.access ?? "none",
    users: rows
      .filter((row) => row.userId !== null)
      .map((row) => ({ userId: row.userId!, access: row.access, createdAt: row.createdAt })),
  };
}

/**
 * Make the active shares of `root` equal `desired`, in one write transaction.
 * A target whose access changes has its active row revoked and a new row
 * inserted; a target no longer listed is revoked; nothing is deleted or
 * updated in place apart from revocation. The owner is never stored.
 */
export async function setSessionShares(
  root: SessionRoot,
  desired: DesiredSessionShares,
  actorUserId: string | null,
): Promise<SessionSharesState> {
  const want = new Map<string, SessionShareAccess>();
  if (desired.everyone !== "none") want.set("*", desired.everyone);
  for (const user of desired.users) {
    if (user.userId !== root.requestedByUserId) want.set(user.userId, user.access);
  }

  return getDbClient().transaction(async (tx) => {
    const now = new Date().toISOString();
    const active = await tx.query<SessionShareRow>(
      `SELECT id, rootTaskId, userId, access, createdAt, revokedAt, revokedBy
       FROM session_shares WHERE rootTaskId = ? AND revokedAt IS NULL`,
      [root.id],
    );
    const kept = new Set<string>();
    for (const row of active) {
      const target = row.userId ?? "*";
      if (want.get(target) === row.access) {
        kept.add(target);
        continue;
      }
      await tx.run(
        "UPDATE session_shares SET revokedAt = ?, revokedBy = ?, updated_by = ? WHERE id = ?",
        [now, actorUserId, actorUserId, row.id],
      );
    }
    for (const [target, access] of want) {
      if (kept.has(target)) continue;
      await tx.run(
        `INSERT INTO session_shares (id, rootTaskId, userId, access, createdAt, created_by, updated_by)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          crypto.randomUUID(),
          root.id,
          target === "*" ? null : target,
          access,
          now,
          actorUserId,
          actorUserId,
        ],
      );
    }
    const rows = await tx.query<SessionShareRow>(
      `SELECT id, rootTaskId, userId, access, createdAt, revokedAt, revokedBy
       FROM session_shares WHERE rootTaskId = ? AND revokedAt IS NULL
       ORDER BY createdAt, rowid`,
      [root.id],
    );
    return toSessionSharesState(rows);
  });
}
