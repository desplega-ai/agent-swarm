import { afterAll, afterEach, beforeAll, beforeEach, expect, spyOn, test } from "bun:test";
import { createServer, type Server } from "node:http";
import WebSocket from "ws";
import {
  closeDb,
  createTaskExtended,
  getActiveSessionForTask,
  getAgentById,
  getDbClient,
  getTaskById,
  initDb,
  startTask,
} from "../be/db";
import {
  getRuntimeInstanceById,
  listRuntimeInstancesForPool,
  markRuntimeTerminated,
  upsertRuntimeInstance,
} from "../be/multi-runtime";
import {
  clearRuntimeOwnerIdCache,
  ensureRuntimeOwnerId,
  getControllerCommands,
  reconcileDisconnectedControllers,
} from "../be/runtime-pools/controllers";
import {
  createPoolAgent,
  createRuntimeController,
  createRuntimePool,
  getRuntimeController,
  getRuntimePool,
  updateRuntimeController,
} from "../be/runtime-pools/db";
import { remoteControllerSession } from "../be/runtime-pools/remote-controller";
import {
  provisionRuntime,
  reconcileOnce,
  stopRuntimeSupervisor,
} from "../be/runtime-pools/supervisor";
import { mintControllerToken } from "../be/runtime-pools/tokens";
import { resolveBySessionToken } from "../be/users";
import { startControllerClient } from "../commands/controller";
import { attachControllerTransport } from "../http/controllers-connect";
import { attachRealtimeTransport } from "../realtime/transport";
import type {
  ProvisionRequest,
  RuntimeHandle,
  RuntimeProvider,
  RuntimeStatus,
  RuntimeTargetConfig,
} from "../runtime-providers";
import { ControllerOfflineError } from "../runtime-providers/controller";
import { RUNTIME_LABELS } from "../runtime-providers/types";
import { listenOnFreePort } from "./test-net";
import { CHILD_PROCESS_TEST_BUDGET_MS, runChild } from "./test-proc";

class FakeProvider implements RuntimeProvider {
  readonly kind = "docker" as const;
  readonly traits = { canProvision: true, ephemeralDisk: true, supportsPause: false };
  requests: ProvisionRequest[] = [];
  terminated: string[] = [];
  owners: string[] = [];
  runtimes = new Map<string, { handle: RuntimeHandle; ownerId: string; status: RuntimeStatus }>();
  gate?: Promise<void>;
  checkConfig() {
    return { ready: true, missing: [] };
  }
  async provision(_target: RuntimeTargetConfig, req: ProvisionRequest) {
    this.requests.push(req);
    await this.gate;
    const handle: RuntimeHandle = {
      kind: this.kind,
      externalId: crypto.randomUUID(),
      meta: req.labels,
    };
    this.runtimes.set(handle.externalId, { handle, ownerId: req.ownerId, status: "running" });
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
    return [...this.runtimes.values()]
      .filter((runtime) => runtime.ownerId === ownerId)
      .map((runtime) => runtime.handle);
  }
}

const envKeys = [
  "AGENT_SWARM_API_KEY",
  "RUNTIME_POOLS_ENABLED",
  "MULTI_RUNTIME_ENABLED",
  "RUNTIME_CONTROLLER_GRACE_SEC",
  "RUNTIME_CIRCUIT_THRESHOLD",
  "RUNTIME_PROVISION_MAX_ATTEMPTS",
] as const;
const previous = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
const key = "remote-controller-test-operator";
let server: Server;
let apiUrl: string;
let detach: () => void;
let detachRealtime: () => void;
let controllerId: string;
let token: string;
let fake: FakeProvider;
let clients: { stop: () => void }[] = [];
let logSpy: ReturnType<typeof spyOn<typeof console, "log">>;
let errorSpy: ReturnType<typeof spyOn<typeof console, "error">>;

async function until(predicate: () => Promise<boolean>, timeout = 2000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await Bun.sleep(5);
  }
  throw new Error("Controller test condition timed out");
}

