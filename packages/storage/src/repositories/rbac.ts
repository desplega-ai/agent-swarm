import { nowText } from "../dialect";
import type { SqlExecutor } from "../executor";
import { sql, sqlList } from "../sql";

/**
 * Domain: RBAC (`roles`, `role_permissions`, `principal_roles`,
 * `permission_audit`). Rows come back in the SQLite value shape on every
 * engine (flags 0/1, timestamps as the text the column stores).
 */

export type RoleRow = {
  id: string;
  name: string;
  description: string | null;
  isBuiltin: number;
  grantsAll: number;
  createdAt: string;
};

export type RoleGrantRow = { id: string; name: string; grantsAll: number };

export type UserGrantRow = { roleId: string; grantsAll: number; verb: string | null };

export type RoleSummaryRow = {
  name: string;
  isBuiltin: number;
  grantsAll: number;
  verbCount: number;
  attachedUserCount: number;
};

export type PermissionAuditInsert = {
  principalType: "agent" | "user" | "operator" | "guest";
  principalId: string | null;
  originatorUserId: string | null;
  verb: string;
  resourceType: string | null;
  resourceId: string | null;
  decision: "allow" | "deny";
  reason: string | null;
  source: "mcp" | "http";
};

export type BuiltinRoleSeed = {
  id: string;
  name: string;
  description: string;
  grantsAll: boolean;
};

export interface RbacRepository {
  findRoleByName(name: string): Promise<RoleGrantRow | null>;
  /** True when one of the user's roles lists one of `verbs` in `role_permissions`. */
  userHoldsAnyVerb(userId: string, verbs: readonly string[]): Promise<boolean>;
  /**
   * One row per (role, verb) of the user's roles; a role without verbs gives
   * one row with a NULL verb. Grant-all roles first, otherwise in no stated
   * order (callers treat it as a set).
   */
  listUserGrantRows(userId: string): Promise<UserGrantRow[]>;
  /** The user's roles, by name (unique). */
  listUserRoles(userId: string): Promise<RoleRow[]>;
  /** Every role, by name (unique). */
  listRoles(): Promise<RoleRow[]>;
  /** Every role permission, by verb then role id (the primary key). */
  listRolePermissions(): Promise<{ roleId: string; verb: string }[]>;
  /** Attaches the role; a role the user already holds is left as it is. */
  attachUserRole(userId: string, roleId: string, createdBy: string | null): Promise<void>;
  detachUserRole(userId: string, roleId: string): Promise<void>;
  /**
   * Distinct names of the roles among `roleIds` that list one of `verbs`, by
   * name (unique).
   */
  listRoleNamesWithVerbs(roleIds: string[], verbs: readonly string[]): Promise<string[]>;
  /** True when the user is active, not a merge source, and holds a grant-all role. */
  isActiveGrantAllUser(userId: string): Promise<boolean>;
  /** Active, non-merge-source users other than `userId` that hold a grant-all role. */
  countOtherActiveGrantAllUsers(userId: string): Promise<number>;
  /** Per-role verb and attached-user counts. Built-in roles first, then by name. */
  listRoleSummaries(): Promise<RoleSummaryRow[]>;

  // ---- permission_audit ----
  insertPermissionAudit(row: PermissionAuditInsert): Promise<void>;
  /** Deletes audit rows older than `days` days. Returns the deleted row count. */
  purgeAuditOlderThanDays(days: number): Promise<number>;

  // ---- built-in role seed sync (start and `rbac bootstrap`) ----
  /** Insert a built-in role unless its id or name exists. Returns rows inserted. */
  insertBuiltinRole(role: BuiltinRoleSeed): Promise<number>;
  /** Rewrite a built-in role when any seeded field differs. Returns rows updated. */
  updateBuiltinRole(role: BuiltinRoleSeed): Promise<number>;
  findRoleIdentity(
    by: { id: string } | { name: string },
  ): Promise<{ id: string; name: string } | null>;
  /** Verbs of a role, in byte order. */
  listRoleVerbs(roleId: string): Promise<string[]>;
  deleteRolePermission(roleId: string, verb: string): Promise<number>;
  /** Insert unless present. Returns rows inserted. */
  insertRolePermission(roleId: string, verb: string): Promise<number>;
  /**
   * Make sure the trigger that gives each new user the admin role exists.
   * SQLite creates it at start; the Postgres baseline already has it.
   */
  ensureDefaultRoleTrigger(): Promise<void>;
  /** Attach `roleId` to every user that holds no role. Returns rows inserted. */
  attachRoleToRolelessUsers(roleId: string): Promise<number>;
}

