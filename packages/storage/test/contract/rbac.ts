import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { type RbacRepository, type Storage, sql, type UsersRepository } from "../../src";
import type { ContractEngine } from "./env";

const T0 = "2026-11-21T10:00:00.000Z";
// roles.createdAt holds DEFAULT CURRENT_TIMESTAMP text (no writer sets it): the
// fixture stores that format, so the round trip is exact on both engines.
const ROLE_T0 = "2026-11-21 10:00:00";

// Migration 109 seeds `rbac-role-admin` (grant-all) and `rbac-role-requester`,
// and its trigger attaches the admin role to every new user.
const ADMIN = "rbac-role-admin";

export function rbacContract(engine: ContractEngine): void {
  describe(`rbac repository [${engine.name}]`, () => {
    let storage: Storage;
    let repo: RbacRepository;
    let users: UsersRepository;

    const addUser = (id: string, status = "active") =>
      users.insertUser({
        id,
        name: id,
        email: null,
        role: null,
        notes: null,
        emailAliases: "[]",
        preferredChannel: "slack",
        timezone: null,
        metadata: null,
        dailyBudgetUsd: null,
        status,
        avatar: null,
        now: T0,
      });

    const addRole = async (id: string, name: string, verbs: string[], grantsAll = false) => {
      await storage.executor.run(sql`
        INSERT INTO roles (id, name, description, "isBuiltin", "grantsAll", "createdAt")
        VALUES (${id}, ${name}, ${null}, ${false}, ${grantsAll}, ${ROLE_T0})`);
      for (const verb of verbs) {
        await storage.executor.run(
          sql`INSERT INTO role_permissions ("roleId", verb) VALUES (${id}, ${verb})`,
        );
      }
    };

    beforeEach(async () => {
      storage = await engine.fresh();
      repo = storage.repos.rbac;
      users = storage.repos.users;
    });
    afterEach(async () => {
      await engine.release(storage);
    });

    test("roles: lookups, value shape and name order", async () => {
      await addRole("r-z", "zeta", ["b.verb", "a.verb"]);
      expect(await repo.findRoleByName("admin")).toEqual({
        id: ADMIN,
        name: "admin",
        grantsAll: 1,
      });
      expect(await repo.findRoleByName("missing")).toBeNull();
      const roles = await repo.listRoles();
      expect(roles.map((r) => r.name)).toEqual(["admin", "requester", "zeta"]);
      expect(roles[2]).toEqual({
        id: "r-z",
        name: "zeta",
        description: null,
        isBuiltin: 0,
        grantsAll: 0,
        createdAt: ROLE_T0,
      });
      const perms = (await repo.listRolePermissions()).filter((p) => p.roleId === "r-z");
      expect(perms).toEqual([
        { roleId: "r-z", verb: "a.verb" },
        { roleId: "r-z", verb: "b.verb" },
      ]);
    });

    test("attach is idempotent, detach removes, user roles by name", async () => {
      await addRole("r-z", "zeta", ["x.read"]);
      await addUser("u1");
      await repo.detachUserRole("u1", ADMIN);
      expect(await repo.listUserRoles("u1")).toEqual([]);
      await repo.attachUserRole("u1", "r-z", null);
      await repo.attachUserRole("u1", "r-z", "u1");
      await repo.attachUserRole("u1", ADMIN, null);
      expect((await repo.listUserRoles("u1")).map((r) => r.name)).toEqual(["admin", "zeta"]);
      const createdBy = await storage.executor.get(sql`
        SELECT created_by FROM principal_roles WHERE "principalId" = 'u1' AND "roleId" = 'r-z'`);
      expect(createdBy).toEqual({ created_by: null });
    });

    test("grant rows and verb checks", async () => {
      await addRole("r-a", "alpha", ["x.read", "x.write"]);
      await addRole("r-b", "beta", ["session.read.all"]);
      await addUser("u1");
      await repo.detachUserRole("u1", ADMIN);
      await repo.attachUserRole("u1", "r-a", null);
      const rows = await repo.listUserGrantRows("u1");
      expect(rows.map((r) => r.verb).sort()).toEqual(["x.read", "x.write"]);
      expect(rows.every((r) => r.roleId === "r-a" && r.grantsAll === 0)).toBe(true);

      await repo.attachUserRole("u1", ADMIN, null);
      const withAdmin = await repo.listUserGrantRows("u1");
      expect(withAdmin[0]).toEqual({ roleId: ADMIN, grantsAll: 1, verb: null });

      expect(await repo.userHoldsAnyVerb("u1", ["x.write"])).toBe(true);
      expect(await repo.userHoldsAnyVerb("u1", ["session.read.all", "nope"])).toBe(false);
      expect(await repo.userHoldsAnyVerb("u1", [])).toBe(false);
      expect(
        await repo.listRoleNamesWithVerbs(["r-b", "r-a", ADMIN], ["session.read.all", "x.read"]),
      ).toEqual(["alpha", "beta"]);
      expect(await repo.listRoleNamesWithVerbs([], ["x.read"])).toEqual([]);
    });

    test("active grant-all users skip inactive users and merge sources", async () => {
      await addUser("u1");
      await addUser("u2", "suspended");
      await addUser("u3");
      await addUser("u4");
      await users.markUserMergedInto("u4", "u1", T0);
      await repo.detachUserRole("u3", ADMIN);
      expect(await repo.isActiveGrantAllUser("u1")).toBe(true);
      expect(await repo.isActiveGrantAllUser("u2")).toBe(false);
      expect(await repo.isActiveGrantAllUser("u3")).toBe(false);
      expect(await repo.isActiveGrantAllUser("u4")).toBe(false);
      expect(await repo.countOtherActiveGrantAllUsers("u1")).toBe(0);
      expect(await repo.countOtherActiveGrantAllUsers("u3")).toBe(1);
    });

    test("role summaries count verbs and attached users", async () => {
      await addRole("r-z", "zeta", ["a", "b"]);
      await addUser("u1");
      await addUser("u2");
      await repo.attachUserRole("u1", "r-z", null);
      const summaries = await repo.listRoleSummaries();
      expect(summaries.map((r) => r.name)).toEqual(["admin", "requester", "zeta"]);
      expect(summaries.find((r) => r.name === "zeta")).toEqual({
        name: "zeta",
        isBuiltin: 0,
        grantsAll: 0,
        verbCount: 2,
        attachedUserCount: 1,
      });
      expect(summaries.find((r) => r.name === "admin")).toMatchObject({
        verbCount: 0,
        attachedUserCount: 2,
      });
    });

    test("permission audit insert and retention purge", async () => {
      const row = {
        principalType: "user" as const,
        principalId: "u1",
        originatorUserId: null,
        verb: "task.read.own",
        resourceType: "task",
        resourceId: "t1",
        decision: "deny" as const,
        reason: "no",
        source: "http" as const,
      };
      await repo.insertPermissionAudit(row);
      await repo.insertPermissionAudit({ ...row, resourceId: "t2" });
      await storage.executor.run(
        sql`UPDATE permission_audit SET ts = '2000-01-01 00:00:00' WHERE "resourceId" = 't2'`,
      );
      const stored = await storage.executor.get<Record<string, unknown>>(
        sql`SELECT * FROM permission_audit WHERE "resourceId" = 't1'`,
      );
      expect(stored).toMatchObject(row);
      expect(String(stored?.ts)).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
      expect(await repo.purgeAuditOlderThanDays(30)).toBe(1);
      expect(await repo.purgeAuditOlderThanDays(30)).toBe(0);
    });

    test("built-in role seed: insert once, update only on drift, verbs in byte order", async () => {
      const seed = { id: "ct-builtin", name: "ct-builtin", description: "d", grantsAll: false };
      expect(await repo.insertBuiltinRole(seed)).toBe(1);
      expect(await repo.insertBuiltinRole(seed)).toBe(0);
      expect(await repo.insertBuiltinRole({ ...seed, id: "ct-other" })).toBe(0);
      expect(await repo.updateBuiltinRole(seed)).toBe(0);
      expect(await repo.updateBuiltinRole({ ...seed, description: "d2" })).toBe(1);
      expect(await repo.findRoleIdentity({ id: "ct-builtin" })).toEqual({
        id: "ct-builtin",
        name: "ct-builtin",
      });
      expect(await repo.findRoleIdentity({ name: "ct-builtin" })).toEqual({
        id: "ct-builtin",
        name: "ct-builtin",
      });
      expect(await repo.findRoleIdentity({ id: "ct-none" })).toBeNull();
      expect(await repo.insertRolePermission("ct-builtin", "b.verb")).toBe(1);
      expect(await repo.insertRolePermission("ct-builtin", "B.verb")).toBe(1);
      expect(await repo.insertRolePermission("ct-builtin", "b.verb")).toBe(0);
      expect(await repo.listRoleVerbs("ct-builtin")).toEqual(["B.verb", "b.verb"]);
      expect(await repo.deleteRolePermission("ct-builtin", "B.verb")).toBe(1);
      expect(await repo.listRoleVerbs("ct-builtin")).toEqual(["b.verb"]);
    });

    test("default-role trigger and the roleless-user backfill", async () => {
      await repo.ensureDefaultRoleTrigger();
      await repo.ensureDefaultRoleTrigger();
      await addRole("ct-default", "ct-default", []);
      await addUser("ct-u1");
      await addUser("ct-u2");
      const before = await repo.listUserRoles("ct-u1");
      expect(await repo.attachRoleToRolelessUsers("ct-default")).toBe(before.length === 0 ? 2 : 0);
      expect(await repo.attachRoleToRolelessUsers("ct-default")).toBe(0);
    });
  });
}
