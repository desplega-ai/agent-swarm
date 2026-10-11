import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  spyOn,
  test,
} from "bun:test";
import {
  assignUnassignedTaskPending,
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
import { isInTransaction } from "../be/db-client";
import { upsertRuntimeInstance } from "../be/multi-runtime";
import {
  createPoolAgent,
  createRuntimeController,
  createRuntimePool,
  updateRuntimePool,
} from "../be/runtime-pools/db";
import { routePoolTasks, startPoolRouting, stopPoolRouting } from "../be/runtime-pools/routing";
import { validateConfigValue } from "../be/swarm-config-guard";
import { codeLevelTriage } from "../heartbeat/heartbeat";
import type { Agent, RuntimePool } from "../types";
import { workflowEventBus } from "../workflows/event-bus";

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
  pool = await createRuntimePool({
    name: "coders",
    kind: "docker",
    placements: [controller.id],
    image: "test-worker",
  });
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

async function createAfterEventDelivery(options: Parameters<typeof createTaskExtended>[1] = {}) {
  const emitted = Promise.withResolvers<void>();
  const onCreated = () => emitted.resolve();
  workflowEventBus.on("task.created", onCreated);
  try {
    const task = await createTaskExtended("event sentinel", options);
    await emitted.promise;
    return task;
  } finally {
    workflowEventBus.off("task.created", onCreated);
  }
}

describe("server pool routing", () => {
  test.each([
    "RUNTIME_WAKE_GRACE_SEC",
    "RUNTIME_WAKE_REROUTE_SEC",
    "RUNTIME_ROUTING_INTERVAL_MS",
  ])("%s validates nonnegative integers", (key) => {
    for (const value of ["0", "5000"]) expect(validateConfigValue(key, value)).toBeNull();
    for (const value of ["-1", "0.5", "invalid"])
      expect(validateConfigValue(key, value)).not.toBeNull();
  });
  test.each(["release", "reject"])("flag off suppresses %s routing events", async (action) => {
    process.env.RUNTIME_POOLS_ENABLED = "false";
    const holder = await sleeper();
    const task = await createAfterEventDelivery(
      action === "release" ? { agentId: holder.id } : { offeredTo: holder.id },
    );
    const events = spyOn(workflowEventBus, "emit");
    try {
      if (action === "release") await releaseTask(task.id);
      else await rejectTask(task.id, holder.id);
      // A creation event proves preceding post-commit event callbacks have completed.
      await createAfterEventDelivery({ offeredTo: holder.id });
      expect(events.mock.calls.filter(([event]) => event === "task.unassigned")).toHaveLength(0);
    } finally {
      events.mockRestore();
    }
  });
  test("assignment CAS rejects changed snapshots", async () => {
    const agent = await sleeper();
    const task = await createTaskExtended("pool work");
    await updateAgentProfile(agent.id, { role: "changed" });
    await getDbClient().run("UPDATE agents SET lastUpdatedAt = ? WHERE id = ?", [
      "changed",
      agent.id,
    ]);
    expect(
      await assignUnassignedTaskPending(task.id, agent.id, { routingSnapshot: { task, agent } }),
    ).toBeNull();
    expect((await getTaskById(task.id))?.status).toBe("unassigned");
  });
  test("wake release CAS preserves work claimed after its snapshot", async () => {
    const agent = await sleeper();
    const task = await createTaskExtended("pool work");
    await routePoolTasks({ taskIds: [task.id], now: afterGrace(task) });
    const snapshot = await getTaskById(task.id);
    expect(snapshot?.agentId).toBe(agent.id);
    await startTask(task.id);
    expect(await releaseTask(task.id, snapshot!)).toBeNull();
    expect((await getTaskById(task.id))?.status).toBe("in_progress");
  });
  test("pools require multi-runtime and warn once at startup", async () => {
    process.env.MULTI_RUNTIME_ENABLED = "false";
    await sleeper();
    await live("busy", 2);
    const task = await createTaskExtended("pool work");
    expect(await routePoolTasks({ now: afterGrace(task) })).toEqual([]);
    const idle = await createAgent({ name: "legacy", isLead: false, status: "idle" });
    expect(await routePoolTasks()).toEqual([{ taskId: task.id, agentId: idle.id }]);
    const warning = spyOn(console, "warn").mockImplementation(() => {});
    try {
      startPoolRouting();
      startPoolRouting();
      expect(warning).toHaveBeenCalledTimes(1);
      expect(warning.mock.calls[0]?.[0]).toContain("MULTI_RUNTIME_ENABLED");
    } finally {
      warning.mockRestore();
    }
  });
  test("listeners route when the flag is enabled after startup", async () => {
    process.env.RUNTIME_POOLS_ENABLED = "false";
    const warm = await live();
    startPoolRouting();
    process.env.RUNTIME_POOLS_ENABLED = "true";
    const task = await createTaskExtended("enabled later");
    await waitForAssignment(task.id, warm.id);
  });
  test.each([
    ["0", 5000],
    ["-1", 5000],
    ["20", 500],
    ["750", 750],
  ] as const)("interval %s uses %d milliseconds", (configured, expected) => {
    process.env.RUNTIME_ROUTING_INTERVAL_MS = configured;
    const interval = spyOn(globalThis, "setInterval");
    try {
      startPoolRouting();
      expect(interval.mock.calls[0]?.[1]).toBe(expected);
    } finally {
      stopPoolRouting();
      interval.mockRestore();
    }
  });
  test("targeted routing reads snapshots outside a write transaction and skips releases", async () => {
    const sleeping = await sleeper("sleeping", 2);
    const held = await createTaskExtended("wake");
    const at = afterGrace(held);
    await routePoolTasks({ taskIds: [held.id], now: at });
    const task = await createTaskExtended("targeted");
    const client = getDbClient();
    const query = client.query.bind(client);
    const reads = spyOn(client, "query").mockImplementation(async (sql, params) => {
      if (isInTransaction()) expect(sql).toContain("SELECT r.agent_id");
      expect(sql).not.toContain("pool_wake_at IS NOT NULL");
      return await query(sql, params);
    });
    try {
      await routePoolTasks({ taskIds: [task.id], now: new Date(at.getTime() + 600001) });
      expect(await getTaskById(held.id)).toMatchObject({
        agentId: sleeping.id,
        poolWakeAt: at.toISOString(),
      });
      expect(reads).toHaveBeenCalled();
    } finally {
      reads.mockRestore();
    }
  });
  test("tier 1 wins over a wakeable agent after grace", async () => {
    await sleeper();
    const warm = await live();
    const task = await createTaskExtended("pool work");
    expect(await routePoolTasks({ now: afterGrace(task) })).toEqual([
      { taskId: task.id, agentId: warm.id },
    ]);
    expect((await getTaskById(task.id))?.poolWakeAt).toBeUndefined();
  });
  test.each([
    "disabled",
    "draining",
    "credentials",
    "offline",
    "stale",
  ])("tier 1 rejects a %s runtime or pool and marks the alternative wake", async (reason) => {
    const first = await sleeper("A");
    const runtime = await upsertRuntimeInstance({
      id: crypto.randomUUID(),
      agentId: first.id,
      reportedSlots: 1,
    });
    await getDbClient().run("UPDATE agents SET status = 'idle' WHERE id = ?", [first.id]);
    if (reason === "disabled") await updateRuntimePool(pool.id, { enabled: false });
    if (reason === "draining")
      await getDbClient().run("UPDATE runtime_instances SET draining = 1 WHERE id = ?", [
        runtime!.id,
      ]);
    if (reason === "credentials")
      await getDbClient().run("UPDATE runtime_instances SET credential_ready = 0 WHERE id = ?", [
        runtime!.id,
      ]);
    if (reason === "offline")
      await getDbClient().run("UPDATE runtime_instances SET status = 'offline' WHERE id = ?", [
        runtime!.id,
      ]);
    if (reason === "stale")
      await getDbClient().run("UPDATE runtime_instances SET last_seen_at = ? WHERE id = ?", [
        new Date(Date.now() - 3600000).toISOString(),
        runtime!.id,
      ]);
    const alternativePool = await createRuntimePool({
      name: "alternative",
      kind: "docker",
      placements: pool.placements,
      image: "test-worker",
    });
    const second = await createPoolAgent(alternativePool.id, { name: "B", maxTasks: 2 });
    const task = await createTaskExtended("pool work");
    const now = afterGrace(task);
    await routePoolTasks({ now });
    expect(await getTaskById(task.id)).toMatchObject({
      status: "pending",
      agentId: second.id,
      poolWakeAt: now.toISOString(),
    });
  });
  test("tier 1 reserves physical runtime slots across pending assignments", async () => {
    const warm = await live("idle", 3);
    await getDbClient().run("UPDATE runtime_instances SET reported_slots = 1 WHERE agent_id = ?", [
      warm.id,
    ]);
    const first = await createTaskExtended("first");
    const second = await createTaskExtended("second");
    expect(await routePoolTasks()).toEqual([{ taskId: first.id, agentId: warm.id }]);
    expect((await getTaskById(second.id))?.status).toBe("unassigned");
  });
  test("concurrent tier 1 routing reserves the last physical slot once", async () => {
    const warm = await live("idle", 3);
    await getDbClient().run("UPDATE runtime_instances SET reported_slots = 1 WHERE agent_id = ?", [
      warm.id,
    ]);
    const first = await createTaskExtended("first");
    const second = await createTaskExtended("second");
    const assignments = await Promise.all([
      routePoolTasks({ taskIds: [first.id] }),
      routePoolTasks({ taskIds: [second.id] }),
    ]);
    expect(assignments.flat()).toHaveLength(1);
  });
  test("tier 1 requires an unoccupied runtime slot despite logical headroom", async () => {
    const warm = await live("busy", 3);
    const runtime = await getDbClient().get<{ id: string }>(
      "SELECT id FROM runtime_instances WHERE agent_id = ?",
      [warm.id],
    );
    await getDbClient().run("UPDATE runtime_instances SET reported_slots = 1 WHERE id = ?", [
      runtime!.id,
    ]);
    const active = await createTaskExtended("active", { agentId: warm.id });
    await startTask(active.id);
    await getDbClient().run(
      "INSERT INTO active_sessions (id, agentId, taskId, triggerType, runtimeInstanceId) VALUES (?, ?, ?, 'task_assigned', ?)",
      [crypto.randomUUID(), warm.id, active.id, runtime!.id],
    );
    const task = await createTaskExtended("queued");
    expect(await routePoolTasks()).toEqual([]);
    expect((await getTaskById(task.id))?.status).toBe("unassigned");
  });
  test.each([
    "disabled",
    "unbound",
    "missing",
    "static",
  ])("reroutes an unmarked pending task when its pool becomes %s", async (reason) => {
    const holder = await sleeper("holder", 3);
    const runtime = await upsertRuntimeInstance({
      id: crypto.randomUUID(),
      agentId: holder.id,
      reportedSlots: 3,
    });
    await getDbClient().run("UPDATE runtime_instances SET pool_id = ? WHERE id = ?", [
      pool.id,
      runtime!.id,
    ]);
    await getDbClient().run("UPDATE agents SET status = 'idle' WHERE id = ?", [holder.id]);
    const task = await createTaskExtended("pool work");
    await routePoolTasks({ taskIds: [task.id] });
    expect((await getTaskById(task.id))?.agentId).toBe(holder.id);
    expect((await getTaskById(task.id))?.poolWakeAt).toBeUndefined();
    const human = await createTaskExtended("human pin", {
      agentId: holder.id,
      routingReason: "human_pinned",
    });
    await getDbClient().run("UPDATE runtime_instances SET draining = 1 WHERE id = ?", [
      runtime!.id,
    ]);
    if (reason === "disabled") await updateRuntimePool(pool.id, { enabled: false });
    if (reason === "unbound")
      await getDbClient().run("UPDATE agents SET runtime_pool_id = NULL WHERE id = ?", [holder.id]);
    if (reason === "missing")
      await getDbClient().run("DELETE FROM runtime_pools WHERE id = ?", [pool.id]);
    if (reason === "static")
      await getDbClient().run("UPDATE runtime_pools SET kind = 'static' WHERE id = ?", [pool.id]);
    const warm = await live();
    expect(await routePoolTasks()).toEqual([{ taskId: task.id, agentId: warm.id }]);
    expect(await getTaskById(human.id)).toMatchObject({ status: "pending", agentId: holder.id });
  });
  test("unmarked pending release CAS preserves a concurrent claim", async () => {
    const holder = await sleeper();
    const task = await createTaskExtended("pending", { agentId: holder.id });
    await updateRuntimePool(pool.id, { enabled: false });
    const client = getDbClient();
    const run = client.run.bind(client);
    const writes = spyOn(client, "run").mockImplementation(async (sql, params) => {
      if (sql.includes("UPDATE agent_tasks SET agentId = NULL")) await startTask(task.id);
      return await run(sql, params);
    });
    try {
      await live();
      await routePoolTasks();
      expect(await getTaskById(task.id)).toMatchObject({
        status: "in_progress",
        agentId: holder.id,
      });
      expect(
        writes.mock.calls.some(([sql]) => sql.includes("UPDATE agent_tasks SET agentId = NULL")),
      ).toBe(true);
    } finally {
      writes.mockRestore();
    }
  });
  test.each([
    "sleeping",
    "per-task",
    "backoff",
  ])("preserves explicit pending demand on a wakeable %s agent", async (state) => {
    const holder = await sleeper();
    if (state === "per-task") {
      await updateRuntimePool(pool.id, { lifecycle: "per-task" });
      const completed = await createTaskExtended("previous", { agentId: holder.id });
      await getDbClient().run("UPDATE agent_tasks SET status = 'completed' WHERE id = ?", [
        completed.id,
      ]);
      const runtime = await upsertRuntimeInstance({
        id: crypto.randomUUID(),
        agentId: holder.id,
        reportedSlots: 1,
      });
      await getDbClient().run(
        "UPDATE runtime_instances SET task_id = ?, pool_id = ? WHERE id = ?",
        [completed.id, pool.id, runtime!.id],
      );
    }
    if (state === "backoff")
      await getDbClient().run(
        "UPDATE agents SET runtime_provision_attempts = 1, runtime_provision_retry_at = ? WHERE id = ?",
        [new Date(Date.now() + 60000).toISOString(), holder.id],
      );
    const task = await createTaskExtended("explicit demand", {
      agentId: holder.id,
      routingReason: "skill",
    });
    await live();
    expect(await routePoolTasks()).toEqual([]);
    expect(await getTaskById(task.id)).toMatchObject({
      status: "pending",
      agentId: holder.id,
      routingReason: "skill",
    });
    expect((await getTaskById(task.id))?.poolWakeAt).toBeUndefined();
  });
  test.each(["zero-capacity", "missing-image"])("tier 2 skips a %s pool", async (state) => {
    await sleeper();
    // The API now rejects imageless pools; raw SQL models a row saved before that check.
    if (state === "zero-capacity") await updateRuntimePool(pool.id, { maxRuntimes: 0 });
    else
      await getDbClient().run(
        "UPDATE runtime_pools SET image = NULL, resolved_image = NULL WHERE id = ?",
        [pool.id],
      );
    const task = await createTaskExtended("pool work");
    expect(await routePoolTasks({ now: afterGrace(task) })).toEqual([]);
    expect((await getTaskById(task.id))?.status).toBe("unassigned");
  });
  test.each([
    true,
    false,
  ])("unmarked pending provisioning stays assigned with pools enabled=%s", async (enabled) => {
    const holder = await sleeper();
    const task = await createTaskExtended("pending", { agentId: holder.id });
    await getDbClient().run(
      "INSERT INTO runtime_instances (id, agent_id, pool_id, status, reported_slots) VALUES (?, ?, ?, 'provisioning', 1)",
      [crypto.randomUUID(), holder.id, pool.id],
    );
    await live();
    process.env.RUNTIME_POOLS_ENABLED = String(enabled);
    expect(await routePoolTasks()).toEqual([]);
    expect(await getTaskById(task.id)).toMatchObject({ status: "pending", agentId: holder.id });
  });
  test("flag off preserves unmarked assignments without a runtime", async () => {
    const holder = await sleeper();
    const task = await createTaskExtended("pending", { agentId: holder.id });
    await live();
    process.env.RUNTIME_POOLS_ENABLED = "false";
    expect(await routePoolTasks()).toEqual([]);
    expect(await getTaskById(task.id)).toMatchObject({ status: "pending", agentId: holder.id });
  });
  test("flag off retains the legacy runtime eligibility check", async () => {
    const warm = await live("idle", 3);
    await getDbClient().run(
      "UPDATE runtime_instances SET draining = 1, credential_ready = 0, reported_slots = 1 WHERE agent_id = ?",
      [warm.id],
    );
    process.env.RUNTIME_POOLS_ENABLED = "false";
    const first = await createTaskExtended("first");
    const second = await createTaskExtended("second");
    expect(await routePoolTasks()).toEqual([
      { taskId: first.id, agentId: warm.id },
      { taskId: second.id, agentId: warm.id },
    ]);
  });
  test("unmarked pending work waits for an occupied eligible runtime", async () => {
    const holder = await sleeper("holder", 2);
    const runtime = await upsertRuntimeInstance({
      id: crypto.randomUUID(),
      agentId: holder.id,
      reportedSlots: 1,
    });
    await getDbClient().run("UPDATE agents SET status = 'busy' WHERE id = ?", [holder.id]);
    const active = await createTaskExtended("active", { agentId: holder.id });
    await startTask(active.id);
    await getDbClient().run("UPDATE runtime_instances SET task_id = ? WHERE id = ?", [
      active.id,
      runtime!.id,
    ]);
    const pending = await createTaskExtended("waiting", { agentId: holder.id });
    await live();
    expect(await routePoolTasks()).toEqual([]);
    expect(await getTaskById(pending.id)).toMatchObject({ status: "pending", agentId: holder.id });
  });
  test("tier 1 keeps healthy runtimes eligible while their pool circuit is open", async () => {
    const agent = await sleeper();
    await upsertRuntimeInstance({ id: crypto.randomUUID(), agentId: agent.id, reportedSlots: 1 });
    await getDbClient().run("UPDATE agents SET status = 'idle' WHERE id = ?", [agent.id]);
    await getDbClient().run("UPDATE runtime_pools SET circuit_open_until = ? WHERE id = ?", [
      new Date(Date.now() + 60000).toISOString(),
      pool.id,
    ]);
    const task = await createTaskExtended("pool work");
    expect(await routePoolTasks()).toEqual([{ taskId: task.id, agentId: agent.id }]);
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
  test("agent A refused, agent B allowed", async () => {
    const a = await sleeper("A");
    const b = await sleeper("B");
    await upsertBudget("agent", a.id, 0);
    const task = await createTaskExtended("pool work");
    expect(await routePoolTasks({ now: afterGrace(task) })).toEqual([
      { taskId: task.id, agentId: b.id },
    ]);
  });
  test("timeout chooses another sleeping agent without a warm agent", async () => {
    const first = await sleeper("A");
    const second = await sleeper("B");
    const task = await createTaskExtended("pool work");
    const at = afterGrace(task);
    await routePoolTasks({ now: at });
    expect((await getTaskById(task.id))?.agentId).toBe(first.id);
    await routePoolTasks({ now: new Date(at.getTime() + 600001) });
    expect((await getTaskById(task.id))?.agentId).toBe(second.id);
  });
  test("timeout cannot retry the old agent when the alternative refuses budget", async () => {
    await sleeper("A");
    const other = await sleeper("B");
    const task = await createTaskExtended("pool work");
    const at = afterGrace(task);
    await routePoolTasks({ now: at });
    await upsertBudget("agent", other.id, 0);
    expect(await routePoolTasks({ now: new Date(at.getTime() + 600001) })).toEqual([]);
    expect((await getTaskById(task.id))?.status).toBe("unassigned");
  });
  test.each([
    false,
    true,
  ])("sole sleeping candidate retries only with a closed circuit (open=%s)", async (open) => {
    const sleeping = await sleeper();
    const task = await createTaskExtended("pool work");
    const at = afterGrace(task);
    await routePoolTasks({ now: at });
    const now = new Date(at.getTime() + 600001);
    if (open)
      await getDbClient().run("UPDATE runtime_pools SET circuit_open_until = ?", [
        new Date(now.getTime() + 60000).toISOString(),
      ]);
    await routePoolTasks({ now });
    expect(await getTaskById(task.id)).toMatchObject(
      open
        ? { status: "unassigned" }
        : { status: "pending", agentId: sleeping.id, poolWakeAt: now.toISOString() },
    );
  });
  test("selects most headroom and breaks ties by name, reserving pending slots", async () => {
    const beta = await sleeper("beta", 3);
    const alpha = await sleeper("alpha", 3);
    await sleeper("small", 1);
    await createTaskExtended("reserved", { agentId: beta.id, routingReason: "human_pinned" });
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
    await createTaskExtended("reserved", { agentId: agent.id, routingReason: "human_pinned" });
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
    expect(await routePoolTasks({ taskIds: [offer.id] })).toEqual([]);
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

        expect((await getTaskById(task.id))?.status).toBe("unassigned");
        throw new Error("rollback");
      }),
    ).rejects.toThrow("rollback");
    expect(await routePoolTasks({ taskIds: [task.id] })).toEqual([]);
    expect((await getTaskById(task.id))?.status).toBe(action === "release" ? "pending" : "offered");
    await mutation();
    await waitForAssignment(task.id, warm.id);
  });
  test("timer routes after grace and stop removes routing triggers", async () => {
    process.env.RUNTIME_WAKE_GRACE_SEC = "0";
    process.env.RUNTIME_ROUTING_INTERVAL_MS = "20";
    const sleeping = await sleeper("sleeping", 2);
    const task = await createAfterEventDelivery();
    startPoolRouting();
    await waitForAssignment(task.id, sleeping.id);
    const off = spyOn(workflowEventBus, "off");
    try {
      stopPoolRouting();
      expect(off.mock.calls.map(([event]) => event)).toEqual(["task.created", "task.unassigned"]);
    } finally {
      off.mockRestore();
    }
    const later = await createTaskExtended("after stop");

    expect((await getTaskById(later.id))?.status).toBe("unassigned");
  });
});
