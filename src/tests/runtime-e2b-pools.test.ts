import { afterAll, afterEach, beforeAll, beforeEach, expect, spyOn, test } from "bun:test";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import {
  closeDb,
  completeTask,
  createTaskExtended,
  getActiveSessionForTask,
  getChildTasks,
  getDbClient,
  getTaskById,
  initDb,
  startTask,
} from "../be/db";
import {
  getRuntimeInstanceById,
  listRuntimeInstancesForPool,
  upsertRuntimeInstance,
} from "../be/multi-runtime";
import * as controllers from "../be/runtime-pools/controllers";
import { getControllerCommands } from "../be/runtime-pools/controllers";
import {
  checkE2bControllerConfig,
  createPoolAgent,
  createRuntimeController,
  createRuntimePool,
  getRuntimeController,
  getRuntimeControllerTarget,
  getRuntimePool,
  updateRuntimeController,
  updateRuntimePool,
} from "../be/runtime-pools/db";
import { resolveE2bImage } from "../be/runtime-pools/e2b-images";
import { checkDisconnectedRuntime, startRuntimeRecovery } from "../be/runtime-pools/recovery";
import { reconcileOnce, stopRuntimeSupervisor } from "../be/runtime-pools/supervisor";
import { resolveBySessionToken } from "../be/users";
import * as dispatch from "../e2b/dispatch";
import { handleRuntimePools } from "../http/runtime-pools";
import { realtimeBus } from "../realtime/bus";
import type { ProvisionRequest, RuntimeHandle, RuntimeStatus } from "../runtime-providers";
import type { ControllerCommands } from "../runtime-providers/controller";
import { setRequestAuth } from "../utils/request-auth-context";

class FakeE2bController implements ControllerCommands {
  traits = {
    canProvision: true,
    ephemeralDisk: true,
    supportsPause: true,
    maxContinuousSec: 3600,
    maxTtlSec: 86400,
  };
  workerApiUrl = "https://swarm.test";
  requests: ProvisionRequest[] = [];
  terminated: string[] = [];
  resumed: string[] = [];
  renewed: Array<{ handle: RuntimeHandle; ttlSec: number }> = [];
  runtimes = new Map<string, { handle: RuntimeHandle; status: RuntimeStatus }>();
  renewFailure: "gone" | "unavailable" | null = null;
  endAt: string | null = null;
  async provision(req: ProvisionRequest): Promise<RuntimeHandle> {
    this.requests.push(req);
    const handle: RuntimeHandle = { kind: "e2b", externalId: crypto.randomUUID() };
    this.runtimes.set(handle.externalId, { handle, status: "running" });
    return handle;
  }
  async terminate(handle: RuntimeHandle) {
    this.terminated.push(handle.externalId);
    this.runtimes.delete(handle.externalId);
  }
  async status(handles: RuntimeHandle[]): Promise<Record<string, RuntimeStatus>> {
    return Object.fromEntries(
      handles.map((h) => [h.externalId, this.runtimes.get(h.externalId)?.status ?? "exited"]),
    );
  }
  async list() {
    return [...this.runtimes.values()].map((r) => r.handle);
  }
  async renew(handle: RuntimeHandle, ttlSec: number) {
    this.renewed.push({ handle, ttlSec });
    if (this.renewFailure) {
      if (this.renewFailure === "gone") this.runtimes.delete(handle.externalId);
      throw new Error("Lease renewal failed");
    }
    return { endAt: this.endAt ?? new Date(now.getTime() + ttlSec * 1000).toISOString() };
  }
  async resume(handle: RuntimeHandle) {
    this.resumed.push(handle.externalId);
    this.runtimes.get(handle.externalId)!.status = "running";
  }
}

