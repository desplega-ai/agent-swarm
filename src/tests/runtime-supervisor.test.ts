import { afterAll, afterEach, beforeAll, beforeEach, expect, spyOn, test } from "bun:test";
import {
  closeDb,
  completeTask,
  createChannel,
  createTaskExtended,
  getAgentById,
  getDbClient,
  initDb,
  postMessage,
  upsertBudget,
  upsertSwarmConfig,
} from "../be/db";
import {
  expireStaleRuntimeInstances,
  getRuntimeInstanceById,
  insertProvisioningRuntime,
  listPoolRuntimes,
  upsertRuntimeInstance,
} from "../be/multi-runtime";
import { ensureRuntimeOwnerId, getControllerCommands } from "../be/runtime-pools/controllers";
import {
  createPoolAgent,
  createRuntimeController,
  createRuntimePool,
} from "../be/runtime-pools/db";
import {
  reconcileOnce,
  runtimeSupervisorStatus,
  startRuntimeSupervisor,
  stopRuntimeSupervisor,
} from "../be/runtime-pools/supervisor";
import { findOrCreateUserByEmail, resolveBySessionToken } from "../be/users";
import { buildStatusPayload } from "../http/status";
import type {
  ProvisionRequest,
  RuntimeHandle,
  RuntimeProvider,
  RuntimeStatus,
  RuntimeTargetConfig,
} from "../runtime-providers";
import * as providers from "../runtime-providers";

class FakeRuntimeProvider implements RuntimeProvider {
  readonly kind = "docker" as const;
  readonly traits = { canProvision: true, ephemeralDisk: true, supportsPause: false };
  requests: ProvisionRequest[] = [];
  targets: RuntimeTargetConfig[] = [];
  terminated: string[] = [];
  owners: string[] = [];
  runtimes = new Map<string, { handle: RuntimeHandle; owner: string; status: RuntimeStatus }>();
  failure: string | null = null;
  gate: Promise<void> | null = null;
  checkConfig() {
    return { ready: true, missing: [] };
  }
  async provision(target: RuntimeTargetConfig, req: ProvisionRequest): Promise<RuntimeHandle> {
    this.requests.push(req);
    this.targets.push(target);
    if (this.gate) await this.gate;
    if (this.failure) throw new Error(this.failure);
    const handle: RuntimeHandle = { kind: "docker", externalId: crypto.randomUUID() };
    this.runtimes.set(handle.externalId, { handle, owner: req.ownerId, status: "running" });
    return handle;
  }
  async terminate(_target: RuntimeTargetConfig, handle: RuntimeHandle) {
    this.terminated.push(handle.externalId);
    this.runtimes.delete(handle.externalId);
  }
  async status(_target: RuntimeTargetConfig, handle: RuntimeHandle): Promise<RuntimeStatus> {
    return this.runtimes.get(handle.externalId)?.status ?? "exited";
  }
  async list(_target: RuntimeTargetConfig, ownerId: string) {
    this.owners.push(ownerId);
    return [...this.runtimes.values()].filter((r) => r.owner === ownerId).map((r) => r.handle);
  }
}

