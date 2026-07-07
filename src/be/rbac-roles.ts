import type { PermissionVerb } from "../rbac";
import { PermissionVerbSchema } from "../rbac";
import { getDb } from "./db";

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
    verbs: ["task.read.own", "task.cancel.own", "task.action.own", "task.fs.mutate"],
  },
] satisfies (BuiltinRoleDefinition & { isBuiltin: true })[];

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
  VALUES ('user', NEW.id, 'rbac-role-admin');
END;
`;

type GrantRow = {
  grantsAll: number;
  verb: string | null;
};

type RoleIdRow = {
  id: string;
};

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

function requireRoleId(roleName: string): string {
  const row = getDb()
    .prepare<RoleIdRow, string>("SELECT id FROM roles WHERE name = ?")
    .get(roleName);
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

export function getUserGrant(userId: string): EffectiveGrant {
  const rows = getDb()
    .prepare<GrantRow, string>(
      `SELECT r.grantsAll, rp.verb
       FROM principal_roles pr
       JOIN roles r ON r.id = pr.roleId
       LEFT JOIN role_permissions rp ON rp.roleId = r.id
       WHERE pr.principalType = 'user' AND pr.principalId = ?
       ORDER BY r.grantsAll DESC`,
    )
    .all(userId);

  if (rows.length === 0) {
    return { grantsAll: false, verbs: new Set() };
  }

  const verbs = new Set<PermissionVerb>();
  for (const row of rows) {
    if (row.grantsAll === 1) {
      return { grantsAll: true, verbs: new Set() };
    }
    if (row.verb) {
      verbs.add(validateBuiltinVerb("database grant", row.verb));
    }
  }

  return { grantsAll: false, verbs };
}

export function attachRole(userId: string, roleName: string): void {
  const db = getDb();
  db.transaction(() => {
    const roleId = requireRoleId(roleName);
    db.prepare(
      `INSERT OR IGNORE INTO principal_roles (principalType, principalId, roleId)
       VALUES ('user', ?, ?)`,
    ).run(userId, roleId);
  })();
}

export function detachRole(userId: string, roleName: string): void {
  const db = getDb();
  db.transaction(() => {
    const roleId = requireRoleId(roleName);
    db.prepare(
      `DELETE FROM principal_roles
       WHERE principalType = 'user' AND principalId = ? AND roleId = ?`,
    ).run(userId, roleId);
  })();
}

export function listUserRoles(userId: string): UserRole[] {
  return getDb()
    .prepare<UserRoleRow, string>(
      `SELECT r.id, r.name, r.description, r.isBuiltin, r.grantsAll, r.createdAt
       FROM principal_roles pr
       JOIN roles r ON r.id = pr.roleId
       WHERE pr.principalType = 'user' AND pr.principalId = ?
       ORDER BY r.name`,
    )
    .all(userId)
    .map(roleRowToUserRole);
}

export function ensureRbacSeedsSynced(opts?: { quiet?: boolean }): void {
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
  const selectRolePermissions = db.prepare<PermissionRow, string>(
    "SELECT verb FROM role_permissions WHERE roleId = ?",
  );
  const deleteRolePermission = db.prepare<null, [string, string]>(
    "DELETE FROM role_permissions WHERE roleId = ? AND verb = ?",
  );
  const insertRolePermission = db.prepare<null, [string, string]>(
    "INSERT OR IGNORE INTO role_permissions (roleId, verb) VALUES (?, ?)",
  );

  const stats = {
    rolesInserted: 0,
    rolesUpdated: 0,
    permissionsInserted: 0,
    permissionsDeleted: 0,
  };

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
  })();

  if (!opts?.quiet) {
    console.log(
      `[rbac] seed sync: roles inserted=${stats.rolesInserted}, updated=${stats.rolesUpdated}; permissions inserted=${stats.permissionsInserted}, deleted=${stats.permissionsDeleted}; trigger=ensured`,
    );
  }
}
