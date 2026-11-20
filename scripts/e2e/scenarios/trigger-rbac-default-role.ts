// Trigger group: RBAC default role.
// Covers: trg_users_default_role (users AFTER INSERT: a new user gets the admin role row).
//
// A user created over the API holds the built-in admin role at once, with no role write of
// its own. An invite names its role, and that role replaces the default.
import { sql } from "../db";
import { asRecord, asRecords, expect, expectStatus } from "../http";
import type { Scenario, ScenarioContext } from "../run";

function roleIds(ctx: ScenarioContext, userId: string): string[] {
  return ctx.db
    .query<{ roleId: string }>(
      sql`SELECT "roleId" FROM principal_roles
          WHERE "principalType" = 'user' AND "principalId" = ${userId}
          ORDER BY "roleId"`,
    )
    .map((row) => row.roleId);
}

export const triggerRbacDefaultRole: Scenario = {
  name: "trigger-rbac-default-role",
  order: 9_370,
  async run(ctx) {
    const created = await ctx.api("POST", "/api/users", {
      body: { name: `Trigger rbac ${ctx.nonce}`, status: "active" },
    });
    expectStatus(created, [200], "create a user");
    const userId = String(asRecord(asRecord(created.json).user).id);
    expect(userId.length > 0, "the created user has no id");

    const ids = roleIds(ctx, userId);
    expect(
      ids.join() === "rbac-role-admin",
      `a new user holds exactly the admin role row, got ${JSON.stringify(ids)}`,
    );
    const roles = await ctx.api("GET", `/api/users/${userId}/roles`);
    expectStatus(roles, [200], "read the new user's roles");
    expect(
      asRecords(roles.json, "roles")
        .map((role) => role.name)
        .join() === "admin",
      `the roles route reports admin: ${roles.text}`,
    );

    // A second user gets its own default row; the first keeps one row only.
    const second = await ctx.api("POST", "/api/users", {
      body: { name: `Trigger rbac second ${ctx.nonce}`, status: "active" },
    });
    expectStatus(second, [200], "create a second user");
    const secondId = String(asRecord(asRecord(second.json).user).id);
    expect(roleIds(ctx, secondId).join() === "rbac-role-admin", "the second user is an admin");
    expect(roleIds(ctx, userId).length === 1, "the first user still has exactly one role row");

    // An explicit role write replaces the default.
    const demoted = await ctx.api("PUT", `/api/users/${secondId}/roles`, {
      body: { roles: ["viewer"] },
    });
    expectStatus(demoted, [200], "set the second user to viewer");
    expect(
      !roleIds(ctx, secondId).includes("rbac-role-admin"),
      "the admin default stays after an explicit role change",
    );

    // An invite carries its own role: the invited user ends with that role only.
    const invited = await ctx.api("POST", "/api/invites", {
      body: { email: `trigger-rbac-${ctx.nonce}@example.com`, role: "viewer" },
    });
    expectStatus(invited, [201], "invite a viewer");
    const invitedId = String(asRecord(asRecord(invited.json).user).id);
    const invitedRoles = await ctx.api("GET", `/api/users/${invitedId}/roles`);
    expectStatus(invitedRoles, [200], "read the invited user's roles");
    expect(
      asRecords(invitedRoles.json, "roles")
        .map((role) => role.name)
        .join() === "viewer",
      `the invite's role replaces the default: ${invitedRoles.text}`,
    );
  },
};
