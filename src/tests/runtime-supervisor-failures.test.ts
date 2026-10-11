import { expect, spyOn, test } from "bun:test";
import {
  cancelTask,
  closeDb,
  createAgent,
  createTaskExtended,
  getAgentById,
  getDb,
  getDbClient,
  getTaskById,
  initDb,
} from "../be/db";
import * as multiRuntime from "../be/multi-runtime";
import {
  getRuntimeInstanceById,
  listRuntimeInstancesForPool,
  upsertRuntimeInstance,
} from "../be/multi-runtime";
import { createPoolAgent, getRuntimeController, getRuntimePool } from "../be/runtime-pools/db";
import { routePoolTasks } from "../be/runtime-pools/routing";
import { reconcileOnce, stopRuntimeSupervisor } from "../be/runtime-pools/supervisor";
import { validateConfigValue } from "../be/swarm-config-guard";
import * as users from "../be/users";
import { resolveBySessionToken } from "../be/users";
import { runtimeFailureFixture } from "./runtime-pools-test-utils";

const dbPath = "./test-runtime-supervisor-failures.sqlite";
const { state, setup } = runtimeFailureFixture(dbPath);
const later = (now: Date, seconds: number) => new Date(now.getTime() + seconds * 1000);

test("provision errors persist backoff through restart and pruning, then fail the oldest task with a scrubbed Lead follow-up", async () => {
  const lead = await createAgent({ name: "Lead", isLead: true, status: "idle" });
  const { pool, agent, task } = await setup({}, 4);
  const newer = await createTaskExtended("Newer priority task", {
    agentId: agent.id,
    priority: 100,
  });
  const now = new Date();
  const secret = `aseph_${"A".repeat(32)}`;
  state.fake.failure = `Image rejected with ${secret}`;
  await reconcileOnce({ now });
  expect(state.fake.requests).toHaveLength(1);
  expect((await getAgentById(agent.id))?.runtimeProvisionAttempts).toBe(1);
  expect((await getAgentById(agent.id))?.runtimeProvisionRetryAt).toBe(
    later(now, 30).toISOString(),
  );
  expect((await getRuntimePool(pool.id))?.lastError).not.toContain(secret);
  expect((await getRuntimeController(state.controllerId))?.lastError).not.toContain(secret);
  expect((await listRuntimeInstancesForPool(pool.id))[0]?.provisionError).not.toContain(secret);
  await getDbClient().run("DELETE FROM runtime_instances");
  await stopRuntimeSupervisor();
  await Bun.write(dbPath, getDb().serialize());
  const globals = globalThis as typeof globalThis & { __testMigrationTemplate?: Uint8Array };
  const template = globals.__testMigrationTemplate;
  delete globals.__testMigrationTemplate;
  try {
    closeDb();
    initDb(dbPath);
  } finally {
    globals.__testMigrationTemplate = template;
  }
  await reconcileOnce({ now: later(now, 29) });
  expect(state.fake.requests).toHaveLength(1);
  await reconcileOnce({ now: later(now, 30) });
  expect(state.fake.requests).toHaveLength(2);
  expect((await getAgentById(agent.id))?.runtimeProvisionRetryAt).toBe(
    later(now, 120).toISOString(),
  );
  await reconcileOnce({ now: later(now, 119) });
  expect(state.fake.requests).toHaveLength(2);
  await reconcileOnce({ now: later(now, 120) });
  expect(state.fake.requests).toHaveLength(3);
  expect((await getTaskById(task.id))?.status).toBe("failed");
  expect((await getTaskById(task.id))?.failureReason).toStartWith(
    "provisioning failed after 3 attempts:",
  );
  expect((await getTaskById(task.id))?.failureReason).not.toContain(secret);
  expect((await getTaskById(newer.id))?.status).toBe("pending");
  expect((await getAgentById(agent.id))?.runtimeProvisionAttempts).toBe(0);
  expect((await getAgentById(agent.id))?.runtimeProvisionRetryAt).toBeNull();
  const followUp = await getDbClient().get<{ agentId: string }>(
    "SELECT agentId FROM agent_tasks WHERE parentTaskId = ?",
    [task.id],
  );
  expect(followUp?.agentId).toBe(lead.id);
});