const dbPath = "./test-runtime-supervisor.sqlite";
const envKeys = [
  "RUNTIME_POOLS_ENABLED",
  "MULTI_RUNTIME_ENABLED",
  "RUNTIME_WORKER_API_URL",
  "SECRETS_ENCRYPTION_KEY",
] as const;
const previous = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
let fake: FakeRuntimeProvider;
let providerSpy: ReturnType<typeof spyOn<typeof providers, "createRuntimeProvider">>;
let errorSpy: ReturnType<typeof spyOn<typeof console, "error">>;
let controllerId: string;
beforeAll(() => {
  initDb(dbPath);
});
beforeEach(async () => {
  await stopRuntimeSupervisor();
  process.env.RUNTIME_POOLS_ENABLED = "true";
  process.env.MULTI_RUNTIME_ENABLED = "true";
  process.env.RUNTIME_WORKER_API_URL = "http://worker-api.invalid";
  process.env.SECRETS_ENCRYPTION_KEY = "a".repeat(64);
  for (const table of [
    "active_sessions",
    "runtime_instances",
    "session_tokens",
    "agent_tasks",
    "agents",
    "runtime_pools",
    "runtime_controllers",
    "swarm_config",
    "budgets",
  ])
    await getDbClient().run(`DELETE FROM ${table}`);
  fake = new FakeRuntimeProvider();
  providerSpy = spyOn(providers, "createRuntimeProvider").mockImplementation(async () => fake);
  errorSpy = spyOn(console, "error").mockImplementation(() => {});
  controllerId = (
    await createRuntimeController({ name: "docker", kind: "docker", placement: "builtin" })
  ).id;
});
afterEach(async () => {
  await stopRuntimeSupervisor();
  providerSpy.mockRestore();
  errorSpy.mockRestore();
});
afterAll(async () => {
  closeDb();
  for (const suffix of ["", "-wal", "-shm"])
    await Bun.file(dbPath + suffix)
      .delete()
      .catch(() => {});
  for (const key of envKeys) {
    if (previous[key] === undefined) delete process.env[key];
    else process.env[key] = previous[key];
  }
});
async function setup(
  options: Parameters<typeof createRuntimePool>[0] extends infer T ? Partial<T> : never = {},
  maxTasks = 4,
) {
  const pool = await createRuntimePool({
    name: crypto.randomUUID(),
    kind: "docker",
    placements: [controllerId],
    image: "worker:test",
    ...options,
  });
  const agent = await createPoolAgent(pool.id, {
    name: crypto.randomUUID(),
    maxTasks,
    harnessProvider: "pi",
  });
  return { pool, agent };
}
async function wake(options = {}, maxTasks = 4) {
  const state = await setup(options, maxTasks);
  const task = await createTaskExtended("pending task", { agentId: state.agent.id });
  await reconcileOnce();
  return { ...state, task, runtime: (await listPoolRuntimes(state.pool.id))[0]! };
}
async function activate(runtimeId: string, agentId: string, reportedSlots = 1) {
  await upsertRuntimeInstance({ id: runtimeId, agentId, reportedSlots });
  // Exercise the supervisor's teardown state, rather than registration's separate reconciliation.
  await getDbClient().run("UPDATE agents SET status = 'idle' WHERE id = ?", [agentId]);
}

test("pending task provisions once while registration is pending, with scoped env and owner labels", async () => {
  const { pool, agent, runtime } = await wake({
    env: {
      AGENT_ID: "override",
      API_KEY: "override",
      AGENT_SWARM_API_KEY: "override",
      SWARM_RUNTIME_INSTANCE_ID: "override",
      AGENT_ROLE: "lead",
      HARNESS_PROVIDER: "codex",
      MAX_CONCURRENT_TASKS: "99",
      MCP_BASE_URL: "override",
      SWARM_DELIVERY_MODE: "override",
      CUSTOM_VALUE: "kept",
    },
    delivery: "push",
  });
  await reconcileOnce();
  expect(fake.requests).toHaveLength(1);
  expect(runtime.status).toBe("provisioning");
  const request = fake.requests[0]!;
  expect(request.env.AGENT_ID).toBe(agent.id);
  expect(request.env.SWARM_RUNTIME_INSTANCE_ID).toBe(runtime.id);
  expect(request.env.API_KEY).toStartWith("aseph_");
  expect(request.env.AGENT_SWARM_API_KEY).toBe(request.env.API_KEY);
  expect((await resolveBySessionToken(request.env.API_KEY!))?.runtimeId).toBe(runtime.id);
  expect(request.env).toMatchObject({
    AGENT_ROLE: "worker",
    HARNESS_PROVIDER: "pi",
    MAX_CONCURRENT_TASKS: "1",
    MCP_BASE_URL: "http://worker-api.invalid",
    SWARM_DELIVERY_MODE: "push",
    CUSTOM_VALUE: "kept",
  });
  expect(request.labels).toEqual({
    "swarm.runtime-id": runtime.id,
    "swarm.pool-id": pool.id,
    "swarm.agent-id": agent.id,
    "swarm.owner": await ensureRuntimeOwnerId(),
  });
  expect(fake.owners).toEqual([request.ownerId, request.ownerId]);
});

test("live free slot prevents another provision", async () => {
  const { agent, runtime } = await wake();
  await activate(runtime.id, agent.id);
  await reconcileOnce();
  expect(fake.requests).toHaveLength(1);
});

