import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { closeDb, createUser, getDbClient, initDb } from "../be/db";
import {
  attachRole,
  BUILTIN_ROLES,
  DEFAULT_ROLE_ID,
  detachRole,
  ensureRbacSeedsSynced,
  getUserGrant,
  listUserRoles,
  runRbacCliCommand,
} from "../be/rbac-roles";
import type { PermissionVerb } from "../rbac";

const TEST_DB_PATH = "./test-rbac-roles.sqlite";
const REQUESTER_ROLE_ID = "rbac-role-requester";
const REQUESTER_VERBS = [
  "favorite.write.own",
  "task.action.own",
  "task.cancel.own",
  "task.create.own",
  "task.fs.mutate",
  "task.read.own",
] satisfies PermissionVerb[];

async function removeDbFiles() {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      await unlink(TEST_DB_PATH + suffix);
    } catch {
      // File does not exist.
    }
  }
}

function resetDb() {
  closeDb();
  initDb(TEST_DB_PATH);
  ensureRbacSeedsSynced({ quiet: true });
}

function sortedVerbs(verbs: ReadonlySet<PermissionVerb>): PermissionVerb[] {
  return [...verbs].sort();
}

async function roleNames(userId: string): Promise<string[]> {
  return (await listUserRoles(userId)).map((role) => role.name);
}

async function roleVerbs(roleId: string): Promise<string[]> {
  const rows = await getDbClient().query<{ verb: string }>(
    "SELECT verb FROM role_permissions WHERE roleId = ? ORDER BY verb",
    [roleId],
  );
  return rows.map((row) => row.verb);
}

async function insertCustomRole(
  roleId: string,
  name: string,
  verbs: PermissionVerb[],
): Promise<void> {
  await getDbClient().transaction(async (tx) => {
    await tx.run(
      "INSERT INTO roles (id, name, description, isBuiltin, grantsAll) VALUES (?, ?, ?, 0, 0)",
      [roleId, name, "Test custom role"],
    );
    for (const verb of verbs) {
      await tx.run("INSERT INTO role_permissions (roleId, verb) VALUES (?, ?)", [roleId, verb]);
    }
  });
}

beforeEach(async () => {
  await removeDbFiles();
  resetDb();
});

afterEach(() => {
  closeDb();
});

afterAll(async () => {
  closeDb();
  await removeDbFiles();
});

describe("getUserGrant", () => {
  test("unions verbs from all non-wildcard user roles", async () => {
    const user = await createUser({ name: "Union User" });
    await detachRole(user.id, "admin");
    await insertCustomRole("custom-role-reviewer", "reviewer", ["user.manage"]);

    await attachRole(user.id, "requester");
    await attachRole(user.id, "reviewer");

    const grant = await getUserGrant(user.id);
    expect(grant.grantsAll).toBe(false);
    expect(sortedVerbs(grant.verbs)).toEqual([...REQUESTER_VERBS, "user.manage"].sort());
  });

  test("short-circuits to grantsAll when any attached role is a wildcard", async () => {
    const user = await createUser({ name: "Wildcard User" });
    await attachRole(user.id, "requester");

    const grant = await getUserGrant(user.id);
    expect(grant.grantsAll).toBe(true);
    expect(grant.verbs.size).toBe(0);
  });

  test("returns an empty fail-closed grant for a user with no roles", async () => {
    const user = await createUser({ name: "Detached User" });
    await detachRole(user.id, "admin");

    const grant = await getUserGrant(user.id);
    expect(grant.grantsAll).toBe(false);
    expect(grant.verbs.size).toBe(0);
  });

  test("returns an empty fail-closed grant for an unknown user", async () => {
    const grant = await getUserGrant("missing-user");

    expect(grant.grantsAll).toBe(false);
    expect(grant.verbs.size).toBe(0);
  });

  test("skips invalid database grant verbs fail-closed without throwing", async () => {
    const user = await createUser({ name: "Malformed Grant User" });
    await detachRole(user.id, "admin");
    await getDbClient().transaction(async (tx) => {
      await tx.run(
        "INSERT INTO roles (id, name, description, isBuiltin, grantsAll) VALUES (?, ?, ?, 0, 0)",
        ["custom-role-malformed-grant", "malformed-grant", "Test malformed grant role"],
      );
      await tx.run("INSERT INTO role_permissions (roleId, verb) VALUES (?, ?)", [
        "custom-role-malformed-grant",
        "task.read.own",
      ]);
      await tx.run("INSERT INTO role_permissions (roleId, verb) VALUES (?, ?)", [
        "custom-role-malformed-grant",
        "invalid.permission",
      ]);
      await tx.run(
        `INSERT INTO principal_roles (principalType, principalId, roleId)
         VALUES ('user', ?, ?)`,
        [user.id, "custom-role-malformed-grant"],
      );
    });
    const errSpy = spyOn(console, "error").mockImplementation(() => {});

    try {
      const grant = await getUserGrant(user.id);

      expect(grant.grantsAll).toBe(false);
      expect(sortedVerbs(grant.verbs)).toEqual(["task.read.own"]);
      expect(errSpy).toHaveBeenCalledWith(
        expect.stringContaining(
          'Ignoring invalid role_permissions verb "invalid.permission" for roleId="custom-role-malformed-grant"',
        ),
      );
    } finally {
      errSpy.mockRestore();
    }
  });
});