export abstract class BaseRbacRepository implements RbacRepository {
  constructor(protected readonly db: SqlExecutor) {}

  findRoleByName(name: string): Promise<RoleGrantRow | null> {
    return this.db.get<RoleGrantRow>(
      sql`SELECT id, name, "grantsAll" FROM roles WHERE name = ${name}`,
    );
  }

  async userHoldsAnyVerb(userId: string, verbs: readonly string[]): Promise<boolean> {
    if (verbs.length === 0) return false;
    const row = await this.db.get(sql`
      SELECT 1 AS found
      FROM principal_roles pr
      JOIN role_permissions rp ON rp."roleId" = pr."roleId"
      WHERE pr."principalType" = 'user' AND pr."principalId" = ${userId}
        AND rp.verb IN (${sqlList(verbs)})
      LIMIT 1`);
    return row != null;
  }

  listUserGrantRows(userId: string): Promise<UserGrantRow[]> {
    return this.db.query<UserGrantRow>(sql`
      SELECT r.id AS "roleId", r."grantsAll", rp.verb
      FROM principal_roles pr
      JOIN roles r ON r.id = pr."roleId"
      LEFT JOIN role_permissions rp ON rp."roleId" = r.id
      WHERE pr."principalType" = 'user' AND pr."principalId" = ${userId}
      ORDER BY r."grantsAll" DESC`);
  }

  listUserRoles(userId: string): Promise<RoleRow[]> {
    return this.db.query<RoleRow>(sql`
      SELECT r.id, r.name, r.description, r."isBuiltin", r."grantsAll", r."createdAt"
      FROM principal_roles pr
      JOIN roles r ON r.id = pr."roleId"
      WHERE pr."principalType" = 'user' AND pr."principalId" = ${userId}
      ORDER BY r.name`);
  }

  listRoles(): Promise<RoleRow[]> {
    return this.db.query<RoleRow>(
      sql`SELECT id, name, description, "isBuiltin", "grantsAll", "createdAt" FROM roles ORDER BY name`,
    );
  }

  listRolePermissions(): Promise<{ roleId: string; verb: string }[]> {
    return this.db.query(sql`SELECT "roleId", verb FROM role_permissions ORDER BY verb, "roleId"`);
  }

  async attachUserRole(userId: string, roleId: string, createdBy: string | null): Promise<void> {
    await this.db.run(sql`
      INSERT INTO principal_roles ("principalType", "principalId", "roleId", created_by)
      VALUES ('user', ${userId}, ${roleId}, ${createdBy})
      ON CONFLICT DO NOTHING`);
  }

  async detachUserRole(userId: string, roleId: string): Promise<void> {
    await this.db.run(sql`
      DELETE FROM principal_roles
      WHERE "principalType" = 'user' AND "principalId" = ${userId} AND "roleId" = ${roleId}`);
  }

  async listRoleNamesWithVerbs(roleIds: string[], verbs: readonly string[]): Promise<string[]> {
    if (roleIds.length === 0 || verbs.length === 0) return [];
    const rows = await this.db.query<{ name: string }>(sql`
      SELECT DISTINCT r.name
      FROM roles r JOIN role_permissions rp ON rp."roleId" = r.id
      WHERE r.id IN (${sqlList(roleIds)})
        AND rp.verb IN (${sqlList(verbs)})
      ORDER BY r.name`);
    return rows.map((row) => row.name);
  }

  async isActiveGrantAllUser(userId: string): Promise<boolean> {
    const row = await this.db.get(sql`
      SELECT 1 AS found
      FROM users u
      JOIN principal_roles pr ON pr."principalType" = 'user' AND pr."principalId" = u.id
      JOIN roles r ON r.id = pr."roleId" AND r."grantsAll" = ${true}
      WHERE u.status = 'active' AND u."mergedIntoUserId" IS NULL AND u.id = ${userId}
      LIMIT 1`);
    return row != null;
  }

  async countOtherActiveGrantAllUsers(userId: string): Promise<number> {
    const row = await this.db.get<{ n: number | string }>(sql`
      SELECT COUNT(DISTINCT u.id) AS n
      FROM users u
      JOIN principal_roles pr ON pr."principalType" = 'user' AND pr."principalId" = u.id
      JOIN roles r ON r.id = pr."roleId" AND r."grantsAll" = ${true}
      WHERE u.status = 'active' AND u."mergedIntoUserId" IS NULL AND u.id <> ${userId}`);
    return Number(row?.n ?? 0);
  }

