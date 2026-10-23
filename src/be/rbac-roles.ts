import type { PermissionVerb } from "../rbac";
import { PermissionVerbSchema } from "../rbac";
import { invalidateTelemetryUserRole } from "../telemetry-identity";
import { isEnvFlagEnabled } from "../utils/env-flag";
import { getDb, getDbClient } from "./db";

export const DEFAULT_ROLE_ID = "rbac-role-admin";

type BuiltinRoleDefinition = {
  id: string;
  name: string;
  description: string;
  grantsAll: boolean;
  verbs: PermissionVerb[];
};

export const BUILTIN_ROLES = [
  {
    id: DEFAULT_ROLE_ID,
    name: "admin",
    description: "Full access including verb-less routes (legacy-equivalent default).",
    isBuiltin: true,
    grantsAll: true,
    verbs: [] as PermissionVerb[],
  },
  {
    id: "rbac-role-requester",
    name: "requester",
    description: "Own-task lifecycle: what legacy policy grants user principals.",
    isBuiltin: true,
    grantsAll: false,
    verbs: [
      "task.create.own",
      "task.read.own",
      "task.cancel.own",
      "task.action.own",
      "task.fs.mutate",
      "favorite.write.own",
      "session.share",
      "session.presence",
    ],
  },
  {
    id: "rbac-role-viewer",
    name: "viewer",
    description: "Read-only: no task, approval or script writes.",
    isBuiltin: true,
    grantsAll: false,
    verbs: ["favorite.write.own", "session.presence"],
  },
] satisfies (BuiltinRoleDefinition & { isBuiltin: true })[];

/** A person holds exactly one of these; other roles are extras on top. */
export const PRIMARY_ROLE_NAMES: readonly string[] = ["admin", "requester", "viewer"];

export type EffectiveGrant = {
  grantsAll: boolean;
  verbs: ReadonlySet<PermissionVerb>;
};

export type UserRole = {
  id: string;
  name: string;
  description: string | null;
  isBuiltin: boolean;
  grantsAll: boolean;
  createdAt: string;
};

const CREATE_USER_DEFAULT_ROLE_TRIGGER_SQL = `
CREATE TRIGGER IF NOT EXISTS trg_users_default_role
AFTER INSERT ON users
BEGIN
  INSERT OR IGNORE INTO principal_roles (principalType, principalId, roleId)
  SELECT 'user', NEW.id, 'rbac-role-admin'
  WHERE EXISTS (SELECT 1 FROM roles WHERE id = 'rbac-role-admin');
END;
`;

type GrantRow = {
  roleId: string;
  grantsAll: number;
  verb: string | null;
};

type RoleIdRow = {
  id: string;
};

type RoleIdentityRow = {
  id: string;
  name: string;
};

type GrantRoleRow = RoleIdentityRow & { grantsAll: number };

type UserRoleRow = {
  id: string;
  name: string;
  description: string | null;
  isBuiltin: number;
  grantsAll: number;
  createdAt: string;
};

type PermissionRow = {
  verb: string;
};

type RbacRoleSummaryRow = {
  name: string;
  isBuiltin: number;
  grantsAll: number;
  verbCount: number;
  attachedUserCount: number;
};

type RbacSeedSyncStats = {
  rolesInserted: number;
  rolesUpdated: number;
  permissionsInserted: number;
  permissionsDeleted: number;
  usersBackfilled: number;
};

function roleRowToUserRole(row: UserRoleRow): UserRole {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    isBuiltin: row.isBuiltin === 1,
    grantsAll: row.grantsAll === 1,
    createdAt: row.createdAt,
  };
}

async function requireRoleId(roleName: string): Promise<string> {
  const row = await getDbClient().get<RoleIdRow>("SELECT id FROM roles WHERE name = ?", [roleName]);
  if (!row) {
    throw new Error(`Unknown RBAC role: ${roleName}`);
  }
  return row.id;
}

