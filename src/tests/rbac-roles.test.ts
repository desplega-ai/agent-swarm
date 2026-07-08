import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { closeDb, createUser, getDb, initDb } from "../be/db";
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
  "task.action.own",
  "task.cancel.own",
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

function roleNames(userId: string): string[] {
  return listUserRoles(userId).map((role) => role.name);
}

function roleVerbs(roleId: string): string[] {
  return getDb()
    .prepare<{ verb: string }, string>(
      "SELECT verb FROM role_permissions WHERE roleId = ? ORDER BY verb",
    )
    .all(roleId)
    .map((row) => row.verb);
}

function insertCustomRole(roleId: string, name: string, verbs: PermissionVerb[]) {
  const db = getDb();
  db.transaction(() => {
    db.prepare(
      "INSERT INTO roles (id, name, description, isBuiltin, grantsAll) VALUES (?, ?, ?, 0, 0)",
    ).run(roleId, name, "Test custom role");
    const insertPermission = db.prepare(
      "INSERT INTO role_permissions (roleId, verb) VALUES (?, ?)",
    );
    for (const verb of verbs) {
      insertPermission.run(roleId, verb);
    }
  })();
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
  test("unions verbs from all non-wildcard user roles", () => {
    const user = createUser({ name: "Union User" });
    detachRole(user.id, "admin");
    insertCustomRole("custom-role-reviewer", "reviewer", ["user.manage"]);

    attachRole(user.id, "requester");
    attachRole(user.id, "reviewer");

    const grant = getUserGrant(user.id);
    expect(grant.grantsAll).toBe(false);
    expect(sortedVerbs(grant.verbs)).toEqual([...REQUESTER_VERBS, "user.manage"].sort());
  });

  test("short-circuits to grantsAll when any attached role is a wildcard", () => {
    const user = createUser({ name: "Wildcard User" });
    attachRole(user.id, "requester");

    const grant = getUserGrant(user.id);
    expect(grant.grantsAll).toBe(true);
    expect(grant.verbs.size).toBe(0);
  });

  test("returns an empty fail-closed grant for a user with no roles", () => {
    const user = createUser({ name: "Detached User" });
    detachRole(user.id, "admin");

    const grant = getUserGrant(user.id);
    expect(grant.grantsAll).toBe(false);
    expect(grant.verbs.size).toBe(0);
  });

  test("returns an empty fail-closed grant for an unknown user", () => {
    const grant = getUserGrant("missing-user");

    expect(grant.grantsAll).toBe(false);
    expect(grant.verbs.size).toBe(0);
  });

  test("skips invalid database grant verbs fail-closed without throwing", () => {
    const user = createUser({ name: "Malformed Grant User" });
    detachRole(user.id, "admin");
    const db = getDb();
    db.transaction(() => {
      db.prepare(
        "INSERT INTO roles (id, name, description, isBuiltin, grantsAll) VALUES (?, ?, ?, 0, 0)",
      ).run("custom-role-malformed-grant", "malformed-grant", "Test malformed grant role");
      db.prepare("INSERT INTO role_permissions (roleId, verb) VALUES (?, ?)").run(
        "custom-role-malformed-grant",
        "task.read.own",
      );
      db.prepare("INSERT INTO role_permissions (roleId, verb) VALUES (?, ?)").run(
        "custom-role-malformed-grant",
        "invalid.permission",
      );
      db.prepare(
        `INSERT INTO principal_roles (principalType, principalId, roleId)
         VALUES ('user', ?, ?)`,
      ).run(user.id, "custom-role-malformed-grant");
    })();
    const errSpy = spyOn(console, "error").mockImplementation(() => {});

    try {
      const grant = getUserGrant(user.id);

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
  test("attachRole and detachRole are idempotent", () => {
    const user = createUser({ name: "Idempotent User" });

    attachRole(user.id, "requester");
    attachRole(user.id, "requester");
    expect(roleNames(user.id)).toEqual(["admin", "requester"]);

    detachRole(user.id, "requester");
    detachRole(user.id, "requester");
    expect(roleNames(user.id)).toEqual(["admin"]);
  });

  test("createUser receives the default admin role from the users trigger", () => {
    const user = createUser({ name: "Trigger User" });

    expect(listUserRoles(user.id).map((role) => role.id)).toEqual([DEFAULT_ROLE_ID]);
  });
});

describe("ensureRbacSeedsSynced", () => {
  test("restores a deleted built-in role and its permissions", () => {
    getDb().prepare("DELETE FROM roles WHERE id = ?").run(REQUESTER_ROLE_ID);

    ensureRbacSeedsSynced({ quiet: true });

    const row = getDb()
      .prepare<{ id: string; name: string; isBuiltin: number; grantsAll: number }, string>(
        "SELECT id, name, isBuiltin, grantsAll FROM roles WHERE id = ?",
      )
      .get(REQUESTER_ROLE_ID);
    expect(row).toEqual({
      id: REQUESTER_ROLE_ID,
      name: "requester",
      isBuiltin: 1,
      grantsAll: 0,
    });
    expect(roleVerbs(REQUESTER_ROLE_ID)).toEqual(REQUESTER_VERBS);
  });

  test("throws when a custom role owns a missing built-in role name", () => {
    const db = getDb();
    db.transaction(() => {
      db.prepare("DELETE FROM roles WHERE id = ?").run(DEFAULT_ROLE_ID);
      db.prepare(
        "INSERT INTO roles (id, name, description, isBuiltin, grantsAll) VALUES (?, ?, ?, 0, 0)",
      ).run("custom-role-admin-collision", "admin", "Conflicting admin role");
    })();

    expect(() => ensureRbacSeedsSynced({ quiet: true })).toThrow(
      /RBAC built-in role "admin" \(rbac-role-admin\) is missing because role "admin" \(custom-role-admin-collision\) already uses that name\. Rename or remove the conflicting role, then rerun `rbac bootstrap`\./,
    );
  });

  test("repairs a tampered requester verb set", () => {
    const db = getDb();
    db.prepare("DELETE FROM role_permissions WHERE roleId = ? AND verb = ?").run(
      REQUESTER_ROLE_ID,
      "task.read.own",
    );
    db.prepare("INSERT INTO role_permissions (roleId, verb) VALUES (?, ?)").run(
      REQUESTER_ROLE_ID,
      "user.manage",
    );

    ensureRbacSeedsSynced({ quiet: true });

    expect(roleVerbs(REQUESTER_ROLE_ID)).toEqual(REQUESTER_VERBS);
  });

  test("leaves custom roles and custom permissions untouched", () => {
    insertCustomRole("custom-role-support", "support", ["user.manage"]);

    ensureRbacSeedsSynced({ quiet: true });

    const row = getDb()
      .prepare<{ isBuiltin: number; grantsAll: number }, string>(
        "SELECT isBuiltin, grantsAll FROM roles WHERE id = ?",
      )
      .get("custom-role-support");
    expect(row).toEqual({ isBuiltin: 0, grantsAll: 0 });
    expect(roleVerbs("custom-role-support")).toEqual(["user.manage"]);
  });

  test("recreates the default-role trigger when it has been dropped", () => {
    getDb().run("DROP TRIGGER trg_users_default_role");

    ensureRbacSeedsSynced({ quiet: true });
    const user = createUser({ name: "Recreated Trigger User" });

    expect(listUserRoles(user.id).map((role) => role.id)).toEqual([DEFAULT_ROLE_ID]);
  });

  test("rejects invalid built-in role verbs before syncing", () => {
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
      expect(roleVerbs(REQUESTER_ROLE_ID)).toEqual(REQUESTER_VERBS);
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
});
