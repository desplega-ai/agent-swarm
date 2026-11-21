import type { RoleGrantRow, RoleRow, RoleSummaryRow } from "@desplega/storage";
import type { PermissionVerb } from "../rbac";
import { PermissionVerbSchema } from "../rbac";
import { invalidateTelemetryUserRole } from "../telemetry-identity";
import { isEnvFlagEnabled } from "../utils/env-flag";
import { getStorage } from "./storage";
import { findUserById, isLiveUserToken, revokeAllUserCredentials } from "./users";

const rbacRepo = () => getStorage().repos.rbac;

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
      "checklist.write.own",
      "session.share",
      "session.presence",
      "task.steer.own",
      "comb.presence",
      "fs.join.own",
      "objects.read",
      "objects.write",
      "page.launch",
    ],
  },
  {
    id: "rbac-role-viewer",
    name: "viewer",
    description: "Read-only: no task, approval or script writes.",
    isBuiltin: true,
    grantsAll: false,
    verbs: [
      "checklist.write.own",
      "favorite.write.own",
      "session.presence",
      "comb.presence",
      "fs.join.own",
      "objects.read",
      "page.launch",
    ],
  },
  {
    // An extra role, never a primary one and never assigned by default. It is
    // the supported way to grant `session.read.all`, which `grantsAll` does
    // not imply (see `userHoldsExplicitVerb`).
    id: "rbac-role-auditor",
    name: "auditor",
    description: "Extra role: opt in to every user's tasks and sessions, read-only.",
    isBuiltin: true,
    grantsAll: false,
    verbs: ["session.read.all"],
  },
] satisfies (BuiltinRoleDefinition & { isBuiltin: true })[];

/**
 * Verbs only the operator key may grant. Every new user is a grant-all admin,
 * so letting a grant-all user add a role with one of these would let any user
 * grant it to itself.
 */
export const OPERATOR_GRANTED_VERBS: readonly PermissionVerb[] = ["session.read.all"];

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

type UserRoleRow = RoleRow;

type RbacRoleSummaryRow = RoleSummaryRow;

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
  const row = await rbacRepo().findRoleByName(roleName);
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

/**
 * Whether one of the user's roles lists `verb` in `role_permissions`. Unlike
 * `getUserGrant`, a grant-all role does not count: it holds no rows, and
 * every new user gets one (`trg_users_default_role`). Use it for a verb that
 * must be granted on purpose.
 */
export async function userHoldsExplicitVerb(
  userId: string,
  verb: PermissionVerb,
): Promise<boolean> {
  return rbacRepo().userHoldsAnyVerb(userId, [verb]);
}

/**
 * Whether one of the user's roles lists an operator-granted verb. Minting a
 * credential for such a user, or binding another identity to it, hands the
 * caller that verb, so only the operator key may do it.
 */
export async function userHoldsOperatorGrantedRole(userId: string): Promise<boolean> {
  return rbacRepo().userHoldsAnyVerb(userId, OPERATOR_GRANTED_VERBS);
}

/** A caller tried to credential, or bind an identity to, a user holding an operator-granted role. */
export class OperatorGrantedTargetError extends Error {
  constructor() {
    super(
      "This user holds an operator-granted role (auditor); this change requires the operator key",
    );
  }
}

/**
 * Who asks for a credential or identity write on a user. `agent` is an agent
 * caller (the Lead's `manage-user` tool), keyed on the agent rather than the
 * operator actor it records in the audit log.
 */
export type CredentialCaller = {
  kind: "operator" | "user" | "system" | "agent";
  id: string;
  /** For a user caller: the `user_tokens` row the request authenticated with. */
  tokenId?: string;
};

/**
 * Throws OperatorGrantedTargetError when `caller` would get a credential for,
 * or bind an identity to, another user holding an operator-granted role.
 * The operator key passes. The user itself passes only with a token that is
 * still live: the grant revokes every token issued before it, and a request
 * authenticated with one of them may still be in flight. A page session
 * (no `tokenId`) cannot be revoked, so it does not pass. `system` callers
 * (integration webhooks attributing their own events by email or external
 * id) pass too: they hand no credential to a caller.
 *
 * Call it inside the write transaction that issues the credential or binds
 * the identity. Adding an operator-granted role takes the same write lock
 * (`setUserRoles`), so a grant cannot land between this check and the write.
 */