test("budget refusal prevents boot, including warm floor", async () => {
  const { agent } = await setup({ minRuntimes: 1 });
  await upsertBudget("agent", agent.id, 0);
  await createTaskExtended("blocked by budget", { agentId: agent.id });
  await reconcileOnce();
  expect(fake.requests).toHaveLength(0);
});

test("logical slots and pool caps bound pending demand", async () => {
  const { pool, agent } = await setup({ slotsPerRuntime: 2, maxRuntimes: 2 }, 5);
  const second = await createPoolAgent(pool.id, { name: "second", maxTasks: 10 });
  for (let i = 0; i < 5; i++) {
    await createTaskExtended("work", { agentId: agent.id });
    await createTaskExtended("other work", { agentId: second.id });
  }
  await reconcileOnce();
  await reconcileOnce();
  expect(fake.requests).toHaveLength(2);
  expect(fake.requests.every((r) => r.agentId === agent.id)).toBe(true);
});

test("warm floor starts without work and remains warm past idle timeout", async () => {
  const { pool, agent } = await setup({ minRuntimes: 1, idleMinutes: 1 });
  await reconcileOnce();
  const runtime = (await listPoolRuntimes(pool.id))[0]!;
  await activate(runtime.id, agent.id);
  await getDbClient().run("UPDATE runtime_instances SET idle_since = ? WHERE id = ?", [
    new Date(Date.now() - 120_000).toISOString(),
    runtime.id,
  ]);
  await reconcileOnce();
  await reconcileOnce();
  expect(fake.requests).toHaveLength(1);
  expect(fake.terminated).toHaveLength(0);
});

test("idle reap drains first, then terminates, offlines the agent, and revokes the token", async () => {
  const { task, agent, runtime } = await wake({ idleMinutes: 1 });
  await completeTask(task.id, "done");
  await activate(runtime.id, agent.id);
  await getDbClient().run("UPDATE runtime_instances SET idle_since = ? WHERE id = ?", [
    new Date(Date.now() - 120_000).toISOString(),
    runtime.id,
  ]);
  await reconcileOnce();
  expect((await getRuntimeInstanceById(runtime.id))?.draining).toBe(true);
  expect(fake.terminated).toHaveLength(0);
  await reconcileOnce();
  expect(fake.terminated).toHaveLength(1);
  expect((await getRuntimeInstanceById(runtime.id))?.status).toBe("offline");
  expect((await getAgentById(agent.id))?.status).toBe("offline");
  expect(await resolveBySessionToken(fake.requests[0]!.env.API_KEY!)).toBeNull();
});

test("active session clears draining and records task history", async () => {
  const { agent, runtime, task } = await wake({ idleMinutes: 1 });
  await activate(runtime.id, agent.id);
  await getDbClient().run("UPDATE runtime_instances SET draining = 1 WHERE id = ?", [runtime.id]);
  await getDbClient().run(
    "INSERT INTO active_sessions (id, agentId, taskId, triggerType, runtimeInstanceId) VALUES (?, ?, ?, 'task_assigned', ?)",
    [crypto.randomUUID(), agent.id, task.id, runtime.id],
  );
  await reconcileOnce();
  const row = await getRuntimeInstanceById(runtime.id);
  expect(row?.draining).toBe(false);
  expect(row?.idleSince).toBeNull();
  expect(row?.taskId).toBe(task.id);
  expect(fake.terminated).toHaveLength(0);
});

test("per-task runtime reaps after a task and injects the exit limit", async () => {
  const { agent, task, runtime } = await wake({ lifecycle: "per-task" });
  expect(fake.requests[0]!.env.SWARM_EXIT_AFTER_TASKS).toBe("1");
  await completeTask(task.id, "done");
  await activate(runtime.id, agent.id);
  await getDbClient().run("UPDATE runtime_instances SET task_id = ? WHERE id = ?", [
    task.id,
    runtime.id,
  ]);
  await reconcileOnce();
  expect(fake.terminated).toHaveLength(1);
  expect((await getRuntimeInstanceById(runtime.id))?.status).toBe("offline");
});