test("the third retry waits 180 seconds when more attempts are permitted", async () => {
  process.env.RUNTIME_PROVISION_MAX_ATTEMPTS = "4";
  const { agent } = await setup();
  state.fake.failure = "Bad image";
  const now = new Date();
  for (const seconds of [0, 30, 120]) await reconcileOnce({ now: later(now, seconds) });
  expect((await getAgentById(agent.id))?.runtimeProvisionRetryAt).toBe(
    later(now, 300).toISOString(),
  );
  await reconcileOnce({ now: later(now, 299) });
  expect(state.fake.requests).toHaveLength(3);
});

test("registration timeout counts once, terminates the runtime, and fences the token", async () => {
  const { pool, agent } = await setup();
  const now = new Date();
  await reconcileOnce({ now });
  const runtime = (await listRuntimeInstancesForPool(pool.id))[0]!;
  await reconcileOnce({ now: later(now, 299) });
  expect(state.fake.terminated).toHaveLength(0);
  await reconcileOnce({ now: later(now, 300) });
  expect(state.fake.terminated).toEqual([runtime.externalHandle!.externalId]);
  expect((await getRuntimeInstanceById(runtime.id))?.provisionError).toBe(
    "runtime did not register within 300s (image may lack the swarm runner, or WORKER_API_URL is unreachable)",
  );
  expect((await getAgentById(agent.id))?.runtimeProvisionAttempts).toBe(1);
  expect((await getRuntimePool(pool.id))?.consecutiveFailures).toBe(1);
  expect(await resolveBySessionToken(state.fake.requests[0]!.env.API_KEY!)).toBeNull();
  await reconcileOnce({ now: later(now, 301) });
  expect((await getAgentById(agent.id))?.runtimeProvisionAttempts).toBe(1);
});

test("registration resets persisted agent attempts and pool failures", async () => {
  const { pool, agent } = await setup();
  const now = new Date();
  state.fake.failure = "Bad image";
  await reconcileOnce({ now });
  state.fake.failure = null;
  await reconcileOnce({ now: later(now, 30) });
  const runtime = (await listRuntimeInstancesForPool(pool.id)).find(
    (r) => r.status === "provisioning",
  )!;
  expect(runtime.provisionAttempts).toBe(2);
  await upsertRuntimeInstance({ id: runtime.id, agentId: agent.id, reportedSlots: 1 });
  expect((await getAgentById(agent.id))?.runtimeProvisionAttempts).toBe(0);
  expect((await getAgentById(agent.id))?.runtimeProvisionRetryAt).toBeNull();
  expect((await getRuntimePool(pool.id))?.consecutiveFailures).toBe(0);
});

test("healthy re-registration leaves an open circuit and retry state unchanged", async () => {
  const { pool, agent } = await setup();
  await reconcileOnce();
  const runtime = (await listRuntimeInstancesForPool(pool.id))[0]!;
  await upsertRuntimeInstance({ id: runtime.id, agentId: agent.id, reportedSlots: 1 });
  const until = later(new Date(), 600).toISOString();
  await getDbClient().run(
    "UPDATE runtime_pools SET consecutive_failures = 5, circuit_open_until = ? WHERE id = ?",
    [until, pool.id],
  );
  await getDbClient().run(
    "UPDATE agents SET runtime_provision_attempts = 2, runtime_provision_retry_at = ? WHERE id = ?",
    [until, agent.id],
  );
  await upsertRuntimeInstance({ id: runtime.id, agentId: agent.id, reportedSlots: 1 });
  expect((await getRuntimePool(pool.id))?.consecutiveFailures).toBe(5);
  expect((await getRuntimePool(pool.id))?.circuitOpenUntil).toBe(until);
  expect((await getAgentById(agent.id))?.runtimeProvisionAttempts).toBe(2);
  expect((await getAgentById(agent.id))?.runtimeProvisionRetryAt).toBe(until);
});