export async function assertMayActOnOperatorGrantedTarget(
  caller: CredentialCaller,
  targetUserId: string,
): Promise<void> {
  if (caller.kind === "operator" || caller.kind === "system") return;
  if (!getStorage().inTransaction()) {
    throw new Error("assertMayActOnOperatorGrantedTarget must run inside the write transaction");
  }
  if (!(await userHoldsOperatorGrantedRole(targetUserId))) return;
  const self = caller.kind === "user" && caller.id === targetUserId;
  if (self && caller.tokenId && (await isLiveUserToken(caller.tokenId, caller.id))) return;
  throw new OperatorGrantedTargetError();
}

export async function getUserGrant(userId: string): Promise<EffectiveGrant> {
  const rows = await rbacRepo().listUserGrantRows(userId);

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
  await getStorage().transaction(async () => {
    const roleId = await requireRoleId(roleName);
    await rbacRepo().attachUserRole(userId, roleId, null);
  });
}

export async function detachRole(userId: string, roleName: string): Promise<void> {
  await getStorage().transaction(async () => {
    const roleId = await requireRoleId(roleName);
    await rbacRepo().detachUserRole(userId, roleId);
  });
}

export async function listUserRoles(userId: string): Promise<UserRole[]> {
  const rows = await rbacRepo().listUserRoles(userId);
  return rows.map(roleRowToUserRole);
}

export type RbacRoleCatalogEntry = UserRole & { primary: boolean; verbs: string[] };

/** Every role with its verbs, for the role picker. */
export async function listRbacRoles(): Promise<RbacRoleCatalogEntry[]> {
  const roles = await rbacRepo().listRoles();
  const perms = await rbacRepo().listRolePermissions();
  return roles.map((row) => ({
    ...roleRowToUserRole(row),
    primary: PRIMARY_ROLE_NAMES.includes(row.name),
    verbs: perms.filter((p) => p.roleId === row.id).map((p) => p.verb),
  }));
}

export class InvalidRoleSetError extends Error {}

/** A user actor tried to add a role that lists an operator-granted verb. */
export class OperatorGrantedRoleError extends Error {
  constructor(readonly roles: string[]) {
    super(`Adding ${roles.join(", ")} requires the operator key`);
  }
}

export class LastAdminError extends Error {
  constructor() {
    super("last_admin");
  }
}

/**
 * Throw LastAdminError when removing this user would leave the swarm without
 * an active grant-all user. A merge source (users.mergedIntoUserId set) can no
 * longer authenticate and is about to be deleted, so it never counts as a
 * live admin. Joins the caller's transaction.
 */
export async function assertNotLastAdmin(userId: string): Promise<void> {
  if (!(await rbacRepo().isActiveGrantAllUser(userId))) return;
  if ((await rbacRepo().countOtherActiveGrantAllUsers(userId)) === 0) throw new LastAdminError();
}

