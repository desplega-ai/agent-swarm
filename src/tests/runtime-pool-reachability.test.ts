import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import {
  closeDb,
  createAgent,
  createTaskExtended,
  createUser,
  getDbClient,
  getTaskById,
  initDb,
} from "../be/db";
import {
  createPoolAgent,
  createRuntimeController,
  createRuntimePool,
  updateRuntimePool,
} from "../be/runtime-pools/db";
import { isAgentReachable } from "../be/runtime-pools/reachability";
import { codeLevelTriage, gatherSystemStatus, getBootTriageFindings } from "../heartbeat/heartbeat";
import { routeMessage } from "../slack/router";
import { resolveLeadOnlyRecoveryAssignment } from "../tasks/worker-follow-up";
import { sendTaskHandler } from "../tools/send-task";
import { userCtx } from "../tools/task-tool-ctx";
import type { RuntimePool } from "../types";

const dbPath = "./test-runtime-pool-reachability.sqlite";
const savedFlag = process.env.RUNTIME_POOLS_ENABLED;
let pool: RuntimePool;
async function cleanup() {
  for (const suffix of ["", "-wal", "-shm"])
    await Bun.file(dbPath + suffix)
      .delete()
      .catch(() => {});
}
beforeAll(async () => {
  await cleanup();
  closeDb();
  initDb(dbPath);
});
afterAll(async () => {
  closeDb();
  await cleanup();
  if (savedFlag === undefined) delete process.env.RUNTIME_POOLS_ENABLED;
  else process.env.RUNTIME_POOLS_ENABLED = savedFlag;
});
beforeEach(async () => {
  process.env.RUNTIME_POOLS_ENABLED = "true";
  for (const table of [
    "active_sessions",
    "agent_tasks",
    "runtime_instances",
    "agents",
    "runtime_pools",
    "runtime_controllers",
  ])
    await getDbClient().run(`DELETE FROM ${table}`);
  const controller = await createRuntimeController({ name: "docker", kind: "docker" });
  pool = await createRuntimePool({ name: "coders", kind: "docker", placements: [controller.id] });
});
async function sleepingLead() {
  return await createPoolAgent(pool.id, { name: "sleeping-lead", isLead: true });
}

