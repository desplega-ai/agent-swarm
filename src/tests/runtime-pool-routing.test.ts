import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import {
  closeDb,
  createAgent,
  createTaskExtended,
  createUser,
  getDbClient,
  getTaskById,
  initDb,
  MAX_EMPTY_POLLS,
  rejectTask,
  releaseTask,
  startTask,
  updateAgentProfile,
  upsertBudget,
} from "../be/db";
import { upsertRuntimeInstance } from "../be/multi-runtime";
import {
  createPoolAgent,
  createRuntimeController,
  createRuntimePool,
  updateRuntimePool,
} from "../be/runtime-pools/db";
import { routePoolTasks, startPoolRouting, stopPoolRouting } from "../be/runtime-pools/routing";
import { codeLevelTriage } from "../heartbeat/heartbeat";
import type { Agent, RuntimePool } from "../types";

const dbPath = "./test-runtime-pool-routing.sqlite";
const envKeys = [
  "RUNTIME_POOLS_ENABLED",
  "RUNTIME_WAKE_GRACE_SEC",
  "RUNTIME_WAKE_REROUTE_SEC",
  "RUNTIME_ROUTING_INTERVAL_MS",
  "MULTI_RUNTIME_ENABLED",
  "POOL_AFFINITY_ENFORCEMENT",
  "BUDGET_ADMISSION_DISABLED",
  "HEARTBEAT_MAX_AUTO_ASSIGN",
];
const savedEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
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
  stopPoolRouting();
  closeDb();
  await cleanup();
  for (const key of envKeys) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});
afterEach(() => stopPoolRouting());
beforeEach(async () => {
  process.env.RUNTIME_POOLS_ENABLED = "true";
  process.env.RUNTIME_WAKE_GRACE_SEC = "15";
  process.env.RUNTIME_WAKE_REROUTE_SEC = "600";
  process.env.RUNTIME_ROUTING_INTERVAL_MS = "60000";
  process.env.MULTI_RUNTIME_ENABLED = "true";
  process.env.POOL_AFFINITY_ENFORCEMENT = "true";
  process.env.BUDGET_ADMISSION_DISABLED = "false";
  process.env.HEARTBEAT_MAX_AUTO_ASSIGN = "5";
  for (const table of [
    "active_sessions",
    "agent_tasks",
    "runtime_instances",
    "agents",
    "runtime_pools",
    "runtime_controllers",
    "budgets",
  ])
    await getDbClient().run(`DELETE FROM ${table}`);
  const controller = await createRuntimeController({ name: "docker", kind: "docker" });
  pool = await createRuntimePool({ name: "coders", kind: "docker", placements: [controller.id] });
});
async function sleeper(name = "sleeping", maxTasks = 1) {
  return await createPoolAgent(pool.id, { name, maxTasks });
}
async function live(status: Agent["status"] = "idle", maxTasks = 1) {
  const agent = await createAgent({ name: "live", isLead: false, status, maxTasks });
  await upsertRuntimeInstance({
    id: crypto.randomUUID(),
    agentId: agent.id,
    reportedSlots: maxTasks,
  });
  return agent;
}
function afterGrace(task: { createdAt: string }) {
  return new Date(Date.parse(task.createdAt) + 16000);
}
async function waitForAssignment(id: string, agentId: string) {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    const task = await getTaskById(id);
    if (task?.status === "pending" && task.agentId === agentId) return;
    await Bun.sleep(10);
  }
  expect(await getTaskById(id)).toMatchObject({ status: "pending", agentId });
}