for (const end of ["cancelled", "reassigned"] as const) {
  test(`retry state resets after demand is ${end}`, async () => {
    const { agent, task } = await setup();
    const now = new Date();
    state.fake.failure = "Provider unavailable";
    await reconcileOnce({ now });
    expect((await getAgentById(agent.id))?.runtimeProvisionAttempts).toBe(1);
    if (end === "cancelled") await cancelTask(task.id, "No longer needed");
    else {
      const other = await createAgent({ name: "Other worker", status: "idle" });
      await getDbClient().run("UPDATE agent_tasks SET agentId = ? WHERE id = ?", [
        other.id,
        task.id,
      ]);
    }
    await reconcileOnce({ now: later(now, 1) });
    expect((await getAgentById(agent.id))?.runtimeProvisionAttempts).toBe(0);
    expect((await getAgentById(agent.id))?.runtimeProvisionRetryAt).toBeNull();
    const next = await createTaskExtended("Unrelated demand", { agentId: agent.id });
    await reconcileOnce({ now: later(now, 2) });
    expect((await getTaskById(next.id))?.status).toBe("pending");
    expect((await getAgentById(agent.id))?.runtimeProvisionAttempts).toBe(1);
    expect((await getAgentById(agent.id))?.runtimeProvisionRetryAt).toBe(
      later(now, 32).toISOString(),
    );
  });
}

test("an open circuit clears retry state for all agents in that pool", async () => {
  process.env.RUNTIME_CIRCUIT_THRESHOLD = "1";
  const { pool, agent } = await setup();
  const sibling = await createPoolAgent(pool.id, { name: "Sibling", maxTasks: 2 });
  await getDbClient().run(
    "UPDATE agents SET runtime_provision_attempts = 2, runtime_provision_retry_at = ? WHERE id = ?",
    [later(new Date(), 600).toISOString(), sibling.id],
  );
  state.fake.failure = "Provider unavailable";
  await reconcileOnce();
  expect((await getRuntimePool(pool.id))?.circuitOpenUntil).not.toBeNull();
  for (const id of [agent.id, sibling.id]) {
    expect((await getAgentById(id))?.runtimeProvisionAttempts).toBe(0);
    expect((await getAgentById(id))?.runtimeProvisionRetryAt).toBeNull();
  }
});

test("the attempt cap clears state when no ready pending task can fail", async () => {
  process.env.RUNTIME_PROVISION_MAX_ATTEMPTS = "1";
  const { pool, agent, task } = await setup();
  state.fake.failure = "Provider unavailable";
  const original = state.fake.provision.bind(state.fake);
  const provision = spyOn(state.fake, "provision").mockImplementation(async (request) => {
    await cancelTask(task.id, "Cancelled during provision");
    return await original(request);
  });
  try {
    await reconcileOnce();
    expect((await getTaskById(task.id))?.status).toBe("cancelled");
    expect((await getRuntimePool(pool.id))?.consecutiveFailures).toBe(1);
    expect((await getAgentById(agent.id))?.runtimeProvisionAttempts).toBe(0);
    expect((await getAgentById(agent.id))?.runtimeProvisionRetryAt).toBeNull();
  } finally {
    provision.mockRestore();
  }
});