const dbPath = "./test-runtime-e2b-pools.sqlite";
const keys = [
  "RUNTIME_POOLS_ENABLED",
  "MULTI_RUNTIME_ENABLED",
  "RUNTIME_WORKER_API_URL",
  "PUBLIC_MCP_BASE_URL",
  "E2B_API_KEY",
  "E2B_API_BASE",
  "E2B_MAX_CONTINUOUS_SEC",
  "RUNTIME_LEASE_RENEW_BEFORE_SEC",
  "RUNTIME_ROTATE_BEFORE_SEC",
  "SECRETS_ENCRYPTION_KEY",
  "RUNTIME_CIRCUIT_THRESHOLD",
  "RUNTIME_E2B_BUILD_TIMEOUT_SEC",
  "RUNTIME_SOCKET_GRACE_SEC",
  "MCP_BASE_URL",
];
const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
let fake: FakeE2bController;
let now: Date;
let controllerId: string;
let buildSpy: ReturnType<typeof spyOn<typeof dispatch, "buildImageTemplate">>;
let errorSpy: ReturnType<typeof spyOn<typeof console, "error">>;
beforeAll(() => {
  closeDb();
  initDb(dbPath);
});
beforeEach(async () => {
  await stopRuntimeSupervisor();
  for (const key of keys) delete process.env[key];
  process.env.RUNTIME_POOLS_ENABLED = "true";
  process.env.MULTI_RUNTIME_ENABLED = "true";
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
  ])
    await getDbClient().run(`DELETE FROM ${table}`);
  fake = new FakeE2bController();
  now = new Date();
  controllerId = (
    await createRuntimeController({
      name: "e2b",
      kind: "e2b",
      placement: "builtin",
      config: { WORKER_API_URL: fake.workerApiUrl },
      secretConfig: { E2B_API_KEY: `fake-${crypto.randomUUID()}` },
    })
  ).id;
  buildSpy = spyOn(dispatch, "buildImageTemplate").mockResolvedValue({
    exitCode: 0,
    stdout: "Built template",
    stderr: "",
  });
  errorSpy = spyOn(console, "error").mockImplementation(() => {});
});
afterEach(async () => {
  await stopRuntimeSupervisor();
  buildSpy.mockRestore();
  errorSpy.mockRestore();
});
afterAll(async () => {
  closeDb();
  for (const suffix of ["", "-wal", "-shm"])
    await Bun.file(dbPath + suffix)
      .delete()
      .catch(() => {});
  for (const key of keys) {
    if (previous[key] === undefined) delete process.env[key];
    else process.env[key] = previous[key];
  }
});
async function tick(seconds = 0) {
  now = new Date(now.getTime() + seconds * 1000);
  await getDbClient().run("UPDATE runtime_instances SET last_seen_at = ? WHERE status = 'active'", [
    now.toISOString(),
  ]);
  await reconcileOnce({ now, getControllerCommands: async () => fake });
}
async function waitUntil(check: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 2000;
  while (!(await check())) {
    if (Date.now() >= deadline) throw new Error("Condition did not become true");
    await Bun.sleep(5);
  }
}
async function builtImage(poolId: string): Promise<string> {
  let image: string | null = null;
  await waitUntil(async () => {
    image = await resolveE2bImage(poolId);
    return image !== null;
  });
  return image!;
}
async function setup(options: Partial<Parameters<typeof createRuntimePool>[0]> = {}) {
  const pool = await createRuntimePool({
    name: crypto.randomUUID(),
    kind: "e2b",
    placements: [controllerId],
    image: "worker-template",
    ...options,
  });
  const agent = await createPoolAgent(pool.id, { name: crypto.randomUUID(), maxTasks: 2 });
  const task = await createTaskExtended("Waiting work", { agentId: agent.id });
  return { pool, agent, task };
}
async function wake(options: Partial<Parameters<typeof createRuntimePool>[0]> = {}) {
  const state = await setup(options);
  await tick();
  if (state.pool.image?.startsWith("docker://")) {
    await builtImage(state.pool.id);
    await tick();
  }
  const runtime = (await listRuntimeInstancesForPool(state.pool.id))[0]!;
  await upsertRuntimeInstance({ id: runtime.id, agentId: state.agent.id, reportedSlots: 1 });
  return { ...state, runtime };
}
async function busy(options: Partial<Parameters<typeof createRuntimePool>[0]> = {}) {
  const state = await wake(options);
  await startTask(state.task.id);
  await getDbClient().run(
    "INSERT INTO active_sessions (id, agentId, taskId, triggerType, runtimeInstanceId) VALUES (?, ?, ?, 'task_assigned', ?)",
    [crypto.randomUUID(), state.agent.id, state.task.id, state.runtime.id],
  );
  await getDbClient().run("UPDATE runtime_instances SET task_id = ? WHERE id = ?", [
    state.task.id,
    state.runtime.id,
  ]);
  return state;
}

test("pending work provisions an E2B runtime with a short lease", async () => {
  const { pool, agent } = await setup();
  await tick();
  expect(fake.requests).toHaveLength(1);
  expect(fake.requests[0]).toMatchObject({
    ttlSec: 900,
    image: "worker-template",
    agentId: agent.id,
  });
  const runtime = (await listRuntimeInstancesForPool(pool.id))[0]!;
  expect(runtime.leaseExpiresAt).toBe(new Date(now.getTime() + 900_000).toISOString());
  expect(runtime.status).toBe("provisioning");
  await tick(1);
  expect(fake.requests).toHaveLength(1);
});