beforeAll(() => {
  initDb(":memory:");
});
beforeEach(async () => {
  clearRuntimeOwnerIdCache();
  process.env.AGENT_SWARM_API_KEY = key;
  process.env.RUNTIME_POOLS_ENABLED = "true";
  process.env.MULTI_RUNTIME_ENABLED = "true";
  process.env.RUNTIME_CONTROLLER_GRACE_SEC = "120";
  process.env.RUNTIME_CIRCUIT_THRESHOLD = "3";
  process.env.RUNTIME_PROVISION_MAX_ATTEMPTS = "1";
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
  controllerId = (
    await createRuntimeController({
      name: "remote",
      kind: "docker",
      placement: "remote",
      config: { WORKER_API_URL: "http://remote-worker.invalid" },
    })
  ).id;
  token = (await mintControllerToken(controllerId)).plaintext;
  fake = new FakeProvider();
  clients = [];
  logSpy = spyOn(console, "log").mockImplementation(() => {});
  errorSpy = spyOn(console, "error").mockImplementation(() => {});
  server = createServer((_req, res) => res.writeHead(404).end());
  apiUrl = `http://127.0.0.1:${await listenOnFreePort(server)}`;
  detachRealtime = attachRealtimeTransport(server);
  detach = attachControllerTransport(server, { commandTimeoutMs: 100, provisionTimeoutMs: 300 });
});
afterEach(async () => {
  for (const client of clients) client.stop();
  detach();
  detachRealtime();
  await until(async () => (await getRuntimeController(controllerId))?.status !== "online");
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await stopRuntimeSupervisor();
  logSpy.mockRestore();
  errorSpy.mockRestore();
});
afterAll(() => {
  clearRuntimeOwnerIdCache();
  closeDb();
  for (const key of envKeys) {
    if (previous[key] === undefined) delete process.env[key];
    else process.env[key] = previous[key];
  }
});

async function connect() {
  const previous = remoteControllerSession(controllerId);
  const client = startControllerClient({ apiUrl, token, provider: fake, target: {} });
  clients.push(client);
  await until(
    async () =>
      remoteControllerSession(controllerId) !== previous &&
      (await getRuntimeController(controllerId))?.status === "online",
  );
  return client;
}
function request(ownerId: string): ProvisionRequest {
  const runtimeId = crypto.randomUUID();
  return {
    runtimeId,
    poolId: crypto.randomUUID(),
    agentId: crypto.randomUUID(),
    ownerId,
    image: "worker:test",
    env: { API_KEY: token },
    labels: { [RUNTIME_LABELS.owner]: ownerId, [RUNTIME_LABELS.runtimeId]: runtimeId },
  };
}

test("hello sets online and all controller commands make round trips through the CLI client", async () => {
  await connect();
  const row = await getRuntimeController(controllerId);
  expect(row?.lastSeenAt).toBeTruthy();
  const commands = await getControllerCommands(controllerId);
  expect(commands.workerApiUrl).toBe("http://remote-worker.invalid");
  const req = request(await ensureRuntimeOwnerId());
  const handle = await commands.provision(req);
  expect(handle.controllerId).toBe(controllerId);
  expect(await commands.status([handle])).toEqual({ [handle.externalId]: "running" });
  expect(await commands.list(req.ownerId)).toEqual([handle]);
  expect(await commands.list("another-swarm")).toEqual([]);
  await commands.terminate(handle, "test complete");
  expect(await commands.status([handle])).toEqual({ [handle.externalId]: "exited" });
  expect(JSON.stringify(logSpy.mock.calls)).not.toContain(token);
});