for (const phase of ["token", "insert"] as const) {
  test(`${phase} failure before the insert commits still applies backoff`, async () => {
    const { pool, agent } = await setup();
    const now = new Date();
    const failure =
      phase === "token"
        ? spyOn(users, "mintRuntimeToken").mockRejectedValue(new Error("Token mint failed"))
        : spyOn(multiRuntime, "insertProvisioningRuntime").mockRejectedValue(
            new Error("Runtime insert failed"),
          );
    try {
      await reconcileOnce({ now });
      expect(await listRuntimeInstancesForPool(pool.id)).toHaveLength(0);
      expect(state.fake.requests).toHaveLength(0);
      expect((await getAgentById(agent.id))?.runtimeProvisionAttempts).toBe(1);
      expect((await getAgentById(agent.id))?.runtimeProvisionRetryAt).toBe(
        later(now, 30).toISOString(),
      );
      expect((await getRuntimePool(pool.id))?.consecutiveFailures).toBe(1);
      await reconcileOnce({ now: later(now, 29) });
      expect((await getAgentById(agent.id))?.runtimeProvisionAttempts).toBe(1);
    } finally {
      failure.mockRestore();
    }
    await reconcileOnce({ now: later(now, 30) });
    expect(state.fake.requests).toHaveLength(1);
    expect((await listRuntimeInstancesForPool(pool.id))[0]?.provisionAttempts).toBe(2);
  });
}

test("circuit blocks provisioning and tier-2 routing, allows one trial, reopens on failure, and closes on registration", async () => {
  process.env.RUNTIME_CIRCUIT_THRESHOLD = "1";
  process.env.RUNTIME_CIRCUIT_OPEN_MIN = "1";
  process.env.RUNTIME_WAKE_GRACE_SEC = "0";
  const { pool } = await setup();
  const now = new Date();
  state.fake.failure = "Provider unavailable";
  await reconcileOnce({ now });
  expect((await getRuntimePool(pool.id))?.circuitOpenUntil).toBe(later(now, 60).toISOString());
  const sibling = await createPoolAgent(pool.id, { name: "Sibling", maxTasks: 2 });
  const unassigned = await createTaskExtended("Pool work");
  await routePoolTasks({ now: later(now, 20) });
  expect((await getTaskById(unassigned.id))?.status).toBe("unassigned");
  await reconcileOnce({ now: later(now, 59) });
  expect(state.fake.requests).toHaveLength(1);
  await reconcileOnce({ now: later(now, 60) });
  expect(state.fake.requests).toHaveLength(2);
  expect((await getRuntimePool(pool.id))?.circuitOpenUntil).toBe(later(now, 120).toISOString());
  state.fake.failure = null;
  await createTaskExtended("Sibling work", { agentId: sibling.id });
  await reconcileOnce({ now: later(now, 120) });
  await reconcileOnce({ now: later(now, 121) });
  expect(state.fake.requests).toHaveLength(3);
  const runtime = (await listRuntimeInstancesForPool(pool.id)).find(
    (r) => r.status === "provisioning",
  )!;
  await upsertRuntimeInstance({ id: runtime.id, agentId: runtime.agentId, reportedSlots: 1 });
  expect((await getRuntimePool(pool.id))?.circuitOpenUntil).toBeNull();
  expect((await getRuntimePool(pool.id))?.consecutiveFailures).toBe(0);
  await reconcileOnce({ now: later(now, 150) });
  expect(state.fake.requests.length).toBeGreaterThan(3);
  expect((await getAgentById(runtime.agentId))?.runtimeProvisionAttempts).toBe(0);
});

test("failure knobs reject invalid saved values", () => {
  for (const key of [
    "RUNTIME_PROVISION_TIMEOUT_SEC",
    "RUNTIME_SUPERVISOR_INTERVAL_MS",
    "RUNTIME_PROVISION_MAX_ATTEMPTS",
    "RUNTIME_CIRCUIT_THRESHOLD",
    "RUNTIME_CIRCUIT_OPEN_MIN",
    "RUNTIME_TOKEN_ROTATE_BEFORE_MIN",
  ]) {
    expect(validateConfigValue(key, "0")).not.toBeNull();
    expect(validateConfigValue(key, "-1")).not.toBeNull();
    expect(validateConfigValue(key, "1.5")).not.toBeNull();
    expect(validateConfigValue(key, "1")).toBeNull();
  }
  expect(validateConfigValue("RUNTIME_SOCKET_GRACE_SEC", "0")).toBeNull();
});