test("renews active and provisioning runtimes before expiry and stores the clamped expiry", async () => {
  const { runtime } = await wake({ ttlSec: 600 });
  await tick(299);
  expect(fake.renewed).toHaveLength(0);
  fake.endAt = new Date(now.getTime() + 450_000).toISOString();
  await tick(1);
  expect(fake.renewed[0]?.ttlSec).toBe(600);
  expect((await getRuntimeInstanceById(runtime.id))?.leaseExpiresAt).toBe(fake.endAt);
  const provisioning = await setup({ ttlSec: 300 });
  await tick();
  const pendingRuntime = (await listRuntimeInstancesForPool(provisioning.pool.id))[0]!;
  expect(fake.requests.find((r) => r.runtimeId === pendingRuntime.id)?.ttlSec).toBe(360);
  await getDbClient().run("UPDATE runtime_instances SET lease_expires_at = ? WHERE id = ?", [
    new Date(now.getTime() + 300_000).toISOString(),
    pendingRuntime.id,
  ]);
  await tick(1);
  expect(
    fake.renewed.some((r) => r.handle.externalId === pendingRuntime.externalHandle!.externalId),
  ).toBe(true);
  expect((await listRuntimeInstancesForPool(provisioning.pool.id))[0]?.leaseExpiresAt).toBe(
    fake.endAt,
  );
});

test("does not renew a runtime reaped after its task exit grace", async () => {
  const { task, runtime } = await busy({ ttlSec: 300, lifecycle: "per-task" });
  await completeTask(task.id, "Done");
  await getDbClient().run("DELETE FROM active_sessions WHERE taskId = ?", [task.id]);
  await tick(61);
  expect((await getRuntimeInstanceById(runtime.id))?.status).toBe("offline");
  expect(fake.renewed).toHaveLength(0);
});

test("rotates an idle runtime before the continuous limit", async () => {
  const { pool, runtime } = await wake({ minRuntimes: 1, maxRuntimes: 2 });
  await tick(2999);
  expect((await getRuntimeInstanceById(runtime.id))?.draining).toBe(false);
  await tick(1);
  expect((await getRuntimeInstanceById(runtime.id))?.draining).toBe(true);
  expect(fake.requests).toHaveLength(2);
  await tick(1);
  expect(fake.terminated).toContain(runtime.externalHandle!.externalId);
  expect(
    (await listRuntimeInstancesForPool(pool.id)).filter((r) => r.status !== "offline"),
  ).toHaveLength(1);
});

test("drains a busy runtime, creates a replacement within the pool cap, and terminates after completion", async () => {
  const { agent, task, runtime } = await busy({ maxRuntimes: 2 });
  await createTaskExtended("Next work", { agentId: agent.id });
  await tick(3000);
  expect((await getRuntimeInstanceById(runtime.id))?.draining).toBe(true);
  expect(fake.requests).toHaveLength(2);
  expect(fake.terminated).toHaveLength(0);
  await completeTask(task.id, "Done");
  await getDbClient().run("DELETE FROM active_sessions WHERE taskId = ?", [task.id]);
  await tick(1);
  expect(fake.terminated).toContain(runtime.externalHandle!.externalId);
  expect(fake.resumed).toHaveLength(0);
});

test("resumes an idle paused runtime that is still wanted", async () => {
  const { runtime } = await wake();
  fake.runtimes.get(runtime.externalHandle!.externalId)!.status = "paused";
  await tick(1);
  expect(fake.resumed).toEqual([runtime.externalHandle!.externalId]);
  expect((await getRuntimeInstanceById(runtime.id))?.status).toBe("active");
  expect(fake.terminated).toHaveLength(0);
  expect(fake.renewed).toHaveLength(1);
});

test("a paused status remains authoritative when the running list omits the sandbox", async () => {
  const { runtime } = await wake();
  fake.runtimes.get(runtime.externalHandle!.externalId)!.status = "paused";
  const list = spyOn(fake, "list").mockResolvedValue([]);
  try {
    await reconcileOnce({
      now: new Date(now.getTime() + 600_000),
      getControllerCommands: async () => fake,
    });
    expect(fake.resumed).toEqual([runtime.externalHandle!.externalId]);
    expect((await getRuntimeInstanceById(runtime.id))?.status).toBe("active");
  } finally {
    list.mockRestore();
  }
});

test("an idle timeout makes a paused runtime unwanted", async () => {
  const { runtime } = await wake({ idleMinutes: 1 });
  await getDbClient().run("UPDATE runtime_instances SET idle_since = ? WHERE id = ?", [
    now.toISOString(),
    runtime.id,
  ]);
  fake.runtimes.get(runtime.externalHandle!.externalId)!.status = "paused";
  await tick(61);
  expect(fake.terminated).toEqual([runtime.externalHandle!.externalId]);
  expect(fake.resumed).toHaveLength(0);
});