test("clean provider exit retires a missing handle", async () => {
  const { runtime, task } = await wake({ lifecycle: "per-task" });
  await completeTask(task.id, "done");
  fake.runtimes.clear();
  await reconcileOnce();
  expect((await getRuntimeInstanceById(runtime.id))?.status).toBe("offline");
  expect(await resolveBySessionToken(fake.requests[0]!.env.API_KEY!)).toBeNull();
});

test("orphans use the stable owner filter and preserve other pools on the controller", async () => {
  const first = await wake();
  const second = await wake();
  const ownerId = await ensureRuntimeOwnerId();
  const orphan: RuntimeHandle = { kind: "docker", externalId: crypto.randomUUID() };
  const foreign: RuntimeHandle = { kind: "docker", externalId: crypto.randomUUID() };
  fake.runtimes.set(orphan.externalId, { handle: orphan, owner: ownerId, status: "running" });
  fake.runtimes.set(foreign.externalId, {
    handle: foreign,
    owner: "other-swarm",
    status: "running",
  });
  await reconcileOnce();
  expect(fake.terminated).toEqual([orphan.externalId]);
  expect((await getRuntimeInstanceById(first.runtime.id))?.status).toBe("provisioning");
  expect((await getRuntimeInstanceById(second.runtime.id))?.status).toBe("provisioning");
  expect(await ensureRuntimeOwnerId()).toBe(ownerId);
});

test("static and disabled pools never provision", async () => {
  const staticController = await createRuntimeController({
    name: "static",
    kind: "static",
    placement: "builtin",
  });
  await setup({ kind: "static", placements: [staticController.id], minRuntimes: 1 });
  const { agent } = await setup({ enabled: false });
  await createTaskExtended("disabled", { agentId: agent.id });
  await reconcileOnce();
  expect(fake.requests).toHaveLength(0);
});

test("flag off never starts the loop", async () => {
  const { agent } = await setup({ minRuntimes: 1 });
  await createTaskExtended("off", { agentId: agent.id });
  process.env.RUNTIME_POOLS_ENABLED = "false";
  startRuntimeSupervisor(1);
  await reconcileOnce();
  expect(runtimeSupervisorStatus()).toBe("disabled");
  expect(fake.requests).toHaveLength(0);
});

test("multi-runtime disabled refuses start once and reports the status reason", async () => {
  process.env.MULTI_RUNTIME_ENABLED = "false";
  startRuntimeSupervisor();
  startRuntimeSupervisor();
  expect(errorSpy).toHaveBeenCalledTimes(1);
  expect(runtimeSupervisorStatus()).toBe("disabled: MULTI_RUNTIME_ENABLED=false");
  expect((await buildStatusPayload()).runtime_pools.supervisor).toBe(
    "disabled: MULTI_RUNTIME_ENABLED=false",
  );
  expect(fake.requests).toHaveLength(0);
});

test("controller secrets stay outside runtime env and provision errors are scrubbed", async () => {
  const secret = `controller-secret-${crypto.randomUUID()}`;
  const controller = await createRuntimeController({
    name: "secret-target",
    kind: "docker",
    placement: "builtin",
    config: { WORKER_API_URL: "http://controller-worker.invalid" },
    secretConfig: { TARGET_SECRET: secret },
  });
  const { pool, agent } = await setup({ placements: [controller.id] });
  await upsertSwarmConfig({
    scope: "agent",
    scopeId: agent.id,
    key: "TEMPLATE_ID",
    value: "official/coder",
  });
  fake.failure = `provider failed with ${secret}`;
  await createTaskExtended("secret target", { agentId: agent.id });
  await reconcileOnce();
  expect(fake.targets[0]?.TARGET_SECRET).toBe(secret);
  expect(fake.requests[0]?.env.TARGET_SECRET).toBeUndefined();
  expect(fake.requests[0]?.env.MCP_BASE_URL).toBe("http://controller-worker.invalid");
  expect(fake.requests[0]?.env.TEMPLATE_ID).toBe("official/coder");
  const runtime = (await listPoolRuntimes(pool.id))[0]!;
  expect(runtime.status).toBe("offline");
  expect(runtime.provisionError).not.toContain(secret);
  expect(JSON.stringify(errorSpy.mock.calls)).not.toContain(secret);
  expect(await resolveBySessionToken(fake.requests[0]!.env.API_KEY!)).toBeNull();
  expect(
    (await getDbClient().query<{ value: string }>("SELECT value FROM swarm_config")).some((r) =>
      r.value.includes(secret),
    ),
  ).toBe(false);
});