test("remote E2B provisioning, renewal, pause, and resume use the controller session", async () => {
  await updateRuntimeController(controllerId, {
    kind: "e2b",
    config: { WORKER_API_URL: "https://remote-worker.invalid" },
  });
  const renewed: Array<{ externalId: string; ttlSec: number }> = [];
  const paused: string[] = [];
  const resumed: string[] = [];
  let endAt = new Date(Date.now() + 600_000).toISOString();
  const provider: RuntimeProvider = {
    kind: "e2b",
    traits: { ...fake.traits, supportsPause: true, maxTtlSec: 86400, maxContinuousSec: 3600 },
    checkConfig: () => fake.checkConfig(),
    provision: async (target, req) => {
      const handle = await fake.provision(target, req);
      handle.kind = "e2b";
      return handle;
    },
    terminate: (target, handle) => fake.terminate(target, handle),
    status: (target, handle) => fake.status(target, handle),
    list: (target, ownerId) => fake.list(target, ownerId),
    renew: async (_target, handle, ttlSec) => {
      renewed.push({ externalId: handle.externalId, ttlSec });
      return { endAt };
    },
    pause: async (_target, handle) => {
      paused.push(handle.externalId);
      fake.runtimes.get(handle.externalId)!.status = "paused";
    },
    resume: async (_target, handle) => {
      resumed.push(handle.externalId);
      fake.runtimes.get(handle.externalId)!.status = "running";
    },
  };
  clients.push(startControllerClient({ apiUrl, token, provider, target: {} }));
  await until(async () => (await getRuntimeController(controllerId))?.status === "online");
  const commands = await getControllerCommands(controllerId);
  expect(commands).toBe(remoteControllerSession(controllerId)!);
  const pool = await createRuntimePool({
    name: "remote-e2b-pool",
    kind: "e2b",
    placements: [controllerId],
    image: "worker-template",
    ttlSec: 600,
  });
  const agent = await createPoolAgent(pool.id, { name: "remote-e2b-agent" });
  const task = await createTaskExtended("work", { agentId: agent.id });
  await reconcileOnce();
  expect(fake.requests[0]).toMatchObject({
    ttlSec: 600,
    image: "worker-template",
    env: { MCP_BASE_URL: "https://remote-worker.invalid" },
  });
  const runtime = (await listRuntimeInstancesForPool(pool.id))[0]!;
  await upsertRuntimeInstance({ id: runtime.id, agentId: agent.id, reportedSlots: 1 });
  const handle = runtime.externalHandle as unknown as RuntimeHandle;
  await commands.pause!(handle);
  await reconcileOnce();
  expect(paused).toEqual([handle.externalId]);
  expect(resumed).toEqual([handle.externalId]);
  expect(renewed).toEqual([{ externalId: handle.externalId, ttlSec: 600 }]);
  expect((await getRuntimeInstanceById(runtime.id))?.leaseExpiresAt).toBe(endAt);

  const now = new Date(Date.now() + 301_000);
  endAt = new Date(now.getTime() + 600_000).toISOString();
  await getDbClient().run("UPDATE runtime_instances SET last_seen_at = ? WHERE id = ?", [
    now.toISOString(),
    runtime.id,
  ]);
  await reconcileOnce({ now });
  expect(renewed).toHaveLength(2);
  expect((await getRuntimeInstanceById(runtime.id))?.leaseExpiresAt).toBe(endAt);

  await startTask(task.id);
  await getDbClient().run(
    "INSERT INTO active_sessions (id, agentId, taskId, triggerType, runtimeInstanceId) VALUES (?, ?, ?, 'task_assigned', ?)",
    [crypto.randomUUID(), agent.id, task.id, runtime.id],
  );
  await commands.pause!(handle);
  await reconcileOnce({ now });
  expect(fake.terminated).toEqual([handle.externalId]);
  expect(resumed).toHaveLength(1);
  expect((await getRuntimeInstanceById(runtime.id))?.status).toBe("offline");
  expect((await getTaskById(task.id))?.status).toBe("superseded");
});