test("the pool cap still applies while a busy runtime rotates", async () => {
  const { agent, runtime } = await busy({ maxRuntimes: 1 });
  await createTaskExtended("More work", { agentId: agent.id });
  await tick(3000);
  expect((await getRuntimeInstanceById(runtime.id))?.draining).toBe(true);
  expect(fake.requests).toHaveLength(1);
  expect(fake.terminated).toHaveLength(0);
});

test("Pro rotation and configured renewal windows use seconds", async () => {
  fake.traits.maxContinuousSec = 86400;
  process.env.RUNTIME_ROTATE_BEFORE_SEC = "1200";
  process.env.RUNTIME_LEASE_RENEW_BEFORE_SEC = "60";
  const { runtime } = await wake({ minRuntimes: 1 });
  await getDbClient().run("UPDATE session_tokens SET expiresAt = ? WHERE runtimeId = ?", [
    new Date(now.getTime() + 172_800_000).toISOString(),
    runtime.id,
  ]);
  await tick(839);
  expect(fake.renewed).toHaveLength(0);
  await tick(1);
  expect(fake.renewed).toHaveLength(1);
  await tick(85199 - 840);
  expect((await getRuntimeInstanceById(runtime.id))?.draining).toBe(false);
  await tick(1);
  expect((await getRuntimeInstanceById(runtime.id))?.draining).toBe(true);
});

test("lease expiry recovers a sandbox that disappears from the provider", async () => {
  const { task, runtime } = await busy({ ttlSec: 300 });
  fake.runtimes.delete(runtime.externalHandle!.externalId);
  await tick(301);
  expect((await getTaskById(task.id))?.status).toBe("superseded");
  expect((await getRuntimeInstanceById(runtime.id))?.status).toBe("offline");
  expect(fake.renewed).toHaveLength(0);
});

test("recovers tasks from a busy paused runtime and terminates its sandbox", async () => {
  const { task, runtime } = await busy();
  fake.runtimes.get(runtime.externalHandle!.externalId)!.status = "paused";
  await tick(1);
  expect((await getTaskById(task.id))?.status).toBe("superseded");
  expect(await getActiveSessionForTask(task.id)).toBeNull();
  expect((await getChildTasks(task.id)).filter((t) => t.taskType === "resume")).toHaveLength(1);
  expect(fake.terminated).toEqual([runtime.externalHandle!.externalId]);
  expect(fake.resumed).toHaveLength(0);
  expect(await resolveBySessionToken(fake.requests[0]!.env.API_KEY!)).toBeNull();
  expect(fake.requests).toHaveLength(2);
});

test("terminates an unwanted paused runtime without resuming or renewing", async () => {
  const { pool, runtime } = await wake({ ttlSec: 300 });
  fake.runtimes.get(runtime.externalHandle!.externalId)!.status = "paused";
  await updateRuntimePool(pool.id, { enabled: false });
  await tick(1);
  expect(fake.terminated).toEqual([runtime.externalHandle!.externalId]);
  expect(fake.resumed).toHaveLength(0);
  expect(fake.renewed).toHaveLength(0);
});

test("a failed renew waits for the next full reap to recover confirmed death", async () => {
  const { task, runtime } = await busy({ ttlSec: 300 });
  fake.renewFailure = "gone";
  await tick(61);
  expect((await getRuntimeInstanceById(runtime.id))?.status).toBe("active");
  expect((await getTaskById(task.id))?.status).toBe("in_progress");
  await tick(1);
  expect((await getRuntimeInstanceById(runtime.id))?.status).toBe("offline");
  expect((await getTaskById(task.id))?.status).toBe("superseded");
  expect(fake.requests).toHaveLength(2);
});

test("a failed renew does not kill a runtime that the provider still reports running", async () => {
  const { task, runtime } = await busy({ ttlSec: 300 });
  fake.renewFailure = "unavailable";
  await tick(61);
  expect(fake.renewed).toHaveLength(1);
  expect((await getRuntimeInstanceById(runtime.id))?.status).toBe("active");
  expect((await getTaskById(task.id))?.status).toBe("in_progress");
  expect(fake.terminated).toHaveLength(0);
});