function validateBuiltinVerb(roleName: string, verb: string): PermissionVerb {
  const parsed = PermissionVerbSchema.safeParse(verb);
  if (!parsed.success) {
    throw new Error(`Invalid RBAC permission verb "${verb}" in built-in role "${roleName}"`);
  }
  return parsed.data;
}

function validatedBuiltinVerbSets(): Map<string, Set<PermissionVerb>> {
  const byRoleId = new Map<string, Set<PermissionVerb>>();
  for (const role of BUILTIN_ROLES) {
    const verbs = new Set<PermissionVerb>();
    for (const verb of role.verbs) {
      verbs.add(validateBuiltinVerb(role.name, verb));
    }
    byRoleId.set(role.id, verbs);
  }
  return byRoleId;
}

const loggedInvalidGrantVerbs = new Set<string>();

function parseDatabaseGrantVerb(roleId: string, verb: string): PermissionVerb | null {
  const parsed = PermissionVerbSchema.safeParse(verb);
  if (parsed.success) {
    return parsed.data;
  }

  const logKey = `${roleId}:${verb}`;
  if (!loggedInvalidGrantVerbs.has(logKey)) {
    loggedInvalidGrantVerbs.add(logKey);
    console.error(
      `[rbac] Ignoring invalid role_permissions verb "${verb}" for roleId="${roleId}". ` +
        "Invalid RBAC verbs grant nothing; remove or repair the row.",
    );
  }

  return null;
}

export async function getUserGrant(userId: string): Promise<EffectiveGrant> {
  const rows = await getDbClient().query<GrantRow>(
    `SELECT r.id AS roleId, r.grantsAll, rp.verb
     FROM principal_roles pr
     JOIN roles r ON r.id = pr.roleId
     LEFT JOIN role_permissions rp ON rp.roleId = r.id
     WHERE pr.principalType = 'user' AND pr.principalId = ?
     ORDER BY r.grantsAll DESC`,
    [userId],
  );

  if (rows.length === 0) {
    return { grantsAll: false, verbs: new Set() };
  }

  const verbs = new Set<PermissionVerb>();
  for (const row of rows) {
    if (row.grantsAll === 1) {
      return { grantsAll: true, verbs: new Set() };
    }
    if (row.verb) {
      const verb = parseDatabaseGrantVerb(row.roleId, row.verb);
      if (verb) {
        verbs.add(verb);
      }
    }
  }

  return { grantsAll: false, verbs };
}

export async function attachRole(userId: string, roleName: string): Promise<void> {
  await getDbClient().transaction(async (tx) => {
    const roleId = await requireRoleId(roleName);
    await tx.run(
      `INSERT OR IGNORE INTO principal_roles (principalType, principalId, roleId)
       VALUES ('user', ?, ?)`,
      [userId, roleId],
    );
  });
}

export async function detachRole(userId: string, roleName: string): Promise<void> {
  await getDbClient().transaction(async (tx) => {
    const roleId = await requireRoleId(roleName);
    await tx.run(
      `DELETE FROM principal_roles
       WHERE principalType = 'user' AND principalId = ? AND roleId = ?`,
      [userId, roleId],
    );
  });
}

export async function listUserRoles(userId: string): Promise<UserRole[]> {
  const rows = await getDbClient().query<UserRoleRow>(
    `SELECT r.id, r.name, r.description, r.isBuiltin, r.grantsAll, r.createdAt
     FROM principal_roles pr
     JOIN roles r ON r.id = pr.roleId
     WHERE pr.principalType = 'user' AND pr.principalId = ?
     ORDER BY r.name`,
    [userId],
  );
  return rows.map(roleRowToUserRole);
}

export type RbacRoleCatalogEntry = UserRole & { primary: boolean; verbs: string[] };

/** Every role with its verbs, for the role picker. */
export async function listRbacRoles(): Promise<RbacRoleCatalogEntry[]> {
  const client = getDbClient();
  const roles = await client.query<UserRoleRow>(
    "SELECT id, name, description, isBuiltin, grantsAll, createdAt FROM roles ORDER BY name",
  );
  const perms = await client.query<{ roleId: string; verb: string }>(
    "SELECT roleId, verb FROM role_permissions ORDER BY verb",
  );
  return roles.map((row) => ({
    ...roleRowToUserRole(row),
    primary: PRIMARY_ROLE_NAMES.includes(row.name),
    verbs: perms.filter((p) => p.roleId === row.id).map((p) => p.verb),
  }));
}

