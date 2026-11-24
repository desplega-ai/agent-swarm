// Trigger group: model profile and model group references.
// Covers:
//   model_profiles_name_space_insert, model_groups_name_space_insert (one name space),
//   model_profiles_task_ref_insert, model_groups_task_ref_insert (a task names a real one),
//   model_profiles_schedule_ref_insert, model_profiles_schedule_ref_update,
//   model_groups_schedule_ref_insert, model_groups_schedule_ref_update (a schedule names a real one),
//   model_profiles_default_ref_insert, model_profiles_default_ref_update (an agent's default
//   MODEL_PROFILE config names a real profile).
// Unreachable: model_profiles_task_ref_update, model_groups_task_ref_update. No API changes a
// task's profile or modelGroup after the insert.
import { sql } from "../db";
import { asRecord, asString, expect, expectStatus } from "../http";
import type { Scenario, ScenarioContext } from "../run";

function scheduleRow(ctx: ScenarioContext, id: string) {
  return ctx.db.get<{ profile: string | null; modelGroup: string | null }>(
    sql`SELECT profile, "modelGroup" FROM scheduled_tasks WHERE id = ${id}`,
  );
}

function agentDefault(ctx: ScenarioContext, agentId: string): string | null {
  return (
    ctx.db.get<{ value: string }>(
      sql`SELECT value FROM swarm_config
          WHERE scope = 'agent' AND "scopeId" = ${agentId} AND key = 'MODEL_PROFILE'`,
    )?.value ?? null
  );
}

// A custom id no catalog lists: allowCustomModel lets it through, and a models.dev
// deprecation cannot reject it (gpt-5 went deprecated upstream on 2026-11-23).
const CUSTOM_CODEX_MODEL = "e2e-custom-codex-model";