test("builds docker images once, caches the template, and rebuilds after image PATCH", async () => {
  const { pool, agent } = await wake({ image: "docker://ghcr.io/acme/worker:1.2", minRuntimes: 2 });
  expect(buildSpy).toHaveBeenCalledTimes(1);
  const expected = `swarm-${new Bun.CryptoHasher("sha256")
    .update(JSON.stringify(["ghcr.io/acme/worker:1.2", 4, 8192]))
    .digest("hex")
    .slice(0, 12)}`;
  expect((await getRuntimePool(pool.id))?.resolvedImage).toBe(expected);
  expect(fake.requests.map((r) => r.image)).toEqual([expected, expected]);
  expect(buildSpy.mock.calls[0]?.[0]).toMatchObject({
    name: expected,
    image: "ghcr.io/acme/worker:1.2",
    cpuCount: 4,
    memoryMb: 8192,
  });
  expect(buildSpy.mock.calls[0]?.[0].e2bEnv.E2B_API_KEY).toBeDefined();
  await updateRuntimePool(pool.id, { idleMinutes: 2 });
  expect((await getRuntimePool(pool.id))?.resolvedImage).toBe(expected);
  await updateRuntimePool(pool.id, { image: "docker://ghcr.io/acme/worker:1.3" });
  expect((await getRuntimePool(pool.id))?.resolvedImage).toBeNull();
  expect(await builtImage(pool.id)).not.toBe(expected);
  expect(buildSpy).toHaveBeenCalledTimes(2);
  expect(agent.runtimePoolId).toBe(pool.id);
});

test("an image changed during a build cannot cache a stale template", async () => {
  const { pool } = await setup({ image: "docker://old-image" });
  buildSpy.mockImplementation(async () => {
    await updateRuntimePool(pool.id, { image: "docker://new-image" });
    return { exitCode: 0, stdout: "Built", stderr: "" };
  });
  expect(await resolveE2bImage(pool.id)).toBeNull();
  await waitUntil(async () => (await getRuntimePool(pool.id))?.image === "docker://new-image");
  expect((await getRuntimePool(pool.id))?.resolvedImage).toBeNull();
});

test("template keys include CPU and memory, and resource PATCH invalidates the cache", async () => {
  const { pool } = await setup({ image: "docker://same-image" });
  const differentCpu = await setup({ image: pool.image!, resources: { cpu: 2 } });
  const differentMemory = await setup({ image: pool.image!, resources: { memoryMb: 4096 } });
  const images = await Promise.all(
    [pool, differentCpu.pool, differentMemory.pool].map((p) => builtImage(p.id)),
  );
  expect(new Set(images).size).toBe(3);
  await updateRuntimePool(pool.id, { resources: { cpu: 2, memoryMb: 8192 } });
  expect((await getRuntimePool(pool.id))?.resolvedImage).toBeNull();
  expect(await builtImage(pool.id)).toBe(images[1]!);
  await updateRuntimePool(pool.id, { resources: { cpu: 2, memoryMb: 4096 } });
  expect((await getRuntimePool(pool.id))?.resolvedImage).toBeNull();
  expect(await builtImage(pool.id)).not.toBe(images[1]!);
});

test("a resource change during a build cannot cache the obsolete template", async () => {
  const { pool } = await setup({ image: "docker://same-image" });
  buildSpy.mockImplementation(async () => {
    await updateRuntimePool(pool.id, { resources: { cpu: 2 } });
    return { exitCode: 0, stdout: "Built", stderr: "" };
  });
  expect(await resolveE2bImage(pool.id)).toBeNull();
  await waitUntil(async () => (await getRuntimePool(pool.id))?.resources?.cpu === 2);
  expect((await getRuntimePool(pool.id))?.resolvedImage).toBeNull();
});

test("a pending build does not block another pool renewal or count as a failure", async () => {
  const { runtime } = await wake({ ttlSec: 600 });
  const { pool, agent } = await setup({ image: "docker://slow-image" });
  buildSpy.mockImplementation(() => new Promise(() => {}));
  await tick(300);
  expect(fake.renewed).toHaveLength(1);
  expect(fake.renewed[0]?.handle.externalId).toBe(runtime.externalHandle!.externalId);
  await tick(60);
  expect(buildSpy).toHaveBeenCalledTimes(1);
  expect(await listRuntimeInstancesForPool(pool.id)).toHaveLength(0);
  expect((await getRuntimePool(pool.id))?.consecutiveFailures).toBe(0);
  expect(
    (
      await getDbClient().get<{ attempts: number }>(
        "SELECT runtime_provision_attempts AS attempts FROM agents WHERE id = ?",
        [agent.id],
      )
    )?.attempts,
  ).toBe(0);
});

test("shutdown aborts a build and its late completion provisions nothing", async () => {
  const { pool } = await setup({ image: "docker://slow-image" });
  let finish!: () => void;
  buildSpy.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = () => resolve({ exitCode: 0, stdout: "Built", stderr: "" });
      }),
  );
  await tick();
  await waitUntil(() => buildSpy.mock.calls.length === 1);
  const signal = buildSpy.mock.calls[0]![0].signal!;
  await stopRuntimeSupervisor();
  expect(signal.aborted).toBe(true);
  finish();
  // The DB read lets the build continuation observe the abort before checking its cache.
  expect((await getRuntimePool(pool.id))?.resolvedImage).toBeNull();
  expect(fake.requests).toHaveLength(0);
  expect(await listRuntimeInstancesForPool(pool.id)).toHaveLength(0);
});