export class InvalidRoleSetError extends Error {}

export class LastAdminError extends Error {
  constructor() {
    super("last_admin");
  }
}

/**
 * Throw LastAdminError when removing this user would leave the swarm without
 * an active grant-all user. Joins the caller's transaction.
 */
export async function assertNotLastAdmin(userId: string): Promise<void> {
  const client = getDbClient();
  const self = await client.get<{ n: number }>(
    `SELECT COUNT(*) AS n
     FROM users u
     JOIN principal_roles pr ON pr.principalType = 'user' AND pr.principalId = u.id
     JOIN roles r ON r.id = pr.roleId AND r.grantsAll = 1
     WHERE u.status = 'active' AND u.id = ?`,
    [userId],
  );
  if ((self?.n ?? 0) === 0) return;
  const others = await client.get<{ n: number }>(
    `SELECT COUNT(DISTINCT u.id) AS n
     FROM users u
     JOIN principal_roles pr ON pr.principalType = 'user' AND pr.principalId = u.id
     JOIN roles r ON r.id = pr.roleId AND r.grantsAll = 1
     WHERE u.status = 'active' AND u.id <> ?`,
    [userId],
  );
  if ((others?.n ?? 0) === 0) throw new LastAdminError();
}

/**
 * Replace a user's RBAC roles. The set holds exactly one primary role
 * (admin, requester or viewer) plus any extra roles. Refuses to leave the
 * swarm without an active grant-all user.
 */
export async function setUserRoles(
  userId: string,
  roleNames: string[],
  actorUserId: string | null,
): Promise<{ before: string[]; after: string[] }> {
  const names = [...new Set(roleNames)];
  if (names.filter((name) => PRIMARY_ROLE_NAMES.includes(name)).length !== 1) {
    throw new InvalidRoleSetError(
      `Pick exactly one primary role: ${PRIMARY_ROLE_NAMES.join(", ")}`,
    );
  }
  return getDbClient().transaction(async (tx) => {
    const wanted: GrantRoleRow[] = [];
    for (const name of names) {
      const row = await tx.get<GrantRoleRow>(
        "SELECT id, name, grantsAll FROM roles WHERE name = ?",
        [name],
      );
      if (!row) throw new InvalidRoleSetError(`Unknown role: ${name}`);
      wanted.push(row);
    }
    const current = await tx.query<GrantRoleRow>(
      `SELECT r.id, r.name, r.grantsAll
       FROM principal_roles pr JOIN roles r ON r.id = pr.roleId
       WHERE pr.principalType = 'user' AND pr.principalId = ?
       ORDER BY r.name`,
      [userId],
    );
    const wantsAll = wanted.some((r) => r.grantsAll === 1);
    if (current.some((r) => r.grantsAll === 1) && !wantsAll) {
      const user = await tx.get<{ status: string }>("SELECT status FROM users WHERE id = ?", [
        userId,
      ]);
      if (user?.status === "active") {
        const others = await tx.get<{ n: number }>(
          `SELECT COUNT(DISTINCT u.id) AS n
           FROM users u
           JOIN principal_roles pr ON pr.principalType = 'user' AND pr.principalId = u.id
           JOIN roles r ON r.id = pr.roleId AND r.grantsAll = 1
           WHERE u.status = 'active' AND u.id <> ?`,
          [userId],
        );
        if ((others?.n ?? 0) === 0) throw new LastAdminError();
      }
    }
    const wantedIds = new Set(wanted.map((r) => r.id));
    for (const row of current) {
      if (!wantedIds.has(row.id)) {
        await tx.run(
          `DELETE FROM principal_roles
           WHERE principalType = 'user' AND principalId = ? AND roleId = ?`,
          [userId, row.id],
        );
      }
    }
    for (const row of wanted) {
      await tx.run(
        `INSERT OR IGNORE INTO principal_roles (principalType, principalId, roleId, created_by)
         VALUES ('user', ?, ?, ?)`,
        [userId, row.id, actorUserId],
      );
    }
    getDbClient().afterCommit(() => invalidateTelemetryUserRole(userId));
    return { before: current.map((r) => r.name), after: wanted.map((r) => r.name).sort() };
  });
}

