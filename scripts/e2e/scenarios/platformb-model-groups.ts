import { asRecord, asRecords, expect, expectStatus } from "../http";
import type { Scenario } from "../run";
import { Cleanup, registerLead, registerWorker, retireAgent } from "./platformb-helpers";

/**
 * Model groups over HTTP: the four seeded tier groups, CRUD with the lead /
 * operator / worker split, the shared name space with profiles, the member
 * reorder, and the delete guards (seed, profile still a member).
 */
export const platformbModelGroups: Scenario = {
  name: "platformb-model-groups",
  order: 661,
  async run(ctx) {
    const cleanup = new Cleanup();
    const groupNames: string[] = [];
    const profileName = `e2e-mg-prof-${ctx.nonce}`;
    let leadId: string | undefined;
    let workerId: string | undefined;
    cleanup.add("retire agents", async () => {
      await retireAgent(ctx, leadId);
      await retireAgent(ctx, workerId);
    });
    cleanup.add("delete profile", () => ctx.api("DELETE", `/api/model-profiles/${profileName}`));
    cleanup.add("delete groups", async () => {
      for (const name of groupNames) await ctx.api("DELETE", `/api/model-groups/${name}`);
    });

    await cleanup.around(async () => {
      leadId = await registerLead(ctx, `e2e-mg-lead-${ctx.nonce}`);
      workerId = await registerWorker(ctx, `e2e-mg-worker-${ctx.nonce}`);

      // ===== seeded tier groups =====
      let response = await ctx.api("GET", "/api/model-groups");
      expectStatus(response, [200], "list model groups");
      const seeded = asRecords(response.json, "groups");
      for (const tier of ["smol", "regular", "smart", "ultra"]) {
        const group = seeded.find((g) => g.name === tier);
        const members = group?.members as string[] | undefined;
        expect(
          group?.seededFrom === `tier:${tier}` && members?.[0] === `claude-${tier}`,
          `Seeded tier group ${tier} is ${JSON.stringify(group)}`,
        );
        expect(
          members?.every((member) => member.endsWith(`-${tier}`)) === true,
          `Seeded group ${tier} lists a non-tier member`,
        );
      }
      expect(
        seeded.find((g) => g.name === "smol")?.description === "Cheap",
        "The smol group is not described as Cheap",
      );
      response = await ctx.api("GET", "/api/model-groups/smart", { agentId: workerId });
      expectStatus(response, [200], "a worker reads a group");
      expectStatus(
        await ctx.api("GET", `/api/model-groups/no-such-${ctx.nonce}`),
        [404],
        "read an unknown group",
      );
      response = await ctx.api("DELETE", "/api/model-groups/smol");
      expectStatus(response, [409], "delete a shipped tier group");
      expect(
        String(asRecord(response.json).error).includes("shipped tier group"),
        "Seed deletion error does not say it is a tier group",
      );

      // ===== CRUD =====
      const groupName = `e2e-mg-${ctx.nonce}`;
      groupNames.push(groupName);
      response = await ctx.api("POST", "/api/model-groups", {
        body: {
          name: groupName,
          description: "e2e group",
          members: ["claude-smol", "codex-smol"],
        },
      });
      expectStatus(response, [201], "create a model group");
      const created = asRecord(response.json);
      expect(
        created.name === groupName &&
          created.description === "e2e group" &&
          created.seededFrom === null &&
          JSON.stringify(created.members) === JSON.stringify(["claude-smol", "codex-smol"]),
        `Created group is ${JSON.stringify(created)}`,
      );
      expectStatus(
        await ctx.api("POST", "/api/model-groups", {
          body: { name: groupName, members: ["claude-smol"] },
        }),
        [409],
        "create a duplicate group",
      );
      response = await ctx.api("POST", "/api/model-groups", {
        body: { name: "claude-regular", members: ["claude-smol"] },
      });
      expectStatus(response, [409], "create a group named like a profile");
      response = await ctx.api("POST", "/api/model-profiles", {
        body: { name: groupName, harness: "claude", model: "opus" },
      });
      expectStatus(response, [409], "create a profile named like a group");
      expectStatus(
        await ctx.api("POST", "/api/model-groups", {
          body: { name: `e2e-mg-bad-${ctx.nonce}`, members: [`no-such-${ctx.nonce}`] },
        }),
        [400],
        "create a group with an unknown member",
      );

      const leadGroup = `e2e-mg-lead-${ctx.nonce}`;
      groupNames.push(leadGroup);
      expectStatus(
        await ctx.api("POST", "/api/model-groups", {
          agentId: leadId,
          body: { name: leadGroup, members: ["claude-smart"] },
        }),
        [201],
        "the lead creates a group",
      );
      for (const [method, path, body] of [
        ["POST", "/api/model-groups", { name: `e2e-mg-w-${ctx.nonce}`, members: ["claude-smol"] }],
        ["PATCH", `/api/model-groups/${groupName}`, { description: "worker edit" }],
        ["PUT", `/api/model-groups/${groupName}/members`, { members: ["codex-smol"] }],
        ["DELETE", `/api/model-groups/${groupName}`, undefined],
      ] as const) {
        response = await ctx.api(method, path, { agentId: workerId, body });
        expectStatus(response, [403], `worker ${method} ${path}`);
      }

      response = await ctx.api("PATCH", `/api/model-groups/${groupName}`, {
        body: { description: null },
      });
      expectStatus(response, [200], "clear a group description");
      expect(asRecord(response.json).description === null, "Description was not cleared");

      // ===== members =====
      response = await ctx.api("POST", "/api/model-profiles", {
        body: { name: profileName, harness: "codex", model: "gpt-5", allowCustomModel: true },
      });
      expectStatus(response, [201], "create a member profile");
      response = await ctx.api("PUT", `/api/model-groups/${groupName}/members`, {
        body: { members: ["codex-smol", profileName, "claude-smol"] },
      });
      expectStatus(response, [200], "reorder group members");
      const rows = ctx.db.query<{ position: number; profileName: string }>(
        `SELECT m.position, m.profileName FROM model_group_members m
           JOIN model_groups g ON g.id = m.groupId WHERE g.name = ? ORDER BY m.position`,
        [groupName],
      );
      expect(
        JSON.stringify(rows.map((r) => [r.position, r.profileName])) ===
          JSON.stringify([
            [0, "codex-smol"],
            [1, profileName],
            [2, "claude-smol"],
          ]),
        `Stored members are ${JSON.stringify(rows)}`,
      );
      expectStatus(
        await ctx.api("PUT", `/api/model-groups/${groupName}/members`, {
          body: { members: ["claude-smol", "claude-smol"] },
        }),
        [400],
        "repeat a member",
      );
      response = await ctx.api("DELETE", `/api/model-profiles/${profileName}`);
      expectStatus(response, [409], "delete a profile that is a group member");
      expect(
        String(asRecord(response.json).error).includes(groupName),
        "Member-profile delete error does not name the group",
      );

      for (const name of [groupName, leadGroup]) {
        response = await ctx.api("DELETE", `/api/model-groups/${name}`);
        expectStatus(response, [200], `delete group ${name}`);
        expectStatus(
          await ctx.api("GET", `/api/model-groups/${name}`),
          [404],
          `read deleted group ${name}`,
        );
      }
      groupNames.length = 0;
      expectStatus(
        await ctx.api("DELETE", `/api/model-profiles/${profileName}`),
        [200],
        "delete the profile once no group lists it",
      );
    });
  },
};