test("a build timeout aborts the SDK request and uses provision backoff", async () => {
  process.env.RUNTIME_E2B_BUILD_TIMEOUT_SEC = "1";
  const { pool } = await setup({ image: "docker://slow-image" });
  buildSpy.mockImplementation(() => new Promise(() => {}));
  await tick();
  await waitUntil(() => buildSpy.mock.calls.length === 1);
  const signal = buildSpy.mock.calls[0]![0].signal!;
  await waitUntil(() => signal.aborted);
  await tick();
  expect((await getRuntimePool(pool.id))?.lastError).toContain("exceeded 1s");
  await tick(1);
  expect(buildSpy).toHaveBeenCalledTimes(1);
});

test("template builds receive only E2B connection settings", async () => {
  await updateRuntimeController(controllerId, {
    config: {
      WORKER_API_URL: fake.workerApiUrl,
      E2B_API_BASE: "https://e2b.test",
      E2B_DOMAIN: "domain.test",
      E2B_SANDBOX_URL: "https://sandbox.test",
    },
    secretConfig: { OTHER_SECRET: "must-not-reach-sdk" },
  });
  const { pool } = await setup({ image: "docker://worker-image" });
  await builtImage(pool.id);
  expect(Object.keys(buildSpy.mock.calls[0]![0].e2bEnv).sort()).toEqual([
    "E2B_API_KEY",
    "E2B_API_URL",
    "E2B_DOMAIN",
    "E2B_SANDBOX_URL",
  ]);
  expect(buildSpy.mock.calls[0]![0].e2bEnv).toMatchObject({
    E2B_API_URL: "https://e2b.test",
    E2B_DOMAIN: "domain.test",
    E2B_SANDBOX_URL: "https://sandbox.test",
  });
});

test("a failed renewal preserves the warm floor and the two-tick idle drain", async () => {
  const { pool, runtime } = await wake({
    ttlSec: 300,
    idleMinutes: 1,
    minRuntimes: 1,
    maxRuntimes: 2,
  });
  const runtimes = await listRuntimeInstancesForPool(pool.id);
  // Add a second warm runtime to exercise the full pool count.
  await updateRuntimePool(pool.id, { minRuntimes: 2 });
  await tick();
  const sibling = (await listRuntimeInstancesForPool(pool.id)).find((r) => r.id !== runtime.id)!;
  await upsertRuntimeInstance({ id: sibling.id, agentId: runtime.agentId, reportedSlots: 1 });
  await updateRuntimePool(pool.id, { minRuntimes: 1 });
  await getDbClient().run("UPDATE runtime_instances SET idle_since = ? WHERE pool_id = ?", [
    now.toISOString(),
    pool.id,
  ]);
  fake.renewFailure = "unavailable";
  await tick(61);
  expect((await getRuntimeInstanceById(runtime.id))?.draining).toBe(true);
  expect(fake.terminated).toHaveLength(0);
  await tick(1);
  expect(fake.terminated).toHaveLength(1);
  expect(
    (await listRuntimeInstancesForPool(pool.id)).filter((r) => r.status !== "offline"),
  ).toHaveLength(1);
  expect(runtimes).toHaveLength(1);
});

async function socketGrace(
  runtime: { id: string; agentId: string },
  done: () => boolean | Promise<boolean>,
) {
  process.env.RUNTIME_SOCKET_GRACE_SEC = "0";
  const commands = spyOn(controllers, "getControllerCommands").mockResolvedValue(fake);
  try {
    startRuntimeRecovery();
    realtimeBus.publish("worker.socket.disconnected", {
      agentId: runtime.agentId,
      runtimeId: runtime.id,
    });
    await waitUntil(done);
  } finally {
    commands.mockRestore();
  }
}

test("socket grace resumes a wanted idle paused runtime", async () => {
  const { runtime } = await wake({ delivery: "push" });
  fake.runtimes.get(runtime.externalHandle!.externalId)!.status = "paused";
  await socketGrace(runtime, () => fake.resumed.length === 1);
  expect((await getRuntimeInstanceById(runtime.id))?.status).toBe("active");
  expect(fake.terminated).toHaveLength(0);
});