describe("pool agent reachability", () => {
  test("online agents remain reachable and unbound offline agents remain unreachable", async () => {
    const agent = await createAgent({ name: "online", status: "idle", isLead: false });
    expect(await isAgentReachable(agent)).toBe(true);
    expect(await isAgentReachable({ ...agent, status: "offline" })).toBe(false);
  });
  test.each([
    "enabled",
    "disabled",
    "open",
    "expired",
    "static",
    "flag-off",
  ])("sleeping agent uses %s pool state", async (state) => {
    const agent = await sleepingLead();
    if (state === "disabled") await updateRuntimePool(pool.id, { enabled: false });
    if (state === "open" || state === "expired")
      await getDbClient().run("UPDATE runtime_pools SET circuit_open_until = ?", [
        new Date(Date.now() + (state === "open" ? 60000 : -60000)).toISOString(),
      ]);
    if (state === "static") await getDbClient().run("UPDATE runtime_pools SET kind = 'static'");
    if (state === "flag-off") process.env.RUNTIME_POOLS_ENABLED = "false";
    expect(await isAgentReachable(agent)).toBe(state === "enabled" || state === "expired");
  });
  test.each([true, false])("user send-task with runtime pools enabled=%s", async (enabled) => {
    process.env.RUNTIME_POOLS_ENABLED = String(enabled);
    const lead = await sleepingLead();
    const user = await createUser({ name: "requester" });
    const result = await sendTaskHandler(userCtx(user), {
      task: "delegate this work",
      offerMode: false,
      allowDuplicate: false,
    });
    expect(result.ok).toBe(enabled);
    if (enabled) {
      const task = (result.data as { task: { id: string } }).task;
      expect(await getTaskById(task.id)).toMatchObject({ status: "pending", agentId: lead.id });
    } else expect(result.message).toContain("No online Lead");
  });
  test.each([true, false])("Slack follow-up with runtime pools enabled=%s", async (enabled) => {
    process.env.RUNTIME_POOLS_ENABLED = String(enabled);
    const lead = await createAgent({ name: "online-lead", isLead: true, status: "idle" });
    const worker = await createPoolAgent(pool.id, { name: "sleeping-worker" });
    await createTaskExtended("thread work", {
      agentId: worker.id,
      source: "slack",
      slackChannelId: "C_REACHABILITY",
      slackThreadTs: "1234.5678",
    });
    const matches = await routeMessage("continue", "BOT", false, {
      channelId: "C_REACHABILITY",
      threadTs: "1234.5678",
    });
    expect(matches.map((match) => match.agent.id)).toEqual([enabled ? worker.id : lead.id]);
  });
  test("Slack fallback and explicit mention can reach a sleeping lead", async () => {
    const lead = await sleepingLead();
    const worker = await createAgent({ name: "gone", isLead: false, status: "offline" });
    await createTaskExtended("thread work", {
      agentId: worker.id,
      source: "slack",
      slackChannelId: "C_REACHABILITY",
      slackThreadTs: "1234.5678",
    });
    expect(
      (
        await routeMessage("continue", "BOT", false, {
          channelId: "C_REACHABILITY",
          threadTs: "1234.5678",
        })
      )[0]?.agent.id,
    ).toBe(lead.id);
    expect((await routeMessage("<@BOT> help", "BOT", true))[0]?.agent.id).toBe(lead.id);
  });
  test.each([true, false])("Lead-only recovery with runtime pools enabled=%s", async (enabled) => {
    process.env.RUNTIME_POOLS_ENABLED = String(enabled);
    const lead = await sleepingLead();
    const result = await resolveLeadOnlyRecoveryAssignment(
      { routingAffinity: { leadOnly: true, capabilities: [] } },
      null,
    );
    expect(result).toEqual(
      enabled
        ? { agentId: lead.id, decision: "rerouted_to_lead" }
        : { decision: "escalated_unassigned" },
    );
  });
  test.each([
    true,
    false,
  ])("stale resume escalation with runtime pools enabled=%s", async (enabled) => {
    process.env.RUNTIME_POOLS_ENABLED = String(enabled);
    const lead = await sleepingLead();
    const worker = await createAgent({ name: "gone", isLead: false, status: "offline" });
    const original = await createTaskExtended("original", { agentId: worker.id });
    await getDbClient().run(
      "UPDATE agent_tasks SET status = 'superseded', finishedAt = ? WHERE id = ?",
      [new Date().toISOString(), original.id],
    );
    const resume = await createTaskExtended("resume", {
      agentId: worker.id,
      parentTaskId: original.id,
      taskType: "resume",
      tags: ["crash-recovery-pin", "resume-generation:1"],
    });
    await getDbClient().run("UPDATE agent_tasks SET createdAt = ? WHERE id = ?", [
      new Date(Date.now() - 3600000).toISOString(),
      resume.id,
    ]);
    await codeLevelTriage();
    expect((await getTaskById(resume.id))?.status).toBe(enabled ? "cancelled" : "pending");
    const decisions = await getDbClient().query<{ agentId: string }>(
      "SELECT agentId FROM agent_tasks WHERE taskType = 'reroute-decision'",
    );
    expect(decisions).toEqual(enabled ? [{ agentId: lead.id }] : []);
  });
  test.each([
    true,
    false,
  ])("boot triage excludes reachable pool tasks with flag=%s", async (enabled) => {
    process.env.RUNTIME_POOLS_ENABLED = String(enabled);
    const worker = await createPoolAgent(pool.id, { name: "sleeping-worker" });
    await createTaskExtended("wake demand", { agentId: worker.id });
    await createTaskExtended("offered demand", { offeredTo: worker.id });
    expect((await getBootTriageFindings()).orphaned).toBe(enabled ? 0 : 2);
    expect((await gatherSystemStatus({ isBootTriage: true })).includes("Orphaned Tasks")).toBe(
      !enabled,
    );
  });
});