test("kind mismatch closes the socket and records an error", async () => {
  const ws = new WebSocket(`${apiUrl.replace("http:", "ws:")}/api/controllers/connect`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  ws.on("message", () =>
    ws.send(
      JSON.stringify({ type: "hello", controllerId, kind: "e2b", version: 1, traits: fake.traits }),
    ),
  );
  const code = await new Promise<number>((resolve) => ws.on("close", resolve));
  expect(code).toBe(1008);
  expect((await getRuntimeController(controllerId))?.status).toBe("offline");
  expect((await getRuntimeController(controllerId))?.lastError).toContain("kind does not match");
});

for (const failure of ["list error", "list timeout"] as const) {
  test(`handshake ${failure} closes with 1011 and records a scrubbed error`, async () => {
    const ws = new WebSocket(`${apiUrl.replace("http:", "ws:")}/api/controllers/connect`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    ws.on("message", (data) => {
      const message = JSON.parse(data.toString());
      if (message.type === "welcome") {
        ws.send(
          JSON.stringify({
            type: "hello",
            controllerId,
            kind: "docker",
            version: 1,
            traits: fake.traits,
          }),
        );
      } else if (failure === "list error") {
        ws.send(
          JSON.stringify({
            type: "result",
            id: message.id,
            ok: false,
            error: `Engine unavailable: ${token} ${"⚠".repeat(100)}`,
          }),
        );
      }
    });
    const closed = await new Promise<{ code: number; reason: string }>((resolve) =>
      ws.on("close", (code, reason) => resolve({ code, reason: reason.toString() })),
    );
    expect(closed.code).toBe(1011);
    expect(closed.reason).toBe("controller operation failed");
    const row = await getRuntimeController(controllerId);
    expect(row?.lastError).toContain(failure === "list error" ? "Engine unavailable" : "timed out");
    expect(row?.lastError).not.toContain(token);
    expect(row?.lastErrorAt).toBeTruthy();
  });
}

test("CLI client retries an operational handshake failure with normal backoff", async () => {
  const list = spyOn(fake, "list")
    .mockRejectedValueOnce(new Error("Engine unavailable"))
    .mockResolvedValue([]);
  let fatal = false;
  const startedAt = Date.now();
  clients.push(
    startControllerClient({
      apiUrl,
      token,
      provider: fake,
      target: {},
      onFatal: () => {
        fatal = true;
      },
    }),
  );
  try {
    await until(async () => (await getRuntimeController(controllerId))?.status === "online", 3000);
    expect(fatal).toBe(false);
    expect(list).toHaveBeenCalledTimes(2);
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(1000);
    expect(logSpy.mock.calls.flat().join(" ")).toContain("Disconnected. Reconnect in 1000ms");
    expect((await getRuntimeController(controllerId))?.lastError).toBeNull();
  } finally {
    list.mockRestore();
  }
});

test("operator credentials cannot upgrade a controller socket", async () => {
  const ws = new WebSocket(`${apiUrl.replace("http:", "ws:")}/api/controllers/connect`, {
    headers: { Authorization: `Bearer ${key}` },
  });
  const status = await new Promise<number>((resolve) => {
    ws.on("unexpected-response", (_req, response) => {
      response.resume();
      ws.terminate();
      resolve(response.statusCode ?? 0);
    });
    ws.on("error", () => {});
  });
  expect(status).toBe(401);
});

test("replacement session closes the previous one without marking the controller offline", async () => {
  const first = await connect();
  const old = await getControllerCommands(controllerId);
  const replacement = await connect();
  await until(async () => remoteControllerSession(controllerId) !== old);
  expect((await getRuntimeController(controllerId))?.status).toBe("online");
  await expect(old.list("test")).rejects.toBeInstanceOf(ControllerOfflineError);
  first.stop();
  expect(await (await getControllerCommands(controllerId)).list("test")).toEqual([]);
  replacement.stop();
});

test("provision has a longer timeout, list bypasses a pending pull, and an op timeout preserves the session", async () => {
  await connect();
  let release!: () => void;
  fake.gate = new Promise((resolve) => {
    release = resolve;
  });
  const commands = await getControllerCommands(controllerId);
  const provisioning = commands.provision(request("owner"));
  const failure = expect(provisioning).rejects.toThrow("timed out");
  await until(async () => fake.requests.length === 1);
  expect(await commands.list("owner")).toEqual([]);
  expect(await commands.status([])).toEqual({});
  await failure;
  expect(await getControllerCommands(controllerId)).toBe(commands);
  expect((await getRuntimeController(controllerId))?.status).toBe("online");
  release();
  await until(async () => fake.runtimes.size === 1);
  expect(await commands.list("owner")).toHaveLength(1);
});

test("disconnect preserves runtimes and pending demand during grace, and reconnect keeps known handles", async () => {
  const client = await connect();
  const pool = await createRuntimePool({
    name: "remote-pool",
    kind: "docker",
    placements: [controllerId],
    image: "worker:test",
    maxRuntimes: 3,
    lifecycle: "idle",
    idleMinutes: null,
  });
  const agent = await createPoolAgent(pool.id, { name: "remote-agent" });
  await createTaskExtended("work", { agentId: agent.id });
  await reconcileOnce();
  const runtime = (await listRuntimeInstancesForPool(pool.id))[0]!;
  await upsertRuntimeInstance({ id: runtime.id, agentId: agent.id, reportedSlots: 1 });
  client.stop();
  await until(async () => (await getRuntimeController(controllerId))?.status === "offline");
  const waiting = await createPoolAgent(pool.id, { name: "waiting-agent" });
  await createTaskExtended("new demand", { agentId: waiting.id });
  await reconcileOnce();
  expect(fake.requests).toHaveLength(1);
  expect((await getRuntimeInstanceById(runtime.id))?.status).toBe("active");
  expect(await resolveBySessionToken(fake.requests[0]!.env.API_KEY!)).not.toBeNull();
  expect(
    await getDbClient().get(
      "SELECT id FROM runtime_pools WHERE id = ? AND consecutive_failures = 0 AND circuit_open_until IS NULL",
      [pool.id],
    ),
  ).toBeTruthy();
  await connect();
  await reconcileOnce();
  expect(fake.requests).toHaveLength(2);
  expect(fake.terminated).toEqual([]);
  expect((await getRuntimeInstanceById(runtime.id))?.externalHandle).toEqual(
    runtime.externalHandle,
  );
});

test("reconnect adopts a lost provision result and only reaps owner-filtered orphans", async () => {
  const client = await connect();
  const pool = await createRuntimePool({
    name: "lost-pool",
    kind: "docker",
    placements: [controllerId],
    image: "worker:test",
    maxRuntimes: 1,
  });
  const agent = await createPoolAgent(pool.id, { name: "lost-agent" });
  await createTaskExtended("work", { agentId: agent.id });
  let release!: () => void;
  fake.gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tick = reconcileOnce();
  await until(async () => fake.requests.length === 1);
  client.stop();
  await tick;
  release();
  await until(async () => fake.runtimes.size === 1);
  const ownerId = await ensureRuntimeOwnerId();
  const orphan = {
    kind: "docker" as const,
    externalId: crypto.randomUUID(),
    createdAt: new Date(Date.now() - 180_000).toISOString(),
  };
  fake.runtimes.set(orphan.externalId, { handle: orphan, ownerId, status: "running" });
  const foreign = {
    kind: "docker" as const,
    externalId: crypto.randomUUID(),
    createdAt: orphan.createdAt,
  };
  fake.runtimes.set(foreign.externalId, {
    handle: foreign,
    ownerId: "other-swarm",
    status: "running",
  });
  await connect();
  await reconcileOnce();
  const runtime = (await listRuntimeInstancesForPool(pool.id))[0]!;
  expect(runtime.status).toBe("provisioning");
  expect(runtime.externalHandle).toMatchObject({ externalId: [...fake.runtimes.keys()][0] });
  expect(fake.requests).toHaveLength(1);
  expect(fake.terminated).toEqual([orphan.externalId]);
  expect(fake.runtimes.has(foreign.externalId)).toBe(true);
});

test("disconnect recovery seam waits for grace, then recovers and fences each runtime once", async () => {
  const client = await connect();
  const pool = await createRuntimePool({
    name: "grace-pool",
    kind: "docker",
    placements: [controllerId],
    image: "worker:test",
  });
  const agent = await createPoolAgent(pool.id, { name: "grace-agent" });
  await createTaskExtended("work", { agentId: agent.id });
  await reconcileOnce();
  const runtime = (await listRuntimeInstancesForPool(pool.id))[0]!;
  client.stop();
  await until(async () => (await getRuntimeController(controllerId))?.status === "offline");
  const disconnectedAt = (await getRuntimeController(controllerId))!.updatedAt;
  const recovered: string[] = [];
  const recover = async (id: string, reason: string) => {
    recovered.push(id);
    await markRuntimeTerminated(id, reason);
  };
  await reconcileDisconnectedControllers(recover, new Date(Date.parse(disconnectedAt) + 119_000));
  expect(recovered).toEqual([]);
  expect(await resolveBySessionToken(fake.requests[0]!.env.API_KEY!)).not.toBeNull();
  await reconcileDisconnectedControllers(recover, new Date(Date.parse(disconnectedAt) + 121_000));
  await reconcileDisconnectedControllers(recover, new Date(Date.parse(disconnectedAt) + 122_000));
  expect(recovered).toEqual([runtime.id]);
  expect((await getRuntimeInstanceById(runtime.id))?.status).toBe("offline");
  expect(await resolveBySessionToken(fake.requests[0]!.env.API_KEY!)).toBeNull();
});

test("supervisor recovers an active task and fences tokens after controller grace", async () => {
  const client = await connect();
  const pool = await createRuntimePool({
    name: "expired-pool",
    kind: "docker",
    placements: [controllerId],
    image: "worker:test",
  });
  const agent = await createPoolAgent(pool.id, { name: "expired-agent" });
  const task = await createTaskExtended("work", { agentId: agent.id });
  await reconcileOnce();
  const runtime = (await listRuntimeInstancesForPool(pool.id))[0]!;
  await upsertRuntimeInstance({ id: runtime.id, agentId: agent.id, reportedSlots: 1 });
  await startTask(task.id);
  await getDbClient().run(
    "INSERT INTO active_sessions (id, agentId, taskId, triggerType, runtimeInstanceId) VALUES (?, ?, ?, 'task_assigned', ?)",
    [crypto.randomUUID(), agent.id, task.id, runtime.id],
  );
  client.stop();
  await until(async () => (await getRuntimeController(controllerId))?.status === "offline");
  const disconnectedAt = (await getRuntimeController(controllerId))!.updatedAt;
  await reconcileOnce({ now: new Date(Date.parse(disconnectedAt) + 119_000) });
  expect((await getTaskById(task.id))?.status).toBe("in_progress");
  expect(await getActiveSessionForTask(task.id)).not.toBeNull();
  await reconcileOnce({ now: new Date(Date.parse(disconnectedAt) + 121_000) });
  expect((await getRuntimeInstanceById(runtime.id))?.status).toBe("offline");
  expect(await resolveBySessionToken(fake.requests[0]!.env.API_KEY!)).toBeNull();
  expect(fake.requests).toHaveLength(1);
  expect((await getTaskById(task.id))?.status).toBe("superseded");
  expect(await getActiveSessionForTask(task.id)).toBeNull();
  const resumes = await getDbClient().query<{ agentId: string; status: string }>(
    "SELECT agentId, status FROM agent_tasks WHERE parentTaskId = ? AND taskType = 'resume'",
    [task.id],
  );
  expect(resumes).toEqual([{ agentId: agent.id, status: "pending" }]);
  expect(
    await getDbClient().get(
      "SELECT id FROM runtime_pools WHERE id = ? AND consecutive_failures = 0 AND circuit_open_until IS NULL",
      [pool.id],
    ),
  ).toBeTruthy();
});

test("persisted online controller without a socket receives a new grace period after API restart", async () => {
  const now = new Date();
  await getDbClient().run(
    "UPDATE runtime_controllers SET status = 'online', updated_at = ? WHERE id = ?",
    [new Date(now.getTime() - 600_000).toISOString(), controllerId],
  );
  const recovered: string[] = [];
  await reconcileDisconnectedControllers(async (id) => {
    recovered.push(id);
  }, now);
  expect((await getRuntimeController(controllerId))?.status).toBe("offline");
  expect((await getRuntimeController(controllerId))?.updatedAt).toBe(now.toISOString());
  expect(recovered).toEqual([]);
});

for (const failure of ["disconnect", "timeout"] as const) {
  test(`a provision ${failure} does not change failure counters, backoff, circuit, or the waiting task`, async () => {
    const client = await connect();
    const pool = await createRuntimePool({
      name: "failure-pool",
      kind: "docker",
      placements: [controllerId],
      image: "worker:test",
      maxRuntimes: 1,
    });
    const agent = await createPoolAgent(pool.id, { name: "failure-agent" });
    const task = await createTaskExtended("work", { agentId: agent.id });
    await getDbClient().run(
      "UPDATE runtime_pools SET consecutive_failures = 2, last_error = 'previous failure' WHERE id = ?",
      [pool.id],
    );
    let release!: () => void;
    fake.gate = new Promise((resolve) => {
      release = resolve;
    });
    const attempt = provisionRuntime(
      pool,
      agent,
      await getControllerCommands(controllerId),
      await ensureRuntimeOwnerId(),
    );
    await until(async () => fake.requests.length === 1);
    if (failure === "disconnect") client.stop();
    expect(await attempt).toBe(false);
    const runtime = (await listRuntimeInstancesForPool(pool.id))[0]!;
    expect(await getRuntimePool(pool.id)).toMatchObject({
      consecutiveFailures: 2,
      circuitOpenUntil: null,
      lastError: "previous failure",
    });
    expect(await getAgentById(agent.id)).toMatchObject({
      runtimeProvisionAttempts: 0,
      runtimeProvisionRetryAt: null,
    });
    expect((await getTaskById(task.id))?.status).toBe("pending");
    expect(runtime.status).toBe("provisioning");
    expect(await resolveBySessionToken(fake.requests[0]!.env.API_KEY!)).not.toBeNull();
    if (failure === "timeout") {
      expect((await getRuntimeController(controllerId))?.status).toBe("online");
      await getDbClient().run("UPDATE runtime_pools SET enabled = 0 WHERE id = ?", [pool.id]);
      await reconcileOnce();
      expect((await getRuntimeInstanceById(runtime.id))?.status).toBe("offline");
      expect(await resolveBySessionToken(fake.requests[0]!.env.API_KEY!)).toBeNull();
      expect(await getRuntimePool(pool.id)).toMatchObject({
        consecutiveFailures: 2,
        circuitOpenUntil: null,
      });
      expect(await getAgentById(agent.id)).toMatchObject({
        runtimeProvisionAttempts: 0,
        runtimeProvisionRetryAt: null,
      });
    }
    release();
    await until(async () => fake.runtimes.size === 1);
  });
}

test("reconnect retires a missing ambiguous provision and releases pool capacity without a failure", async () => {
  const client = await connect();
  const pool = await createRuntimePool({
    name: "missing-pool",
    kind: "docker",
    placements: [controllerId],
    image: "worker:test",
    maxRuntimes: 1,
  });
  const agent = await createPoolAgent(pool.id, { name: "missing-agent" });
  await createTaskExtended("work", { agentId: agent.id });
  let reject!: (error: Error) => void;
  fake.gate = new Promise((_resolve, fail) => {
    reject = fail;
  });
  const tick = reconcileOnce();
  await until(async () => fake.requests.length === 1);
  client.stop();
  await tick;
  const runtime = (await listRuntimeInstancesForPool(pool.id))[0]!;
  reject(new Error("Provision did not reach infrastructure"));
  fake.gate = undefined;
  const listsBefore = fake.owners.length;
  await connect();
  expect(fake.owners.length - listsBefore).toBe(1);
  expect((await getRuntimeInstanceById(runtime.id))?.status).toBe("offline");
  expect(await resolveBySessionToken(fake.requests[0]!.env.API_KEY!)).toBeNull();
  expect(fake.terminated).toEqual([]);
  expect(await getRuntimePool(pool.id)).toMatchObject({
    consecutiveFailures: 0,
    circuitOpenUntil: null,
  });
  expect(await getAgentById(agent.id)).toMatchObject({
    runtimeProvisionAttempts: 0,
    runtimeProvisionRetryAt: null,
  });
  await reconcileOnce();
  expect(fake.requests).toHaveLength(2);
  expect(
    (await listRuntimeInstancesForPool(pool.id)).filter((r) => r.status === "provisioning"),
  ).toHaveLength(1);
});

test("a pending reconnect handshake does not suspend an expired disconnect grace", async () => {
  const client = await connect();
  const pool = await createRuntimePool({
    name: "handshake-pool",
    kind: "docker",
    placements: [controllerId],
    image: "worker:test",
  });
  const agent = await createPoolAgent(pool.id, { name: "handshake-agent" });
  await createTaskExtended("work", { agentId: agent.id });
  await reconcileOnce();
  const runtime = (await listRuntimeInstancesForPool(pool.id))[0]!;
  client.stop();
  await until(async () => (await getRuntimeController(controllerId))?.status === "offline");
  await getDbClient().run("UPDATE runtime_controllers SET last_seen_at = ? WHERE id = ?", [
    new Date(Date.now() - 121_000).toISOString(),
    controllerId,
  ]);
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const list = spyOn(fake, "list").mockImplementation(async () => {
    await pending;
    return [];
  });
  const reconnect = startControllerClient({ apiUrl, token, provider: fake, target: {} });
  clients.push(reconnect);
  try {
    await until(
      async () =>
        remoteControllerSession(controllerId) !== undefined &&
        (await getRuntimeController(controllerId))?.status === "unknown",
    );
    await reconcileOnce();
    expect((await getRuntimeInstanceById(runtime.id))?.status).toBe("offline");
    expect(await resolveBySessionToken(fake.requests[0]!.env.API_KEY!)).toBeNull();
  } finally {
    reconnect.stop();
    release();
    list.mockRestore();
  }
});

test("failed reconnect handshakes do not extend the controller disconnect grace", async () => {
  const client = await connect();
  client.stop();
  await until(async () => (await getRuntimeController(controllerId))?.status === "offline");
  const disconnectedAt = new Date(Date.now() - 121_000).toISOString();
  await getDbClient().run(
    "UPDATE runtime_controllers SET last_seen_at = ?, updated_at = ? WHERE id = ?",
    [disconnectedAt, disconnectedAt, controllerId],
  );
  const list = spyOn(fake, "list").mockRejectedValue(new Error("Infrastructure unavailable"));
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      const listsBefore = list.mock.calls.length;
      let rejected = false;
      const failed = startControllerClient({
        apiUrl,
        token,
        provider: fake,
        target: {},
        onFatal: () => {
          rejected = true;
        },
      });
      clients.push(failed);
      await until(
        async () =>
          list.mock.calls.length > listsBefore &&
          (await getRuntimeController(controllerId))?.lastError?.includes(
            "Infrastructure unavailable",
          ) === true &&
          remoteControllerSession(controllerId) === undefined,
      );
      failed.stop();
      expect(rejected).toBe(false);
      expect((await getRuntimeController(controllerId))?.lastSeenAt).toBe(disconnectedAt);
      expect((await getRuntimeController(controllerId))?.updatedAt).toBe(disconnectedAt);
    }
  } finally {
    list.mockRestore();
  }
});