test("socket grace counts paused siblings toward the idle warm floor", async () => {
  const { pool, runtime } = await wake({ delivery: "push", minRuntimes: 2, idleMinutes: 1 });
  const runtimes = await listRuntimeInstancesForPool(pool.id);
  for (const row of runtimes) {
    await upsertRuntimeInstance({ id: row.id, agentId: row.agentId, reportedSlots: 1 });
    fake.runtimes.get(row.externalHandle!.externalId)!.status = "paused";
  }
  await updateRuntimePool(pool.id, { minRuntimes: 1 });
  await getDbClient().run(
    "UPDATE runtime_instances SET idle_since = ?, last_seen_at = ? WHERE pool_id = ?",
    [
      new Date(Date.now() - 61_000).toISOString(),
      new Date(Date.now() - 30 * 60_000).toISOString(),
      pool.id,
    ],
  );
  await socketGrace(
    runtime,
    async () => (await getRuntimeInstanceById(runtime.id))?.status === "offline",
  );
  expect(fake.terminated).toEqual([runtime.externalHandle!.externalId]);
  expect(fake.resumed).toHaveLength(0);
});

test("socket grace terminates a busy paused runtime before task recovery", async () => {
  const { task, runtime } = await busy({ delivery: "push" });
  fake.runtimes.get(runtime.externalHandle!.externalId)!.status = "paused";
  const terminate = spyOn(fake, "terminate").mockImplementation(async (handle) => {
    expect((await getTaskById(task.id))?.status).toBe("in_progress");
    fake.terminated.push(handle.externalId);
    fake.runtimes.delete(handle.externalId);
  });
  try {
    await socketGrace(runtime, async () => (await getTaskById(task.id))?.status === "superseded");
    expect(fake.terminated).toEqual([runtime.externalHandle!.externalId]);
    expect(fake.resumed).toHaveLength(0);
    expect(await getActiveSessionForTask(task.id)).toBeNull();
  } finally {
    terminate.mockRestore();
  }
});

for (const unwanted of ["disabled", "rotation", "idle", "per-task"] as const) {
  test(`socket grace terminates an unwanted paused runtime: ${unwanted}`, async () => {
    const { pool, task, runtime } = await wake({
      delivery: "push",
      ...(unwanted === "idle" ? { idleMinutes: 1 } : {}),
      ...(unwanted === "per-task" ? { lifecycle: "per-task" } : {}),
    });
    fake.runtimes.get(runtime.externalHandle!.externalId)!.status = "paused";
    if (unwanted === "disabled") await updateRuntimePool(pool.id, { enabled: false });
    if (unwanted === "rotation")
      await getDbClient().run("UPDATE runtime_instances SET created_at = ? WHERE id = ?", [
        new Date(Date.now() - 3001_000).toISOString(),
        runtime.id,
      ]);
    if (unwanted === "idle")
      await getDbClient().run("UPDATE runtime_instances SET idle_since = ? WHERE id = ?", [
        new Date(Date.now() - 61_000).toISOString(),
        runtime.id,
      ]);
    if (unwanted === "per-task") {
      await startTask(task.id);
      await completeTask(task.id, "Done");
      await getDbClient().run("UPDATE runtime_instances SET task_id = ? WHERE id = ?", [
        task.id,
        runtime.id,
      ]);
    }
    await socketGrace(
      runtime,
      async () => (await getRuntimeInstanceById(runtime.id))?.status === "offline",
    );
    expect(fake.terminated).toEqual([runtime.externalHandle!.externalId]);
    expect(fake.resumed).toHaveLength(0);
  });
}

test("socket grace and the reaper serialize paused actions for the same runtime", async () => {
  const { runtime } = await wake({ delivery: "push" });
  fake.runtimes.get(runtime.externalHandle!.externalId)!.status = "paused";
  let finish!: () => void;
  let started = false;
  const resume = spyOn(fake, "resume").mockImplementation(async (handle) => {
    started = true;
    await new Promise<void>((resolve) => {
      finish = resolve;
    });
    fake.resumed.push(handle.externalId);
    fake.runtimes.get(handle.externalId)!.status = "running";
  });
  const commands = spyOn(controllers, "getControllerCommands").mockResolvedValue(fake);
  try {
    const check = checkDisconnectedRuntime(runtime.id);
    await waitUntil(() => started);
    const reaping = tick();
    await Bun.sleep(5);
    expect(resume).toHaveBeenCalledTimes(1);
    finish();
    await Promise.all([check, reaping]);
    expect(resume).toHaveBeenCalledTimes(1);
    expect(fake.terminated).toHaveLength(0);
  } finally {
    resume.mockRestore();
    commands.mockRestore();
  }
});

test("image build failures use provision backoff and the circuit breaker", async () => {
  process.env.RUNTIME_CIRCUIT_THRESHOLD = "1";
  const { pool, agent } = await setup({ image: "docker://missing-image" });
  buildSpy.mockRejectedValue(new Error("Registry image missing"));
  await tick();
  await waitUntil(async () => {
    await tick();
    return (await getRuntimePool(pool.id))?.consecutiveFailures === 1;
  });
  expect(await listRuntimeInstancesForPool(pool.id)).toHaveLength(0);
  expect((await getRuntimePool(pool.id))?.lastError).toContain("Registry image missing");
  expect((await getRuntimePool(pool.id))?.consecutiveFailures).toBe(1);
  expect((await getRuntimePool(pool.id))?.circuitOpenUntil).not.toBeNull();
  expect(fake.requests).toHaveLength(0);
  await tick(1);
  expect(buildSpy).toHaveBeenCalledTimes(1);
  expect(agent.runtimePoolId).toBe(pool.id);
});