test("controller status and list errors scrub decrypted credentials", async () => {
  const secret = `controller-list-secret-${crypto.randomUUID()}`;
  const controller = await createRuntimeController({
    name: "bad-list",
    kind: "docker",
    placement: "builtin",
    secretConfig: { TARGET_SECRET: secret },
  });
  fake.list = async () => {
    throw new Error(secret);
  };
  const commands = await getControllerCommands(controller.id);
  await expect(commands.list(await ensureRuntimeOwnerId())).rejects.not.toThrow(secret);
});

test("reconciliation rejects concurrent ticks", async () => {
  const { agent } = await setup();
  await createTaskExtended("one", { agentId: agent.id });
  let release!: () => void;
  fake.gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tick = reconcileOnce();
  for (let i = 0; i < 100 && !fake.requests.length; i++) await Bun.sleep(5);
  await reconcileOnce();
  release();
  await tick;
  expect(fake.requests).toHaveLength(1);
});

test("task creation kicks a sleeping pool agent before the interval", async () => {
  const { agent } = await setup();
  startRuntimeSupervisor(60_000);
  await createTaskExtended("event wake", { agentId: agent.id });
  for (let i = 0; i < 100 && !fake.requests.length; i++) await Bun.sleep(10);
  expect(fake.requests).toHaveLength(1);
});

test("reaper preserves stale provisioning rows", async () => {
  const { pool, agent } = await setup();
  const id = crypto.randomUUID();
  await insertProvisioningRuntime({ id, agentId: agent.id, poolId: pool.id, controllerId });
  await getDbClient().run("UPDATE runtime_instances SET last_seen_at = ? WHERE id = ?", [
    new Date(Date.now() - 3_600_000).toISOString(),
    id,
  ]);
  await expireStaleRuntimeInstances();
  expect((await getRuntimeInstanceById(id))?.status).toBe("provisioning");
});

test("requester budget refusal prevents provisioning", async () => {
  const { agent } = await setup();
  const { user } = await findOrCreateUserByEmail(
    `${crypto.randomUUID()}@example.test`,
    {},
    { kind: "system", id: "test" },
  );
  await upsertBudget("user", user.id, 0);
  await createTaskExtended("user budget", { agentId: agent.id, requestedByUserId: user.id });
  await reconcileOnce();
  expect(fake.requests).toHaveLength(0);
});

test("offers and mentions wake sleeping lead identities", async () => {
  const { pool } = await setup();
  const lead = await createPoolAgent(pool.id, { name: "lead", isLead: true, maxTasks: 2 });
  await createTaskExtended("offered", { offeredTo: lead.id });
  const channel = await createChannel(crypto.randomUUID());
  await postMessage(channel.id, null, "hello", { mentions: [lead.id] });
  await reconcileOnce();
  expect(fake.requests).toHaveLength(2);
  expect(fake.requests.every((r) => r.agentId === lead.id && r.env.AGENT_ROLE === "lead")).toBe(
    true,
  );
});

test("warm floor clears excess draining markers after one sibling is reaped", async () => {
  const { pool, agent } = await setup({ minRuntimes: 1, idleMinutes: 1 });
  await createTaskExtended("first", { agentId: agent.id });
  await createTaskExtended("second", { agentId: agent.id });
  await reconcileOnce();
  const runtimes = await listPoolRuntimes(pool.id);
  for (const runtime of runtimes) {
    await activate(runtime.id, agent.id);
    await getDbClient().run("UPDATE runtime_instances SET idle_since = ? WHERE id = ?", [
      new Date(Date.now() - 120_000).toISOString(),
      runtime.id,
    ]);
  }
  await getDbClient().run("UPDATE agent_tasks SET status = 'completed' WHERE agentId = ?", [
    agent.id,
  ]);
  await reconcileOnce();
  await reconcileOnce();
  const live = (await listPoolRuntimes(pool.id)).filter((r) => r.status === "active");
  expect(live).toHaveLength(1);
  expect(live[0]?.draining).toBe(false);
  expect((await getAgentById(agent.id))?.status).toBe("idle");
});