describe("role attachment helpers", () => {
  test("attachRole and detachRole are idempotent", async () => {
    const user = await createUser({ name: "Idempotent User" });

    await attachRole(user.id, "requester");
    await attachRole(user.id, "requester");
    expect(await roleNames(user.id)).toEqual(["admin", "requester"]);

    await detachRole(user.id, "requester");
    await detachRole(user.id, "requester");
    expect(await roleNames(user.id)).toEqual(["admin"]);
  });

  test("createUser receives the default admin role from the users trigger", async () => {
    const user = await createUser({ name: "Trigger User" });

    expect((await listUserRoles(user.id)).map((role) => role.id)).toEqual([DEFAULT_ROLE_ID]);
  });
});

describe("ensureRbacSeedsSynced", () => {
  test("restores a deleted built-in role and its permissions", async () => {
    await getDbClient().run("DELETE FROM roles WHERE id = ?", [REQUESTER_ROLE_ID]);

    ensureRbacSeedsSynced({ quiet: true });

    const row = await getDbClient().get<{
      id: string;
      name: string;
      isBuiltin: number;
      grantsAll: number;
    }>("SELECT id, name, isBuiltin, grantsAll FROM roles WHERE id = ?", [REQUESTER_ROLE_ID]);
    expect(row).toEqual({
      id: REQUESTER_ROLE_ID,
      name: "requester",
      isBuiltin: 1,
      grantsAll: 0,
    });
    expect(await roleVerbs(REQUESTER_ROLE_ID)).toEqual(REQUESTER_VERBS);
  });

  test("throws when a custom role owns a missing built-in role name", async () => {
    await getDbClient().transaction(async (tx) => {
      await tx.run("DELETE FROM roles WHERE id = ?", [DEFAULT_ROLE_ID]);
      await tx.run(
        "INSERT INTO roles (id, name, description, isBuiltin, grantsAll) VALUES (?, ?, ?, 0, 0)",
        ["custom-role-admin-collision", "admin", "Conflicting admin role"],
      );
    });

    expect(() => ensureRbacSeedsSynced({ quiet: true })).toThrow(
      /RBAC built-in role "admin" \(rbac-role-admin\) is missing because role "admin" \(custom-role-admin-collision\) already uses that name\. Rename or remove the conflicting role, then rerun `rbac bootstrap`\./,
    );
  });

  test("repairs a tampered requester verb set", async () => {
    await getDbClient().run("DELETE FROM role_permissions WHERE roleId = ? AND verb = ?", [
      REQUESTER_ROLE_ID,
      "task.read.own",
    ]);
    await getDbClient().run("INSERT INTO role_permissions (roleId, verb) VALUES (?, ?)", [
      REQUESTER_ROLE_ID,
      "user.manage",
    ]);

    ensureRbacSeedsSynced({ quiet: true });

    expect(await roleVerbs(REQUESTER_ROLE_ID)).toEqual(REQUESTER_VERBS);
  });

  test("leaves custom roles and custom permissions untouched", async () => {
    await insertCustomRole("custom-role-support", "support", ["user.manage"]);

    ensureRbacSeedsSynced({ quiet: true });

    const row = await getDbClient().get<{ isBuiltin: number; grantsAll: number }>(
      "SELECT isBuiltin, grantsAll FROM roles WHERE id = ?",
      ["custom-role-support"],
    );
    expect(row).toEqual({ isBuiltin: 0, grantsAll: 0 });
    expect(await roleVerbs("custom-role-support")).toEqual(["user.manage"]);
  });

  test("recreates the default-role trigger when it has been dropped", async () => {
    await getDbClient().run("DROP TRIGGER trg_users_default_role");

    ensureRbacSeedsSynced({ quiet: true });
    const user = await createUser({ name: "Recreated Trigger User" });

    expect((await listUserRoles(user.id)).map((role) => role.id)).toEqual([DEFAULT_ROLE_ID]);
  });

  test("backfills the default role for users with zero roles", async () => {
    const user = await createUser({ name: "Backfilled User" });
    await detachRole(user.id, "admin");
    expect(await listUserRoles(user.id)).toEqual([]);

    const stats = ensureRbacSeedsSynced({ quiet: true });

    expect(stats.usersBackfilled).toBe(1);
    expect((await listUserRoles(user.id)).map((role) => role.id)).toEqual([DEFAULT_ROLE_ID]);
  });

  test("does not touch users deliberately narrowed to requester-only", async () => {
    const user = await createUser({ name: "Requester Only User" });
    await attachRole(user.id, "requester");
    await detachRole(user.id, "admin");
    expect((await listUserRoles(user.id)).map((role) => role.id)).toEqual([REQUESTER_ROLE_ID]);

    const stats = ensureRbacSeedsSynced({ quiet: true });

    expect(stats.usersBackfilled).toBe(0);
    expect((await listUserRoles(user.id)).map((role) => role.id)).toEqual([REQUESTER_ROLE_ID]);
  });

  test("rejects invalid built-in role verbs before syncing", async () => {
    const requester = BUILTIN_ROLES.find((role) => role.id === REQUESTER_ROLE_ID);
    if (!requester) {
      throw new Error("Missing requester role definition");
    }
    const originalVerbs = [...requester.verbs];
    requester.verbs.push("invalid.permission" as PermissionVerb);

    try {
      expect(() => ensureRbacSeedsSynced({ quiet: true })).toThrow(
        /Invalid RBAC permission verb "invalid\.permission"/,
      );
      expect(await roleVerbs(REQUESTER_ROLE_ID)).toEqual(REQUESTER_VERBS);
    } finally {
      requester.verbs.splice(0, requester.verbs.length, ...originalVerbs);
    }
  });
});

describe("runRbacCliCommand", () => {
  test("rejects trailing bootstrap arguments", async () => {
    await expect(runRbacCliCommand(["bootstrap", "--bogus"])).rejects.toThrow(
      "Unknown RBAC command: bootstrap --bogus",
    );
  });

  test("reports users backfilled by bootstrap once", async () => {
    const user = await createUser({ name: "CLI Backfilled User" });
    await detachRole(user.id, "admin");
    const logSpy = spyOn(console, "log").mockImplementation(() => {});

    try {
      await runRbacCliCommand(["bootstrap"]);

      expect(logSpy).toHaveBeenCalledWith("Users backfilled this run: 1");
      expect((await listUserRoles(user.id)).map((role) => role.id)).toEqual([DEFAULT_ROLE_ID]);

      logSpy.mockClear();
      await runRbacCliCommand(["bootstrap"]);

      expect(logSpy).toHaveBeenCalledWith("Users backfilled this run: 0");
    } finally {
      logSpy.mockRestore();
    }
  });
});