test("controller readiness preserves provision errors and accepts deployment URL fallbacks", async () => {
  const id = (await createRuntimeController({ name: "unready", kind: "e2b", placement: "builtin" }))
    .id;
  const controller = (await getRuntimeController(id))!;
  expect((await checkE2bControllerConfig(controller)).ready).toBe(false);
  expect((await getRuntimeController(id))?.status).toBe("offline");
  expect((await getRuntimeController(id))?.lastError).toContain("WORKER_API_URL");
  process.env.E2B_API_KEY = `fake-${crypto.randomUUID()}`;
  process.env.RUNTIME_WORKER_API_URL = "https://swarm.test";
  process.env.E2B_MAX_CONTINUOUS_SEC = "86400";
  expect((await checkE2bControllerConfig((await getRuntimeController(id))!)).ready).toBe(false);
  expect((await getRuntimeControllerTarget(controller)).E2B_API_KEY).toBeUndefined();
  await updateRuntimeController(id, {
    secretConfig: { E2B_API_KEY: `stored-${crypto.randomUUID()}` },
  });
  const commands = await getControllerCommands(id);
  expect(commands.traits.maxContinuousSec).toBe(86400);
  expect((await getRuntimeController(id))?.status).toBe("online");
  expect((await getRuntimeController(id))?.lastError).toBeNull();
  const failedAt = new Date(0).toISOString();
  await getDbClient().run(
    "UPDATE runtime_controllers SET last_error = ?, last_error_at = ?, updated_at = ? WHERE id = ?",
    ["Provision failed", failedAt, failedAt, id],
  );
  await getControllerCommands(id);
  await getControllerCommands(id);
  expect(await getRuntimeController(id)).toMatchObject({
    lastError: "Provision failed",
    lastErrorAt: failedAt,
    updatedAt: failedAt,
  });
});

test("configuration validates the same controller URL that provisioning injects", async () => {
  process.env.RUNTIME_WORKER_API_URL = "http://deployment.test";
  process.env.PUBLIC_MCP_BASE_URL = "https://public.test";
  await updateRuntimeController(controllerId, {
    config: {
      RUNTIME_WORKER_API_URL: "https://controller.test",
      PUBLIC_MCP_BASE_URL: "https://controller-public.test",
    },
  });
  const commands = await getControllerCommands(controllerId);
  expect(commands.workerApiUrl).toBe("https://controller.test");
  fake.workerApiUrl = commands.workerApiUrl!;
  await setup();
  await tick();
  expect(fake.requests[0]?.env.MCP_BASE_URL).toBe("https://controller.test");
  await updateRuntimeController(controllerId, {
    config: { PUBLIC_MCP_BASE_URL: "https://public.test" },
  });
  await expect(getControllerCommands(controllerId)).rejects.toThrow("HTTPS");
  delete process.env.RUNTIME_WORKER_API_URL;
  process.env.MCP_BASE_URL = "https://api-fallback.test/";
  delete process.env.PUBLIC_MCP_BASE_URL;
  await updateRuntimeController(controllerId, { config: {} });
  expect((await getControllerCommands(controllerId)).workerApiUrl).toBe(
    "https://api-fallback.test",
  );
});

test("pool creation succeeds with a warning when builtin E2B is unready", async () => {
  const controller = await createRuntimeController(
    { name: "builtin-e2b", kind: "e2b", placement: "builtin" },
    null,
    "builtin-e2b",
  );
  const req = Readable.from([
    JSON.stringify({
      name: "unready-pool",
      kind: "e2b",
      placements: [controller.id],
      image: "worker-template",
    }),
  ]) as IncomingMessage;
  req.method = "POST";
  req.headers = { "content-type": "application/json" };
  setRequestAuth(req, { kind: "operator" });
  let status = 0;
  let body = "";
  const res = {
    setHeader() {},
    writeHead(code: number) {
      status = code;
    },
    end(chunk: string) {
      body += chunk;
    },
  } as unknown as ServerResponse;
  await handleRuntimePools(req, res, ["api", "runtime-pools"], new URLSearchParams());
  expect(status).toBe(200);
  expect(JSON.parse(body).warning).toContain("HTTPS");
  expect(JSON.parse(body).pool.name).toBe("unready-pool");
});
