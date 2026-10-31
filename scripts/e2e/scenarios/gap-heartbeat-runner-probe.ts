import { asRecord, expect, expectStatus, pollUntil } from "../http";
import { SkipError } from "../report";
import type { Scenario } from "../run";

// PR #2447: the heartbeat checklist gate probes the script runner first. An unhealthy runner
// forces a wake (tag heartbeat-gate:wake, reason script-runner-unhealthy) and skips the saved
// gate script. Run twice, same flags except the executor:
//   GAP_RUNNER=healthy   bun scripts/e2e/run.ts --only gap-heartbeat-runner-probe \
//     --sut-env HEARTBEAT_CHECKLIST_DISABLE=false --sut-env HEARTBEAT_CHECKLIST_INTERVAL_MS=3000 \
//     --sut-env HEARTBEAT_CHECKLIST_GATE_SCRIPT=gap-quiet-gate --sut-env HEARTBEAT_CHECKLIST_GATE_MODE=enforce
//   GAP_RUNNER=unhealthy ... plus --sut-env SCRIPT_EXECUTOR=gap-broken   (the executor cannot resolve)
export const gapHeartbeatRunnerProbe: Scenario = {
  name: "gap-heartbeat-runner-probe",
  order: 1030,
  async run(ctx) {
    const mode = process.env.GAP_RUNNER;
    if (mode !== "healthy" && mode !== "unhealthy") {
      throw new SkipError("set GAP_RUNNER=healthy|unhealthy and the SUT env in the file header");
    }
    const lead = await ctx.api("POST", "/api/agents", {
      body: { name: `gap-hb-lead-${ctx.nonce}`, isLead: true },
    });
    expectStatus(lead, [201], "register lead");
    const leadId = String(asRecord(lead.json).id);
    // A global gate that always says quiet. Healthy runner + enforce => the tick is skipped.
    const upsert = await ctx.api("POST", "/api/scripts/upsert", {
      agentId: leadId,
      body: {
        name: "gap-quiet-gate",
        scope: "global",
        description: "E2E gate: always quiet",
        intent: "Prove the runner probe, not the saved gate, decides the verdict",
        source: "export default async function () { return { quiet: true, reason: 'gap quiet' }; }",
      },
    });
    expectStatus(upsert, [200, 201], "upsert quiet gate");
    expectStatus(
      await ctx.api("PUT", `/api/agents/${leadId}/profile`, {
        body: { heartbeatMd: "# Heartbeat\n- check that the swarm is healthy\n" },
      }),
      [200],
      "set HEARTBEAT.md",
    );

    const taskRow = () =>
      ctx.db.get<{ tags: string }>(
        "SELECT tags FROM agent_tasks WHERE agentId = ? AND taskType = 'heartbeat-checklist' LIMIT 1",
        [leadId],
      );
    if (mode === "healthy") {
      // Several 3s ticks pass; the quiet gate must keep skipping them.
      await Bun.sleep(12_000);
      expect(
        taskRow() == null,
        `healthy runner + quiet gate must skip the tick: ${taskRow()?.tags}`,
      );
      // Positive control: shadow mode creates the task and tags the quiet verdict.
      expectStatus(
        await ctx.api("PUT", "/api/config", {
          body: {
            scope: "global",
            scopeId: null,
            key: "HEARTBEAT_CHECKLIST_GATE_MODE",
            value: "shadow",
            isSecret: false,
          },
        }),
        [200],
        "switch the gate to shadow",
      );
      const seen = await pollUntil(() => taskRow() != null, 30_000);
      expect(seen, "shadow mode never created a checklist task");
      const tag = /heartbeat-gate:(\w+)/.exec(taskRow()?.tags ?? "")?.[1];
      expect(tag === "quiet", `healthy gate verdict should be quiet, got ${String(tag)}`);
      return;
    }
    const created = await pollUntil(() => taskRow() != null, 40_000);
    expect(created, "no heartbeat-checklist task was created within 40s");
    const tag = /heartbeat-gate:(\w+)/.exec(taskRow()?.tags ?? "")?.[1];
    ctx.log(`gap-heartbeat-runner-probe (unhealthy): checklist tags ${taskRow()?.tags}`);
    expect(tag === "wake", `unhealthy runner should wake the gate, got ${String(tag)}`);
  },
};