/**
 * Replace a user's RBAC roles. The set holds exactly one primary role
 * (admin, requester or viewer) plus any extra roles. Refuses to leave the
 * swarm without an active grant-all user. `actorUserId` is the acting user,
 * or null for the operator key: a user actor gets OperatorGrantedRoleError
 * when the set adds a role with an operator-granted verb.
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
  const storage = getStorage();
  return storage.transaction(async () => {
    const wanted: RoleGrantRow[] = [];
    for (const name of names) {
      const row = await rbacRepo().findRoleByName(name);
      if (!row) throw new InvalidRoleSetError(`Unknown role: ${name}`);
      wanted.push(row);
    }
    const current: RoleGrantRow[] = (await rbacRepo().listUserRoles(userId)).map((r) => ({
      id: r.id,
      name: r.name,
      grantsAll: r.grantsAll,
    }));
    // A user actor may keep or drop a role with an operator-granted verb but
    // never add one. Checked against `current` inside this transaction, so a
    // concurrent revoke cannot slip between the check and the write.
    const heldIds = new Set(current.map((r) => r.id));
    const added = wanted.filter((r) => !heldIds.has(r.id));
    const gated =
      added.length === 0
        ? []
        : await rbacRepo().listRoleNamesWithVerbs(
            added.map((r) => r.id),
            OPERATOR_GRANTED_VERBS,
          );
    if (actorUserId !== null && gated.length > 0) {
      throw new OperatorGrantedRoleError(gated);
    }
    const wantsAll = wanted.some((r) => r.grantsAll === 1);
    if (current.some((r) => r.grantsAll === 1) && !wantsAll) {
      const user = await findUserById(userId);
      if (user?.status === "active") {
        const others = await rbacRepo().countOtherActiveGrantAllUsers(userId);
        if (others === 0) throw new LastAdminError();
      }
    }
    const wantedIds = new Set(wanted.map((r) => r.id));
    for (const row of current) {
      if (!wantedIds.has(row.id)) {
        await rbacRepo().detachUserRole(userId, row.id);
      }
    }
    for (const row of wanted) {
      await rbacRepo().attachUserRole(userId, row.id, actorUserId);
    }
    // Any credential issued before the grant may sit with someone other than
    // the user (an admin could mint a token or code for any user), so adding
    // an operator-granted role revokes them all in this transaction. The user
    // or the operator issues fresh ones; other users are refused from now on.
    if (gated.length > 0) {
      await revokeAllUserCredentials(userId, { kind: "system", id: "operator-granted-role" });
    }
    storage.afterCommit(() => invalidateTelemetryUserRole(userId));
    return { before: current.map((r) => r.name), after: wanted.map((r) => r.name).sort() };
  });
}

export async function ensureRbacSeedsSynced(opts?: {
  quiet?: boolean;
}): Promise<RbacSeedSyncStats> {
  const desiredVerbsByRoleId = validatedBuiltinVerbSets();
  const storage = getStorage();
  const rbac = storage.repos.rbac;

  const stats = await storage.transaction(async (): Promise<RbacSeedSyncStats> => {
    const stats: RbacSeedSyncStats = {
      rolesInserted: 0,
      rolesUpdated: 0,
      permissionsInserted: 0,
      permissionsDeleted: 0,
      usersBackfilled: 0,
    };
    for (const role of BUILTIN_ROLES) {
      const seed = {
        id: role.id,
        name: role.name,
        description: role.description,
        grantsAll: Boolean(role.grantsAll),
      };
      const inserted = await rbac.insertBuiltinRole(seed);
      stats.rolesInserted += inserted;
      if (inserted === 0) stats.rolesUpdated += await rbac.updateBuiltinRole(seed);
    }

    for (const role of BUILTIN_ROLES) {
      const row = await rbac.findRoleIdentity({ id: role.id });
      if (row) {
        continue;
      }

      const colliding = await rbac.findRoleIdentity({ name: role.name });
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
      for (const verb of await rbac.listRoleVerbs(role.id)) {
        if (!desiredVerbs.has(verb as PermissionVerb)) {
          stats.permissionsDeleted += await rbac.deleteRolePermission(role.id, verb);
        }
      }
      for (const verb of desiredVerbs) {
        stats.permissionsInserted += await rbac.insertRolePermission(role.id, verb);
      }
    }

    await rbac.ensureDefaultRoleTrigger();

    // DES-445 pre-GA heal: zero user roles is never intentional today; users
    // are deactivated, not stripped. When RBAC reaches GA with real role
    // management, zero roles becomes a deliberate deny-all posture and this
    // auto-attach MUST be removed. Keep the CLI as the explicit operator tool.
    stats.usersBackfilled += await rbac.attachRoleToRolelessUsers(DEFAULT_ROLE_ID);
    return stats;
  });

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
  return rbacRepo().listRoleSummaries();
}

export async function runRbacCliCommand(args: string[]): Promise<void> {
  const subcommand = args[0];
  if (args.length !== 1 || subcommand !== "bootstrap") {
    throw new Error(`Unknown RBAC command: ${args.join(" ") || "(none)"}`);
  }

  const stats = await ensureRbacSeedsSynced({ quiet: true });
  const roles = await getRbacRoleSummary();

  console.log("RBAC bootstrap complete");
  console.log(`RBAC_ENABLED: ${describeRbacFlag()}`);
  console.log(`Users backfilled this run: ${stats.usersBackfilled}`);
  console.log("");
  printRolesTable(roles);
}