describe("server pool routing", () => {
  test("tier 1 wins over a wakeable agent after grace", async () => {
    await sleeper();
    const warm = await live();
    const task = await createTaskExtended("pool work");
    expect(await routePoolTasks({ now: afterGrace(task) })).toEqual([
      { taskId: task.id, agentId: warm.id },
    ]);
    expect((await getTaskById(task.id))?.poolWakeAt).toBeUndefined();
  });
  test("tier 2 waits for grace and preserves the existing routing reason", async () => {
    const agent = await sleeper();
    const task = await createTaskExtended("pool work");
    expect(await routePoolTasks({ now: new Date(task.createdAt) })).toEqual([]);
    const now = afterGrace(task);
    await routePoolTasks({ now });
    expect(await getTaskById(task.id)).toMatchObject({
      status: "pending",
      agentId: agent.id,
      poolWakeAt: now.toISOString(),
    });
    expect((await getTaskById(task.id))?.routingReason).toBe(task.routingReason);
  });
  test("flag off disables wake and keeps heartbeat idle-worker dispatch", async () => {
    process.env.RUNTIME_POOLS_ENABLED = "false";
    process.env.MULTI_RUNTIME_ENABLED = "false";
    await sleeper();
    const busy = await live("busy", 2);
    const task = await createTaskExtended("pool work");
    await createTaskExtended("active", { agentId: busy.id }).then((t) => startTask(t.id));
    expect(await routePoolTasks({ now: afterGrace(task) })).toEqual([]);
    const idle = await createAgent({ name: "legacy", isLead: false, status: "idle" });
    const findings = await codeLevelTriage();
    expect(findings.autoAssigned).toContainEqual({ taskId: task.id, agentId: idle.id });
  });
  test("legacy empty-poll and runtime gates remain effective", async () => {
    process.env.RUNTIME_POOLS_ENABLED = "false";
    const warm = await live();
    const task = await createTaskExtended("pool work");
    await getDbClient().run("UPDATE agents SET emptyPollCount = ? WHERE id = ?", [
      MAX_EMPTY_POLLS,
      warm.id,
    ]);
    expect(await routePoolTasks()).toEqual([]);
    await getDbClient().run("UPDATE agents SET emptyPollCount = 0 WHERE id = ?", [warm.id]);
    await getDbClient().run("UPDATE runtime_instances SET status = 'offline'");
    expect(await routePoolTasks()).toEqual([]);
    process.env.MULTI_RUNTIME_ENABLED = "false";
    expect(await routePoolTasks()).toEqual([{ taskId: task.id, agentId: warm.id }]);
  });
  test("busy live agent with spare capacity wins over wake", async () => {
    await sleeper();
    const warm = await live("busy", 2);
    const active = await createTaskExtended("active", { agentId: warm.id });
    await startTask(active.id);
    const task = await createTaskExtended("pool work");
    await routePoolTasks({ now: afterGrace(task) });
    expect(await getTaskById(task.id)).toMatchObject({ agentId: warm.id, status: "pending" });
    expect((await getTaskById(task.id))?.poolWakeAt).toBeUndefined();
  });
  test("enabled routing uses live capacity despite a legacy empty-poll count", async () => {
    const warm = await live();
    await getDbClient().run("UPDATE agents SET emptyPollCount = ? WHERE id = ?", [
      MAX_EMPTY_POLLS,
      warm.id,
    ]);
    const task = await createTaskExtended("pool work");
    expect(await routePoolTasks()).toEqual([{ taskId: task.id, agentId: warm.id }]);
  });
  test("concurrent routing does not exceed agent headroom", async () => {
    const agent = await sleeper();
    const first = await createTaskExtended("first");
    const second = await createTaskExtended("second");
    const now = afterGrace(second);
    const assignments = await Promise.all([
      routePoolTasks({ taskIds: [first.id], now }),
      routePoolTasks({ taskIds: [second.id], now }),
    ]);
    expect(assignments.flat()).toHaveLength(1);
    expect(assignments.flat()[0]?.agentId).toBe(agent.id);
    const count = await getDbClient().get<{ n: number }>(
      "SELECT COUNT(*) AS n FROM agent_tasks WHERE agentId = ? AND status = 'pending'",
      [agent.id],
    );
    expect(count?.n).toBe(1);
  });
  test("tier 2 applies role and capability affinity", async () => {
    await sleeper("wrong", 3);
    const match = await sleeper("match");
    await updateAgentProfile(match.id, { role: "coder", capabilities: ["git"] });
    const task = await createTaskExtended("pool work", {
      routingAffinity: { role: "coder", capabilities: ["git"], leadOnly: false },
    });
    await routePoolTasks({ now: afterGrace(task) });
    expect((await getTaskById(task.id))?.agentId).toBe(match.id);
    const missing = await createTaskExtended("missing capability", {
      routingAffinity: { capabilities: ["deploy"], leadOnly: false },
    });
    expect(await routePoolTasks({ now: afterGrace(missing) })).toEqual([]);
  });
  test("tier 2 applies pinned-model harness compatibility", async () => {
    await createPoolAgent(pool.id, { name: "codex", harnessProvider: "codex", maxTasks: 3 });
    const claude = await createPoolAgent(pool.id, { name: "claude", harnessProvider: "claude" });
    const task = await createTaskExtended("pool work", { model: "claude-sonnet-4-5" });
    await routePoolTasks({ now: afterGrace(task) });
    expect((await getTaskById(task.id))?.agentId).toBe(claude.id);
  });
  test.each(["disabled", "circuit", "static"])("tier 2 skips %s pools", async (reason) => {
    await sleeper();
    if (reason === "disabled") await updateRuntimePool(pool.id, { enabled: false });
    if (reason === "circuit")
      await getDbClient().run("UPDATE runtime_pools SET circuit_open_until = ?", [
        new Date(Date.now() + 120000).toISOString(),
      ]);
    if (reason === "static") await getDbClient().run("UPDATE runtime_pools SET kind = 'static'");
    const task = await createTaskExtended("pool work");
    expect(await routePoolTasks({ now: afterGrace(task) })).toEqual([]);
    expect((await getTaskById(task.id))?.status).toBe("unassigned");
  });
  test.each([
    "global",
    "agent",
    "user",
  ] as const)("%s budget refusal leaves work unassigned", async (scope) => {
    const agent = await sleeper();
    const user = await createUser({
      email: `budget-routing-${crypto.randomUUID()}@example.com`,
      name: "requester",
    });
    await upsertBudget(scope, scope === "global" ? "" : scope === "agent" ? agent.id : user.id, 0);
    const task = await createTaskExtended("pool work", { requestedByUserId: user.id });
    expect(await routePoolTasks({ now: afterGrace(task) })).toEqual([]);
    expect(await getTaskById(task.id)).toMatchObject({ status: "unassigned" });
  });
  test("selects most headroom and breaks ties by name, reserving pending slots", async () => {
    const beta = await sleeper("beta", 3);
    const alpha = await sleeper("alpha", 3);
    await sleeper("small", 1);
    await createTaskExtended("reserved", { agentId: beta.id });
    const first = await createTaskExtended("first");
    const second = await createTaskExtended("second");
    const third = await createTaskExtended("third");
    await routePoolTasks({ now: afterGrace(third) });
    expect((await getTaskById(first.id))?.agentId).toBe(alpha.id);
    expect((await getTaskById(second.id))?.agentId).toBe(alpha.id);
    expect((await getTaskById(third.id))?.agentId).toBe(beta.id);
  });
  test("leads and agents without headroom never take pool tasks", async () => {
    await createPoolAgent(pool.id, { name: "lead", isLead: true });
    const agent = await sleeper();
    await createTaskExtended("reserved", { agentId: agent.id });
    const task = await createTaskExtended("pool work");
    expect(await routePoolTasks({ now: afterGrace(task) })).toEqual([]);
  });
  test.each([
    "timeout",
    "circuit",
  ])("reroutes marked wakes on %s but preserves human pins", async (reason) => {
    const sleeping = await sleeper();
    const task = await createTaskExtended("pool work");
    const at = afterGrace(task);
    await routePoolTasks({ now: at });
    const human = await createTaskExtended("human pin", {
      agentId: sleeping.id,
      routingReason: "human_pinned",
    });
    const warm = await live();
    if (reason === "circuit")
      await getDbClient().run("UPDATE runtime_pools SET circuit_open_until = ?", [
        new Date(at.getTime() + 1200000).toISOString(),
      ]);
    const now = reason === "timeout" ? new Date(at.getTime() + 600001) : at;
    await routePoolTasks({ now });
    expect(await getTaskById(task.id)).toMatchObject({ status: "pending", agentId: warm.id });
    expect((await getTaskById(task.id))?.poolWakeAt).toBeUndefined();
    expect(await getTaskById(human.id)).toMatchObject({ status: "pending", agentId: sleeping.id });
  });
  test("pending wake stays pinned before timeout", async () => {
    const sleeping = await sleeper();
    const task = await createTaskExtended("pool work");
    const at = afterGrace(task);
    await routePoolTasks({ now: at });
    await live();
    await routePoolTasks({ now: new Date(at.getTime() + 599000) });
    expect((await getTaskById(task.id))?.agentId).toBe(sleeping.id);
  });
  test("creation routes immediately and ignores offered tasks", async () => {
    const warm = await live("idle", 2);
    startPoolRouting();
    const task = await createTaskExtended("pool work");
    await waitForAssignment(task.id, warm.id);
    const offer = await createTaskExtended("offered work", { offeredTo: warm.id });
    await Bun.sleep(30);
    expect((await getTaskById(offer.id))?.status).toBe("offered");
  });
  test.each([
    "release",
    "reject",
  ])("%s routes after commit and suppresses rollback events", async (action) => {
    const holder = await sleeper();
    const warm = await live();
    const task = await createTaskExtended(
      "held",
      action === "release" ? { agentId: holder.id } : { offeredTo: holder.id },
    );
    startPoolRouting();
    const mutation = () =>
      action === "release" ? releaseTask(task.id) : rejectTask(task.id, holder.id);
    await expect(
      getDbClient().transaction(async () => {
        await mutation();
        await Bun.sleep(20);
        expect((await getTaskById(task.id))?.status).toBe("unassigned");
        throw new Error("rollback");
      }),
    ).rejects.toThrow("rollback");
    await Bun.sleep(20);
    expect((await getTaskById(task.id))?.status).toBe(action === "release" ? "pending" : "offered");
    await mutation();
    await waitForAssignment(task.id, warm.id);
  });
  test("timer routes after grace and stop removes routing triggers", async () => {
    process.env.RUNTIME_WAKE_GRACE_SEC = "0";
    process.env.RUNTIME_ROUTING_INTERVAL_MS = "20";
    const sleeping = await sleeper("sleeping", 2);
    const task = await createTaskExtended("before startup");
    startPoolRouting();
    await waitForAssignment(task.id, sleeping.id);
    stopPoolRouting();
    const later = await createTaskExtended("after stop");
    await Bun.sleep(50);
    expect((await getTaskById(later.id))?.status).toBe("unassigned");
  });
});
