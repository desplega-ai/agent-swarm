import { asRecord, asRecords, asString, expect, expectStatus } from "../http";
import type { Scenario } from "../run";
import { getLead, registerAgent, upsertScript } from "./script-helpers";
import { setGlobalConfig } from "./workflow-helpers";

export const scriptScheduleFire: Scenario = {
  name: "script-schedule-fire",
  order: 449,
  async run(ctx) {
    const agentId = await registerAgent(ctx, "schedule-baseline");
    const fixtureOwner = await getLead(ctx);
    const key = `E2E_SCHEDULE_BASELINE_${ctx.nonce.toUpperCase()}`;
    const dropConfig = await setGlobalConfig(ctx, key, crypto.randomUUID(), true);
    const missingId = crypto.randomUUID();
    const name = `schedule-baseline-${ctx.nonce}`;
    await upsertScript(ctx, fixtureOwner, {
      name,
      scope: "global",
      source: `export default async function(args: any, ctx: any) {
        const read = await ctx.swarm.config_get({ key: args.key, includeSecrets: true });
        const rows = read.data.configs;
        const permission = await ctx.swarm.config_delete({ id: args.missingId });
        return { marker: args.marker, agentId: ctx.stdlib.Redacted.value(ctx.swarm.config.agentId),
          status: read.status, count: rows.length, permissionStatus: permission.status,
          secretVisible: rows[0]?.isSecret === true && typeof rows[0].value === "string" && rows[0].value !== "********" };
      }`,
    });
    const schedules: string[] = [];
    try {
      for (const creator of [agentId, undefined]) {
        const marker = `${ctx.nonce}-${creator ?? "operator"}`;
        const created = await ctx.api("POST", "/api/schedules", {
          agentId: creator,
          body: {
            name: `baseline-${marker}`,
            targetType: "script",
            scriptName: name,
            scriptArgs: { key, marker, missingId },
            cronExpression: "0 3 1 1 *",
            enabled: true,
          },
        });
        expectStatus(created, [201], "create script schedule");
        const schedule = asRecord(created.json);
        expect(schedule.createdByAgentId === creator, "schedule creator must match the request");
        const id = asString(schedule.id, "schedule id");
        schedules.push(id);
        expectStatus(
          await ctx.api("POST", `/api/schedules/${id}/run`),
          [200],
          "fire script schedule",
        );
        const listed = await ctx.api("GET", `/api/script-runs?scriptName=${name}`);
        expectStatus(listed, [200], "read scheduled results");
        const runs = asRecords(listed.json, "runs").filter(
          (run) => run.agentId === (creator ?? "schedule"),
        );
        expect(runs.length === 1, "one fire must produce one run");
        const fetched = await ctx.api("GET", `/api/script-runs/${runs[0]!.id}`);
        expectStatus(fetched, [200], "read scheduled run detail");
        const run = asRecord(asRecord(fetched.json).run);
        const result = asRecord(run.output);
        expect(run.status === "completed", `schedule failed: ${JSON.stringify(run)}`);
        expect(run.agentId === (creator ?? "schedule"), "scheduled run identity changed");
        expect(
          result.marker === marker && result.agentId === (creator ?? "schedule"),
          "script result or principal changed",
        );
        expect(
          result.status === 200 && result.count === 1,
          "script must read only the synthetic config",
        );
        expect(
          result.secretVisible === true,
          "the running script must read its own synthetic global setting",
        );
        // A worker must stop at authorization. The operator reaches the missing-row check.
        expect(
          result.permissionStatus === (creator ? 403 : 404),
          "schedule must use its server-assigned principal",
        );
      }
    } finally {
      for (const id of schedules) await ctx.api("DELETE", `/api/schedules/${id}`);
      await ctx.api("DELETE", `/api/scripts/${name}?scope=global`, { agentId: fixtureOwner });
      await dropConfig();
    }
  },
};
