import { afterAll, afterEach, beforeAll, beforeEach, expect, spyOn, test } from "bun:test";
import * as admission from "../be/budget-admission";
import {
  closeDb,
  completeTask,
  createChannel,
  createTaskExtended,
  getAgentById,
  getDbClient,
  getInjectableGlobalConfigs,
  initDb,
  postMessage,
  upsertBudget,
  upsertSwarmConfig,
} from "../be/db";
import {
  expireStaleRuntimeInstances,
  getRuntimeInstanceById,
  insertProvisioningRuntime,
  listRuntimeInstancesForPool,
  markRuntimeTerminated,
  upsertRuntimeInstance,
} from "../be/multi-runtime";
import * as controllers from "../be/runtime-pools/controllers";
import { ensureRuntimeOwnerId, getControllerCommands } from "../be/runtime-pools/controllers";
import * as poolDatabase from "../be/runtime-pools/db";
import {
  createPoolAgent,
  createRuntimeController,
  createRuntimePool,
  getRuntimePool,
} from "../be/runtime-pools/db";
import {
  reconcileControllerOrphans,
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
import { ControllerOfflineError } from "../runtime-providers/controller";
import { TERMINAL_TASK_STATUSES } from "../types";
import { registerVolatileSecret, scrubSecrets } from "../utils/secret-scrubber";

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
  terminateFailures = new Map<string, string>();
  statusFailures = new Set<string>();
  provisionFailures = new Map<string, string>();
  checkConfig() {
    return { ready: true, missing: [] };
  }
  async provision(target: RuntimeTargetConfig, req: ProvisionRequest): Promise<RuntimeHandle> {
    this.requests.push(req);
    this.targets.push(target);
    if (this.gate) await this.gate;
    if (this.failure) throw new Error(this.failure);
    if (this.provisionFailures.has(req.agentId))
      throw new Error(this.provisionFailures.get(req.agentId));
    const handle: RuntimeHandle = { kind: "docker", externalId: crypto.randomUUID() };
    this.runtimes.set(handle.externalId, { handle, owner: req.ownerId, status: "running" });
    return handle;
  }
  async terminate(_target: RuntimeTargetConfig, handle: RuntimeHandle) {
    this.terminated.push(handle.externalId);
    if (this.terminateFailures.has(handle.externalId))
      throw new Error(this.terminateFailures.get(handle.externalId));
    this.runtimes.delete(handle.externalId);
  }
  async status(_target: RuntimeTargetConfig, handle: RuntimeHandle): Promise<RuntimeStatus> {
    if (this.statusFailures.has(handle.externalId)) throw new Error("status failed");
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
  "RUNTIME_PER_TASK_EXIT_GRACE_SEC",
  "RUNTIME_PROVISION_CONCURRENCY",
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
  delete process.env.RUNTIME_PER_TASK_EXIT_GRACE_SEC;
  delete process.env.RUNTIME_PROVISION_CONCURRENCY;
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
  return { ...state, task, runtime: (await listRuntimeInstancesForPool(state.pool.id))[0]! };
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

test("concurrent provisions respect the limit, pool cap, and demand reservation", async () => {
  process.env.RUNTIME_PROVISION_CONCURRENCY = "2";
  const { pool, agent } = await setup({ maxRuntimes: 4 }, 3);
  const sibling = await createPoolAgent(pool.id, { name: "sibling", maxTasks: 3 });
  for (const id of [agent.id, sibling.id])
    for (let i = 0; i < 5; i++) await createTaskExtended("work", { agentId: id });
  const releases: Array<() => void> = [];
  const original = fake.provision.bind(fake);
  const provision = spyOn(fake, "provision").mockImplementation(async (target, request) => {
    const handle = await original(target, request);
    await new Promise<void>((resolve) => releases.push(resolve));
    return handle;
  });
  const tick = reconcileOnce();
  try {
    for (let i = 0; i < 1000 && releases.length < 2; i++) await Bun.sleep(5);
    expect(fake.requests).toHaveLength(2);
    expect(await listRuntimeInstancesForPool(pool.id)).toHaveLength(2);
    await reconcileOnce();
    expect(fake.requests).toHaveLength(2);
    for (let count = 3; count <= 4; count++) {
      releases[count - 3]!();
      for (let i = 0; i < 1000 && releases.length < count; i++) await Bun.sleep(5);
      expect(fake.requests).toHaveLength(count);
    }
  } finally {
    provision.mockRestore();
    for (const release of releases) release();
    await tick;
  }
  expect(fake.requests.filter((r) => r.agentId === agent.id)).toHaveLength(3);
  expect(fake.requests.filter((r) => r.agentId === sibling.id)).toHaveLength(1);
  expect(await listRuntimeInstancesForPool(pool.id)).toHaveLength(4);
  await reconcileOnce();
  expect(fake.requests).toHaveLength(4);
});

test("provision concurrency defaults to eight", async () => {
  const { agent } = await setup({}, 9);
  for (let i = 0; i < 9; i++) await createTaskExtended("work", { agentId: agent.id });
  let release!: () => void;
  fake.gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tick = reconcileOnce();
  try {
    for (let i = 0; i < 1000 && fake.requests.length < 8; i++) await Bun.sleep(5);
    expect(fake.requests).toHaveLength(8);
    await reconcileOnce();
    expect(fake.requests).toHaveLength(8);
  } finally {
    release();
    await tick;
  }
  expect(fake.requests).toHaveLength(9);
});

test("an expired circuit admits only one trial during concurrent provisioning", async () => {
  const { pool, agent } = await setup({}, 4);
  const sibling = await createPoolAgent(pool.id, { name: "sibling", maxTasks: 2 });
  for (const id of [agent.id, sibling.id])
    for (let i = 0; i < 4; i++) await createTaskExtended("work", { agentId: id });
  await getDbClient().run("UPDATE runtime_pools SET circuit_open_until = ? WHERE id = ?", [
    new Date(Date.now() - 1000).toISOString(),
    pool.id,
  ]);
  let release!: () => void;
  fake.gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tick = reconcileOnce();
  try {
    for (let i = 0; i < 1000 && !fake.requests.length; i++) await Bun.sleep(5);
    expect(fake.requests).toHaveLength(1);
    await reconcileOnce();
    expect(fake.requests).toHaveLength(1);
  } finally {
    release();
    await tick;
  }
  await reconcileOnce();
  expect(fake.requests).toHaveLength(1);
});

test("a controller disconnect preserves reservations without failure backoff", async () => {
  const { pool, agent } = await setup({}, 1);
  const sibling = await createPoolAgent(pool.id, { name: "sibling", maxTasks: 1 });
  for (const id of [agent.id, sibling.id]) await createTaskExtended("work", { agentId: id });
  const commands = await getControllerCommands(controllerId);
  const original = commands.provision.bind(commands);
  const provision = spyOn(commands, "provision").mockImplementation(async (request) => {
    if (request.agentId === agent.id) {
      fake.requests.push(request);
      throw new ControllerOfflineError(controllerId);
    }
    return original(request);
  });
  try {
    await reconcileOnce({ getControllerCommands: async () => commands });
  } finally {
    provision.mockRestore();
  }
  const rows = await listRuntimeInstancesForPool(pool.id);
  expect(rows).toHaveLength(2);
  expect(rows.every((r) => r.status === "provisioning")).toBe(true);
  const reserved = rows.find((r) => r.agentId === agent.id)!;
  expect(reserved.externalHandle).toBeNull();
  expect(rows.find((r) => r.agentId === sibling.id)?.externalHandle).not.toBeNull();
  expect(
    await resolveBySessionToken(fake.requests.find((r) => r.agentId === agent.id)!.env.API_KEY!),
  ).not.toBeNull();
  expect((await getAgentById(agent.id))?.runtimeProvisionAttempts).toBe(0);
  expect((await getAgentById(agent.id))?.runtimeProvisionRetryAt).toBeNull();
  expect((await getRuntimePool(pool.id))?.consecutiveFailures).toBe(0);
  expect(errorSpy).not.toHaveBeenCalled();
});

test("a concurrent provision failure preserves siblings and applies backoff", async () => {
  process.env.RUNTIME_PROVISION_CONCURRENCY = "2";
  const { pool, agent } = await setup({}, 1);
  const sibling = await createPoolAgent(pool.id, { name: "sibling", maxTasks: 1 });
  for (const id of [agent.id, sibling.id]) await createTaskExtended("work", { agentId: id });
  fake.provisionFailures.set(agent.id, "provision failed");
  let release!: () => void;
  fake.gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const now = new Date();
  const tick = reconcileOnce({ now });
  try {
    for (let i = 0; i < 1000 && fake.requests.length < 2; i++) await Bun.sleep(5);
    expect(fake.requests).toHaveLength(2);
  } finally {
    release();
    await tick;
  }
  const rows = await listRuntimeInstancesForPool(pool.id);
  expect(rows.find((r) => r.agentId === agent.id)?.status).toBe("offline");
  expect(rows.find((r) => r.agentId === sibling.id)?.status).toBe("provisioning");
  expect((await getAgentById(agent.id))?.runtimeProvisionAttempts).toBe(1);
  expect((await getAgentById(agent.id))?.runtimeProvisionRetryAt).toBe(
    new Date(now.getTime() + 30_000).toISOString(),
  );
  await reconcileOnce({ now: new Date(now.getTime() + 29_000) });
  expect(fake.requests).toHaveLength(2);
});

test("warm floor starts without work and remains warm past idle timeout", async () => {
  const { pool, agent } = await setup({ minRuntimes: 1, idleMinutes: 1 });
  await reconcileOnce();
  const runtime = (await listRuntimeInstancesForPool(pool.id))[0]!;
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

test("an empty stale-session scan does not issue a session DELETE", async () => {
  const { agent, runtime } = await wake();
  await activate(runtime.id, agent.id);
  const writes = spyOn(getDbClient(), "run");
  try {
    await reconcileOnce();
    expect(writes.mock.calls.some(([sql]) => sql.startsWith("DELETE FROM active_sessions"))).toBe(
      false,
    );
  } finally {
    writes.mockRestore();
  }
});

test.each([
  ...TERMINAL_TASK_STATUSES,
  "missing",
] as const)("a session with a %s task becomes idle and is reaped", async (status) => {
  const { task, agent, runtime } = await wake({ idleMinutes: 1 });
  await activate(runtime.id, agent.id);
  if (status === "missing") {
    await getDbClient().run("DELETE FROM agent_tasks WHERE id = ?", [task.id]);
  } else {
    await getDbClient().run("UPDATE agent_tasks SET status = ? WHERE id = ?", [status, task.id]);
  }
  await getDbClient().run("UPDATE runtime_instances SET task_id = ? WHERE id = ?", [
    task.id,
    runtime.id,
  ]);
  await getDbClient().run(
    "INSERT INTO active_sessions (id, agentId, taskId, triggerType, runtimeInstanceId) VALUES (?, ?, ?, 'task_assigned', ?)",
    [crypto.randomUUID(), agent.id, task.id, runtime.id],
  );
  const siblingSessionId = crypto.randomUUID();
  await getDbClient().run(
    "INSERT INTO active_sessions (id, agentId, taskId, triggerType, runtimeInstanceId) VALUES (?, ?, ?, 'task_assigned', ?)",
    [siblingSessionId, agent.id, crypto.randomUUID(), crypto.randomUUID()],
  );
  await reconcileOnce();
  const idleSince = (await getRuntimeInstanceById(runtime.id))?.idleSince;
  expect(idleSince).toBeString();
  expect(fake.terminated).toHaveLength(0);
  expect(
    await getDbClient().get("SELECT id FROM active_sessions WHERE taskId = ?", [task.id]),
  ).toBeNull();
  expect(
    await getDbClient().get("SELECT id FROM active_sessions WHERE id = ?", [siblingSessionId]),
  ).not.toBeNull();
  await reconcileOnce({ now: new Date(Date.parse(idleSince!) + 60_000) });
  expect((await getRuntimeInstanceById(runtime.id))?.draining).toBe(true);
  await reconcileOnce({ now: new Date(Date.parse(idleSince!) + 61_000) });
  expect(fake.terminated).toHaveLength(1);
  expect((await getRuntimeInstanceById(runtime.id))?.status).toBe("offline");
});

test.each([
  "pending",
  "in_progress",
  "reviewing",
])("%s session clears draining and records task history", async (status) => {
  const { agent, runtime, task } = await wake({ idleMinutes: 1 });
  await activate(runtime.id, agent.id);
  await getDbClient().run("UPDATE agent_tasks SET status = ? WHERE id = ?", [status, task.id]);
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
  await reconcileOnce({ now: new Date(Date.now() + 120_000) });
  expect((await getRuntimeInstanceById(runtime.id))?.idleSince).toBeNull();
  expect(fake.terminated).toHaveLength(0);
  expect(
    await getDbClient().get("SELECT taskId FROM active_sessions WHERE taskId = ?", [task.id]),
  ).not.toBeNull();
});

test("per-task runtime preserves post-task work until runner shutdown", async () => {
  const { agent, task, runtime } = await wake({ lifecycle: "per-task" });
  expect(fake.requests[0]!.env.SWARM_EXIT_AFTER_TASKS).toBe("1");
  await completeTask(task.id, "done");
  await activate(runtime.id, agent.id);
  await getDbClient().run("UPDATE runtime_instances SET task_id = ? WHERE id = ?", [
    task.id,
    runtime.id,
  ]);
  await getDbClient().run(
    "INSERT INTO active_sessions (id, agentId, taskId, triggerType, runtimeInstanceId) VALUES (?, ?, ?, 'task_assigned', ?)",
    [crypto.randomUUID(), agent.id, task.id, runtime.id],
  );
  await reconcileOnce();
  expect(fake.terminated).toHaveLength(0);
  expect((await getRuntimeInstanceById(runtime.id))?.status).toBe("active");
  expect(await resolveBySessionToken(fake.requests[0]!.env.API_KEY!)).not.toBeNull();
  expect(
    await getDbClient().get("SELECT id FROM active_sessions WHERE taskId = ?", [task.id]),
  ).not.toBeNull();
  // The runner's shutdown close marks the runtime offline before provider cleanup.
  await markRuntimeTerminated(runtime.id, "Runner shutdown");
  await reconcileOnce();
  expect(fake.terminated).toHaveLength(1);
  expect((await getRuntimeInstanceById(runtime.id))?.status).toBe("offline");
  expect(await resolveBySessionToken(fake.requests[0]!.env.API_KEY!)).toBeNull();
});

test.each([
  undefined,
  "10",
])("per-task runtime expires exit grace (%s) without runner shutdown", async (grace) => {
  if (grace !== undefined) process.env.RUNTIME_PER_TASK_EXIT_GRACE_SEC = grace;
  const { agent, task, runtime } = await wake({ lifecycle: "per-task" });
  await activate(runtime.id, agent.id);
  const finished = await completeTask(task.id, "done");
  await getDbClient().run("UPDATE runtime_instances SET task_id = ? WHERE id = ?", [
    task.id,
    runtime.id,
  ]);
  const deadline = Date.parse(finished!.finishedAt!) + Number(grace ?? 60) * 1000;
  await reconcileOnce({ now: new Date(deadline - 1) });
  expect(fake.terminated).toHaveLength(0);
  expect(await resolveBySessionToken(fake.requests[0]!.env.API_KEY!)).not.toBeNull();
  await reconcileOnce({ now: new Date(deadline) });
  expect(fake.terminated).toHaveLength(1);
  expect((await getRuntimeInstanceById(runtime.id))?.status).toBe("offline");
  expect(await resolveBySessionToken(fake.requests[0]!.env.API_KEY!)).toBeNull();
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
  const orphan: RuntimeHandle = {
    kind: "docker",
    externalId: crypto.randomUUID(),
    createdAt: new Date(Date.now() - 180_000).toISOString(),
  };
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
  const runtime = (await listRuntimeInstancesForPool(pool.id))[0]!;
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
  const runtimes = await listRuntimeInstancesForPool(pool.id);
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
  const live = (await listRuntimeInstancesForPool(pool.id)).filter((r) => r.status === "active");
  expect(live).toHaveLength(1);
  expect(live[0]?.draining).toBe(false);
  expect((await getAgentById(agent.id))?.status).toBe("idle");
});

test("terminate and status failures do not prevent sibling cleanup", async () => {
  const first = await wake();
  const second = await wake();
  const third = await wake();
  for (const { task } of [first, second, third]) await completeTask(task.id, "done");
  const firstHandle = fake.requests[0]!;
  const handles = [...fake.runtimes.values()];
  handles[0]!.status = "exited";
  handles[1]!.status = "failed";
  fake.terminateFailures.set(handles[0]!.handle.externalId, firstHandle.env.API_KEY!);
  fake.statusFailures.add(handles[2]!.handle.externalId);
  await reconcileOnce();
  expect((await getRuntimeInstanceById(first.runtime.id))?.status).toBe("offline");
  expect((await getRuntimeInstanceById(second.runtime.id))?.status).toBe("offline");
  expect((await getRuntimeInstanceById(third.runtime.id))?.status).toBe("provisioning");
  expect(await resolveBySessionToken(firstHandle.env.API_KEY!)).toBeNull();
  expect(JSON.stringify(errorSpy.mock.calls)).not.toContain(firstHandle.env.API_KEY!);
});

test("a failed provision does not prevent another agent from waking", async () => {
  const { pool, agent } = await setup();
  const sibling = await createPoolAgent(pool.id, { name: "sibling", maxTasks: 1 });
  fake.provisionFailures.set(agent.id, "provision failed");
  await createTaskExtended("first", { agentId: agent.id });
  await createTaskExtended("second", { agentId: sibling.id });
  await reconcileOnce();
  const rows = await listRuntimeInstancesForPool(pool.id);
  expect(rows.find((r) => r.agentId === agent.id)?.status).toBe("offline");
  expect(rows.find((r) => r.agentId === sibling.id)?.status).toBe("provisioning");
});

test("stale active runtime is terminated and releases the pool cap", async () => {
  const { agent, runtime } = await wake({ maxRuntimes: 1 });
  await activate(runtime.id, agent.id);
  await getDbClient().run("UPDATE runtime_instances SET last_seen_at = ? WHERE id = ?", [
    new Date(Date.now() - 3_600_000).toISOString(),
    runtime.id,
  ]);
  const handle = [...fake.runtimes.values()][0]!.handle;
  fake.statusFailures.add(handle.externalId);
  fake.terminateFailures.set(handle.externalId, "delete failed");
  await reconcileOnce();
  expect((await getRuntimeInstanceById(runtime.id))?.status).toBe("offline");
  expect(fake.requests).toHaveLength(2);
  expect(await resolveBySessionToken(fake.requests[0]!.env.API_KEY!)).toBeNull();
});

test("fresh unknown runtime is preserved", async () => {
  const { runtime, agent } = await wake();
  await activate(runtime.id, agent.id);
  [...fake.runtimes.values()][0]!.status = "unknown";
  await reconcileOnce();
  expect((await getRuntimeInstanceById(runtime.id))?.status).toBe("active");
  expect(fake.terminated).toHaveLength(0);
  expect(fake.requests).toHaveLength(1);
});

test("heartbeat prunes stale offline pool rows and retains active pool rows", async () => {
  const { runtime, task, agent } = await wake();
  await activate(runtime.id, agent.id);
  await getDbClient().run("UPDATE runtime_instances SET last_seen_at = ? WHERE id = ?", [
    new Date(Date.now() - 3_600_000).toISOString(),
    runtime.id,
  ]);
  await expireStaleRuntimeInstances();
  expect((await getRuntimeInstanceById(runtime.id))?.status).toBe("active");
  await completeTask(task.id, "done");
  fake.runtimes.clear();
  await reconcileOnce();
  await expireStaleRuntimeInstances();
  expect(await getRuntimeInstanceById(runtime.id)).toBeNull();
});

test("disabled pool drains idle runtimes and sweeps orphans without booting", async () => {
  const { runtime, task, agent, pool } = await wake({ idleMinutes: null, minRuntimes: 1 });
  await activate(runtime.id, agent.id);
  await completeTask(task.id, "done");
  await getDbClient().run("UPDATE runtime_pools SET enabled = 0 WHERE id = ?", [pool.id]);
  const orphan: RuntimeHandle = {
    kind: "docker",
    externalId: crypto.randomUUID(),
    createdAt: new Date(Date.now() - 180_000).toISOString(),
  };
  fake.runtimes.set(orphan.externalId, {
    handle: orphan,
    owner: await ensureRuntimeOwnerId(),
    status: "running",
  });
  await createTaskExtended("wait for enabled pool", { agentId: agent.id });
  await reconcileOnce();
  expect((await getRuntimeInstanceById(runtime.id))?.draining).toBe(true);
  expect(fake.terminated).toContain(orphan.externalId);
  await reconcileOnce();
  expect((await getRuntimeInstanceById(runtime.id))?.status).toBe("offline");
  expect(fake.requests).toHaveLength(1);
});

test("unlinked runtimes receive an orphan grace period and failures remain isolated", async () => {
  await setup({ enabled: false });
  const owner = await ensureRuntimeOwnerId();
  const now = new Date();
  const recent: RuntimeHandle = {
    kind: "docker",
    externalId: "recent",
    createdAt: now.toISOString(),
  };
  const old: RuntimeHandle = {
    kind: "docker",
    externalId: "old",
    createdAt: new Date(now.getTime() - 180_000).toISOString(),
  };
  const unknownAge: RuntimeHandle = { kind: "docker", externalId: "unknown-age" };
  for (const handle of [old, recent, unknownAge])
    fake.runtimes.set(handle.externalId, { handle, owner, status: "running" });
  const secret = `orphan-error-${crypto.randomUUID()}`;
  registerVolatileSecret(secret, "test:orphan-error");
  fake.terminateFailures.set(old.externalId, secret);
  const commands = await getControllerCommands(controllerId);
  await reconcileControllerOrphans(controllerId, commands, owner, now);
  expect(fake.terminated).toEqual([old.externalId]);
  await reconcileControllerOrphans(
    controllerId,
    commands,
    owner,
    new Date(now.getTime() + 121_000),
  );
  expect(fake.terminated).toContain(recent.externalId);
  expect(fake.terminated).toContain(unknownAge.externalId);
  expect(JSON.stringify(errorSpy.mock.calls)).not.toContain(secret);
});

test("owner id is internal and repeated ticks use its cached value", async () => {
  const owner = await ensureRuntimeOwnerId();
  const query = spyOn(getDbClient(), "query");
  const transaction = spyOn(getDbClient(), "transaction");
  try {
    expect(await ensureRuntimeOwnerId()).toBe(owner);
    expect(query).not.toHaveBeenCalled();
    expect(transaction).not.toHaveBeenCalled();
  } finally {
    query.mockRestore();
    transaction.mockRestore();
  }
  expect((await getInjectableGlobalConfigs()).some((c) => c.key === "runtime_owner_id")).toBe(
    false,
  );
});

test("tick setup failures do not escape reconciliation or shutdown", async () => {
  for (const [module, name] of [
    [controllers, "ensureRuntimeOwnerId"],
    [poolDatabase, "listRuntimePools"],
  ] as const) {
    const failure = spyOn(module, name).mockRejectedValue(new Error("tick setup failed"));
    try {
      const tick = reconcileOnce();
      await expect(stopRuntimeSupervisor()).resolves.toBeUndefined();
      await expect(tick).resolves.toBeUndefined();
    } finally {
      failure.mockRestore();
    }
  }
  expect(errorSpy).toHaveBeenCalled();
});

test("offline controllers remain quiet across ticks while other failures log errors", async () => {
  await setup();
  const offline = async () => {
    throw new ControllerOfflineError(controllerId);
  };
  await reconcileOnce({ getControllerCommands: offline });
  await reconcileOnce({ getControllerCommands: offline });
  expect(errorSpy).not.toHaveBeenCalled();
  await reconcileOnce({
    getControllerCommands: async () => {
      throw new Error("controller command failed");
    },
  });
  expect(errorSpy).toHaveBeenCalledWith(
    "[runtime-pools] Supervisor failed:",
    "Error: controller command failed",
  );
});

test("shutdown returns after its bound and stops subsequent provisioning", async () => {
  process.env.RUNTIME_PROVISION_CONCURRENCY = "1";
  const { agent } = await setup();
  await createTaskExtended("first", { agentId: agent.id });
  await createTaskExtended("second", { agentId: agent.id });
  let release!: () => void;
  fake.gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tick = reconcileOnce();
  for (let i = 0; i < 100 && !fake.requests.length; i++) await Bun.sleep(5);
  expect(fake.requests).toHaveLength(1);
  const started = Date.now();
  await stopRuntimeSupervisor(20);
  expect(Date.now() - started).toBeLessThan(500);
  release();
  await tick;
  expect(fake.requests).toHaveLength(1);
  expect(errorSpy).toHaveBeenCalledWith("[runtime-pools] Supervisor shutdown timed out.");
});

test("runtime teardown removes the volatile token registration", async () => {
  const { runtime, task } = await wake();
  const value = `runtime-volatile-${crypto.randomUUID()}`;
  registerVolatileSecret(value, `runtime:${runtime.id}`);
  expect(scrubSecrets(`value=${value}`)).not.toContain(value);
  await completeTask(task.id, "done");
  fake.runtimes.clear();
  await reconcileOnce();
  expect(scrubSecrets(`value=${value}`)).toContain(value);
});

test("disabled pool also drains runtimes that have not registered", async () => {
  const { runtime, pool, task } = await wake();
  await completeTask(task.id, "done");
  await getDbClient().run("UPDATE runtime_pools SET enabled = 0 WHERE id = ?", [pool.id]);
  await reconcileOnce();
  expect((await getRuntimeInstanceById(runtime.id))?.draining).toBe(true);
  await reconcileOnce();
  expect((await getRuntimeInstanceById(runtime.id))?.status).toBe("offline");
  expect(fake.terminated).toHaveLength(1);
});

test("shutdown during budget admission prevents provisioning", async () => {
  const { agent } = await setup();
  await createTaskExtended("pending", { agentId: agent.id });
  let entered = false;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const budget = spyOn(admission, "canClaim").mockImplementation(async () => {
    entered = true;
    await gate;
    return { allowed: true };
  });
  const tick = reconcileOnce();
  try {
    for (let i = 0; i < 100 && !entered; i++) await Bun.sleep(5);
    expect(entered).toBe(true);
    await stopRuntimeSupervisor(20);
    release();
    await tick;
    expect(fake.requests).toHaveLength(0);
  } finally {
    release();
    await tick;
    budget.mockRestore();
  }
});

test("per-task runtime survives offer review before a real task finishes", async () => {
  const { runtime, task, agent } = await wake({ lifecycle: "per-task", maxRuntimes: 1 });
  await activate(runtime.id, agent.id);
  await getDbClient().run("UPDATE runtime_instances SET task_id = ? WHERE id = ?", [
    task.id,
    runtime.id,
  ]);
  await reconcileOnce();
  expect((await getRuntimeInstanceById(runtime.id))?.status).toBe("active");
  expect(fake.terminated).toHaveLength(0);
  await completeTask(task.id, "done");
  await reconcileOnce();
  expect((await getRuntimeInstanceById(runtime.id))?.status).toBe("active");
});