export function ensureRbacSeedsSynced(opts?: { quiet?: boolean }): RbacSeedSyncStats {
  const db = getDb();
  const desiredVerbsByRoleId = validatedBuiltinVerbSets();

  const insertRole = db.prepare<null, [string, string, string, number]>(
    `INSERT OR IGNORE INTO roles (id, name, description, isBuiltin, grantsAll)
     VALUES (?, ?, ?, 1, ?)`,
  );
  const updateRole = db.prepare<null, [string, string, number, string, string, string, number]>(
    `UPDATE roles
     SET name = ?, description = ?, isBuiltin = 1, grantsAll = ?, lastUpdatedAt = CURRENT_TIMESTAMP
     WHERE id = ?
       AND (
         name <> ?
         OR COALESCE(description, '') <> COALESCE(?, '')
         OR isBuiltin <> 1
         OR grantsAll <> ?
       )`,
  );
  const selectRoleById = db.prepare<RoleIdentityRow, string>(
    "SELECT id, name FROM roles WHERE id = ?",
  );
  const selectRoleByName = db.prepare<RoleIdentityRow, string>(
    "SELECT id, name FROM roles WHERE name = ?",
  );
  const selectRolePermissions = db.prepare<PermissionRow, string>(
    "SELECT verb FROM role_permissions WHERE roleId = ?",
  );
  const deleteRolePermission = db.prepare<null, [string, string]>(
    "DELETE FROM role_permissions WHERE roleId = ? AND verb = ?",
  );
  const insertRolePermission = db.prepare<null, [string, string]>(
    "INSERT OR IGNORE INTO role_permissions (roleId, verb) VALUES (?, ?)",
  );
  const backfillDefaultRoleForZeroRoleUsers = db.prepare<null, string>(
    `INSERT OR IGNORE INTO principal_roles (principalType, principalId, roleId)
     SELECT 'user', u.id, ?
     FROM users u
     WHERE NOT EXISTS (
       SELECT 1
       FROM principal_roles pr
       WHERE pr.principalType = 'user'
         AND pr.principalId = u.id
     )`,
  );

  const stats: RbacSeedSyncStats = {
    rolesInserted: 0,
    rolesUpdated: 0,
    permissionsInserted: 0,
    permissionsDeleted: 0,
    usersBackfilled: 0,
  };

  // BEGIN IMMEDIATE: take the write lock at BEGIN (see DbClient.transaction).
  db.transaction(() => {
    for (const role of BUILTIN_ROLES) {
      const grantsAll = role.grantsAll ? 1 : 0;
      const insertResult = insertRole.run(role.id, role.name, role.description, grantsAll);
      stats.rolesInserted += insertResult.changes;
      if (insertResult.changes === 0) {
        const updateResult = updateRole.run(
          role.name,
          role.description,
          grantsAll,
          role.id,
          role.name,
          role.description,
          grantsAll,
        );
        stats.rolesUpdated += updateResult.changes;
      }
    }

    for (const role of BUILTIN_ROLES) {
      const row = selectRoleById.get(role.id);
      if (row) {
        continue;
      }

      const colliding = selectRoleByName.get(role.name);
      if (colliding) {
        throw new Error(
          `RBAC built-in role "${role.name}" (${role.id}) is missing because role ` +
            `"${colliding.name}" (${colliding.id}) already uses that name. ` +
            "Rename or remove the conflicting role, then rerun `rbac bootstrap`.",
        );
      }

      throw new Error(
        `RBAC built-in role "${role.name}" (${role.id}) is missing after seed sync. ` +
          "Rerun `rbac bootstrap`; if it still fails, inspect the roles table.",
      );
    }

    for (const role of BUILTIN_ROLES) {
      const desiredVerbs = desiredVerbsByRoleId.get(role.id) ?? new Set<PermissionVerb>();
      const existingRows = selectRolePermissions.all(role.id);
      for (const row of existingRows) {
        if (!desiredVerbs.has(row.verb as PermissionVerb)) {
          stats.permissionsDeleted += deleteRolePermission.run(role.id, row.verb).changes;
        }
      }
      for (const verb of desiredVerbs) {
        stats.permissionsInserted += insertRolePermission.run(role.id, verb).changes;
      }
    }

    db.run(CREATE_USER_DEFAULT_ROLE_TRIGGER_SQL);

    // DES-445 pre-GA heal: zero user roles is never intentional today; users
    // are deactivated, not stripped. When RBAC reaches GA with real role
    // management, zero roles becomes a deliberate deny-all posture and this
    // auto-attach MUST be removed. Keep the CLI as the explicit operator tool.
    stats.usersBackfilled += backfillDefaultRoleForZeroRoleUsers.run(DEFAULT_ROLE_ID).changes;
  }).immediate();

  if (!opts?.quiet) {
    console.log(
      `[rbac] seed sync: roles inserted=${stats.rolesInserted}, updated=${stats.rolesUpdated}; permissions inserted=${stats.permissionsInserted}, deleted=${stats.permissionsDeleted}; trigger=ensured; users backfilled=${stats.usersBackfilled}`,
    );
  }

  return stats;
}