test(
  "controller CLI exits non-zero after a policy close and keeps the token out of output",
  async () => {
    const result = await runChild(
      ["bun", "run", "src/cli.tsx", "controller", "--api-url", apiUrl, "--kind", "static"],
      {
        env: { ...process.env, AGENT_SWARM_CONTROLLER_TOKEN: token },
      },
    );
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("Controller access rejected or token revoked");
    expect(result.stdout + result.stderr).not.toContain(token);
  },
  CHILD_PROCESS_TEST_BUDGET_MS,
);

test(
  "controller CLI rejects a token flag and the unsupported k8s provider",
  async () => {
    for (const args of [
      ["--token", token],
      ["--kind", "k8s"],
    ]) {
      const result = await runChild(
        ["bun", "run", "src/cli.tsx", "controller", "--api-url", apiUrl, ...args],
        {
          env: { ...process.env, AGENT_SWARM_CONTROLLER_TOKEN: token },
        },
      );
      expect(result.exitCode).toBe(1);
      expect(result.stdout + result.stderr).not.toContain(token);
      expect(result.stderr).toContain(
        args[0] === "--kind"
          ? "Remote k8s controllers are not supported"
          : "supported name and a value",
      );
    }
  },
  CHILD_PROCESS_TEST_BUDGET_MS,
);