export const triggerModelProfiles: Scenario = {
  name: "trigger-model-profiles",
  order: 9_320,
  async run(ctx) {
    const profile = `trg-mp-${ctx.nonce}`;
    const group = `trg-mg-${ctx.nonce}`;
    const missingProfile = `trg-mp-missing-${ctx.nonce}`;
    const missingGroup = `trg-mg-missing-${ctx.nonce}`;
    const taskIds: string[] = [];
    let scheduleId: string | undefined;
    let configId: string | undefined;

    const registered = await ctx.api("POST", "/api/agents", {
      body: {
        name: `trg-mp-worker-${ctx.nonce}`,
        role: "worker",
        status: "online",
        harness_provider: "codex",
      },
    });
    expectStatus(registered, [201], "register a codex worker");
    const workerId = asString(asRecord(registered.json).id, "worker id");

    try {
      // ── one name space for profiles and groups ─────────────────────────────
      let response = await ctx.api("POST", "/api/model-profiles", {
        body: { name: profile, harness: "codex", model: CUSTOM_CODEX_MODEL, allowCustomModel: true },
      });
      expectStatus(response, [201], "create a profile");
      response = await ctx.api("POST", "/api/model-groups", {
        body: { name: group, members: [profile] },
      });
      expectStatus(response, [201], "create a group");

      response = await ctx.api("POST", "/api/model-profiles", {
        body: { name: group, harness: "codex", model: CUSTOM_CODEX_MODEL, allowCustomModel: true },
      });
      expectStatus(response, [409], "a profile cannot take a group's name");
      expect(
        String(asRecord(response.json).error).includes("share one name space"),
        `profile name clash error: ${response.text}`,
      );
      response = await ctx.api("POST", "/api/model-groups", {
        body: { name: profile, members: [profile] },
      });
      expectStatus(response, [409], "a group cannot take a profile's name");
      expect(
        ctx.db.get<{ n: number }>(
          sql`SELECT count(*) AS n FROM model_profiles WHERE name = ${group}`,
        )?.n === 0 &&
          ctx.db.get<{ n: number }>(
            sql`SELECT count(*) AS n FROM model_groups WHERE name = ${profile}`,
          )?.n === 0,
        "a refused name clash writes no row",
      );

      // ── a task names a profile or group that exists ────────────────────────
      const taskBody = (extra: Record<string, unknown>) => ({
        task: `trigger model ref ${ctx.nonce}`,
        agentId: workerId,
        routingReason: "human_pinned",
        source: "api",
        ...extra,
      });
      response = await ctx.api("POST", "/api/tasks", {
        body: taskBody({ profile: missingProfile }),
      });
      expectStatus(response, [400], "a task with an unknown profile");
      response = await ctx.api("POST", "/api/tasks", {
        body: taskBody({ modelGroup: missingGroup }),
      });
      expectStatus(response, [400], "a task with an unknown model group");
      expect(
        ctx.db.get<{ n: number }>(
          sql`SELECT count(*) AS n FROM agent_tasks
              WHERE profile = ${missingProfile} OR "modelGroup" = ${missingGroup}`,
        )?.n === 0,
        "a refused task writes no row",
      );
      response = await ctx.api("POST", "/api/tasks", { body: taskBody({ profile }) });
      expectStatus(response, [201], "a task with a real profile");
      const profiledTask = asString(asRecord(response.json).id, "profiled task id");
      taskIds.push(profiledTask);
      response = await ctx.api("POST", "/api/tasks", { body: taskBody({ modelGroup: group }) });
      expectStatus(response, [201], "a task with a real group");
      const groupedTask = asString(asRecord(response.json).id, "grouped task id");
      taskIds.push(groupedTask);
      expect(
        ctx.db.get<{ profile: string }>(
          sql`SELECT profile FROM agent_tasks WHERE id = ${profiledTask}`,
        )?.profile === profile &&
          ctx.db.get<{ modelGroup: string }>(
            sql`SELECT "modelGroup" FROM agent_tasks WHERE id = ${groupedTask}`,
          )?.modelGroup === group,
        "the accepted tasks store their profile and group",
      );

      // ── a schedule names a profile or group that exists ────────────────────
      const scheduleBody = (extra: Record<string, unknown>) => ({
        name: `trg-mp-sched-${ctx.nonce}`,
        taskTemplate: `trigger model schedule ${ctx.nonce}`,
        intervalMs: 3_600_000,
        targetAgentId: workerId,
        ...extra,
      });
      response = await ctx.api("POST", "/api/schedules", {
        body: scheduleBody({ profile: missingProfile }),
      });
      expectStatus(response, [400], "a schedule with an unknown profile");
      response = await ctx.api("POST", "/api/schedules", {
        body: scheduleBody({ modelGroup: missingGroup }),
      });
      expectStatus(response, [400], "a schedule with an unknown model group");
      response = await ctx.api("POST", "/api/schedules", { body: scheduleBody({ profile }) });
      expectStatus(response, [201], "a schedule with a real profile");
      scheduleId = asString(asRecord(response.json).id, "schedule id");
      expect(scheduleRow(ctx, scheduleId)?.profile === profile, "the schedule stores its profile");

      response = await ctx.api("PATCH", `/api/schedules/${scheduleId}`, {
        body: { profile: missingProfile },
      });
      expectStatus(response, [400], "patch a schedule to an unknown profile");
      response = await ctx.api("PATCH", `/api/schedules/${scheduleId}`, {
        body: { modelGroup: missingGroup },
      });
      expectStatus(response, [400], "patch a schedule to an unknown model group");
      expect(
        scheduleRow(ctx, scheduleId)?.profile === profile,
        "a refused schedule update keeps the old profile",
      );
      response = await ctx.api("PATCH", `/api/schedules/${scheduleId}`, {
        body: { modelGroup: group },
      });
      expectStatus(response, [200], "patch a schedule to a real group");
      const moved = scheduleRow(ctx, scheduleId);
      expect(
        moved?.modelGroup === group && moved.profile === null,
        `the schedule now names the group: ${JSON.stringify(moved)}`,
      );

      // ── an agent's default profile exists ──────────────────────────────────
      const setDefault = (value: string) =>
        ctx.api("PUT", "/api/config", {
          body: { scope: "agent", scopeId: workerId, key: "MODEL_PROFILE", value, isSecret: false },
        });
      response = await setDefault(missingProfile);
      expectStatus(response, [400], "an agent default naming an unknown profile");
      expect(agentDefault(ctx, workerId) === null, "a refused default writes no row");
      response = await setDefault(profile);
      expectStatus(response, [200], "an agent default naming a real profile");
      configId = asString(asRecord(response.json).id, "config id");
      expect(agentDefault(ctx, workerId) === profile, "the default is stored");
      response = await setDefault(missingProfile);
      expectStatus(response, [400], "change the default to an unknown profile");
      expect(agentDefault(ctx, workerId) === profile, "a refused change keeps the old default");
    } finally {
      if (configId) await ctx.api("DELETE", `/api/config/${configId}`);
      if (scheduleId) await ctx.api("DELETE", `/api/schedules/${scheduleId}`);
      for (const id of taskIds) {
        await ctx.api("POST", `/api/tasks/${id}/cancel`, { body: { reason: "trigger cleanup" } });
      }
      await ctx.api("DELETE", `/api/model-groups/${group}`);
      await ctx.api("DELETE", `/api/model-profiles/${profile}`);
      await ctx.api("POST", "/close", { agentId: workerId, body: {} });
    }
  },
};