  async listRoleSummaries(): Promise<RoleSummaryRow[]> {
    const rows = await this.db.query<RoleSummaryRow>(sql`
      SELECT
        r.name,
        r."isBuiltin",
        r."grantsAll",
        COUNT(DISTINCT rp.verb) AS "verbCount",
        COUNT(DISTINCT CASE WHEN pr."principalType" = 'user' THEN pr."principalId" END)
          AS "attachedUserCount"
      FROM roles r
      LEFT JOIN role_permissions rp ON rp."roleId" = r.id
      LEFT JOIN principal_roles pr ON pr."roleId" = r.id
      GROUP BY r.id, r.name, r."isBuiltin", r."grantsAll"
      ORDER BY r."isBuiltin" DESC, r.name`);
    return rows.map((row) => ({
      ...row,
      verbCount: Number(row.verbCount),
      attachedUserCount: Number(row.attachedUserCount),
    }));
  }

  // ---- permission_audit ----

  async insertPermissionAudit(r: PermissionAuditInsert): Promise<void> {
    await this.db.run(sql`
      INSERT INTO permission_audit
        ("principalType", "principalId", "originatorUserId", verb, "resourceType", "resourceId", decision, reason, source)
      VALUES (${r.principalType}, ${r.principalId}, ${r.originatorUserId}, ${r.verb}, ${r.resourceType}, ${r.resourceId}, ${r.decision}, ${r.reason}, ${r.source})`);
  }

  /** `ts` holds `YYYY-MM-DD HH:MM:SS` text; the cutoff arithmetic differs per engine. */
  abstract purgeAuditOlderThanDays(days: number): Promise<number>;

  // ---- built-in role seed sync ----

  async insertBuiltinRole(r: BuiltinRoleSeed): Promise<number> {
    const result = await this.db.run(sql`
      INSERT INTO roles (id, name, description, "isBuiltin", "grantsAll")
      VALUES (${r.id}, ${r.name}, ${r.description}, ${true}, ${r.grantsAll})
      ON CONFLICT DO NOTHING`);
    return result.changes;
  }

  async updateBuiltinRole(r: BuiltinRoleSeed): Promise<number> {
    const result = await this.db.run(sql`
      UPDATE roles
      SET name = ${r.name}, description = ${r.description}, "isBuiltin" = ${true},
          "grantsAll" = ${r.grantsAll}, "lastUpdatedAt" = ${nowText}
      WHERE id = ${r.id}
        AND (
          name <> ${r.name}
          OR COALESCE(description, '') <> COALESCE(${r.description}, '')
          OR "isBuiltin" <> ${true}
          OR "grantsAll" <> ${r.grantsAll}
        )`);
    return result.changes;
  }

  findRoleIdentity(
    by: { id: string } | { name: string },
  ): Promise<{ id: string; name: string } | null> {
    return "id" in by
      ? this.db.get(sql`SELECT id, name FROM roles WHERE id = ${by.id}`)
      : this.db.get(sql`SELECT id, name FROM roles WHERE name = ${by.name}`);
  }

  async listRoleVerbs(roleId: string): Promise<string[]> {
    const rows = await this.db.query<{ verb: string }>(
      sql`SELECT verb FROM role_permissions WHERE "roleId" = ${roleId} ORDER BY verb`,
    );
    return rows.map((row) => row.verb);
  }

  async deleteRolePermission(roleId: string, verb: string): Promise<number> {
    return (
      await this.db.run(
        sql`DELETE FROM role_permissions WHERE "roleId" = ${roleId} AND verb = ${verb}`,
      )
    ).changes;
  }

  async insertRolePermission(roleId: string, verb: string): Promise<number> {
    return (
      await this.db.run(
        sql`INSERT INTO role_permissions ("roleId", verb) VALUES (${roleId}, ${verb}) ON CONFLICT DO NOTHING`,
      )
    ).changes;
  }

  abstract ensureDefaultRoleTrigger(): Promise<void>;

  async attachRoleToRolelessUsers(roleId: string): Promise<number> {
    const result = await this.db.run(sql`
      INSERT INTO principal_roles ("principalType", "principalId", "roleId")
      SELECT 'user', u.id, ${roleId}
      FROM users u
      WHERE NOT EXISTS (
        SELECT 1 FROM principal_roles pr
        WHERE pr."principalType" = 'user' AND pr."principalId" = u.id
      )
      ON CONFLICT DO NOTHING`);
    return result.changes;
  }
}