function describeRbacFlag(): string {
  const raw = process.env.RBAC_ENABLED;
  if (raw === undefined) return "unset (on)";
  return `${raw} (${isEnvFlagEnabled("RBAC_ENABLED", true) ? "on" : "off"})`;
}

function printRolesTable(rows: RbacRoleSummaryRow[]): void {
  const tableRows = rows.map((row) => [
    row.name,
    row.isBuiltin === 1 ? "yes" : "no",
    row.grantsAll === 1 ? "yes" : "no",
    String(row.verbCount),
    String(row.attachedUserCount),
  ]);
  const headers = ["name", "builtin", "grantsAll", "verbs", "attachedUsers"];
  const widths = headers.map((header, column) =>
    Math.max(header.length, ...tableRows.map((row) => row[column]?.length ?? 0)),
  );
  const format = (row: string[]) =>
    row.map((cell, column) => cell.padEnd(widths[column] ?? cell.length)).join("  ");

  console.log("Roles:");
  console.log(format(headers));
  console.log(format(widths.map((width) => "-".repeat(width))));
  for (const row of tableRows) {
    console.log(format(row));
  }
}

async function getRbacRoleSummary(): Promise<RbacRoleSummaryRow[]> {
  return getDbClient().query<RbacRoleSummaryRow>(
    `SELECT
       r.name,
       r.isBuiltin,
       r.grantsAll,
       COUNT(DISTINCT rp.verb) AS verbCount,
       COUNT(DISTINCT CASE WHEN pr.principalType = 'user' THEN pr.principalId END)
         AS attachedUserCount
     FROM roles r
     LEFT JOIN role_permissions rp ON rp.roleId = r.id
     LEFT JOIN principal_roles pr ON pr.roleId = r.id
     GROUP BY r.id, r.name, r.isBuiltin, r.grantsAll
     ORDER BY r.isBuiltin DESC, r.name`,
  );
}

export async function runRbacCliCommand(args: string[]): Promise<void> {
  const subcommand = args[0];
  if (args.length !== 1 || subcommand !== "bootstrap") {
    throw new Error(`Unknown RBAC command: ${args.join(" ") || "(none)"}`);
  }

  const stats = ensureRbacSeedsSynced({ quiet: true });
  const roles = await getRbacRoleSummary();

  console.log("RBAC bootstrap complete");
  console.log(`RBAC_ENABLED: ${describeRbacFlag()}`);
  console.log(`Users backfilled this run: ${stats.usersBackfilled}`);
  console.log("");
  printRolesTable(roles);
}
