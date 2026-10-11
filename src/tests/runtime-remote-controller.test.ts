import { afterAll, afterEach, beforeAll, beforeEach, expect, spyOn, test } from "bun:test";
import { createServer, type Server } from "node:http";
import WebSocket from "ws";
import { closeDb, createTaskExtended, getDbClient, initDb } from "../be/db";
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
} from "../be/runtime-pools/db";
import { reconcileOnce, stopRuntimeSupervisor } from "../be/runtime-pools/supervisor";
import { mintControllerToken, resolveBySessionToken } from "../be/users";
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
  detach = attachControllerTransport(server, { commandTimeoutMs: 300 });
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
  const client = startControllerClient({ apiUrl, token, provider: fake, target: {} });
  clients.push(client);
  await until(async () => (await getRuntimeController(controllerId))?.status === "online");
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

test("kind mismatch closes the socket and records an error", async () => {
  const ws = new WebSocket(`${apiUrl.replace("http:", "ws:")}/api/controllers/connect`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  ws.on("message", () =>
    ws.send(JSON.stringify({ type: "hello", controllerId, kind: "e2b", version: 1 })),
  );
  await new Promise<void>((resolve) => ws.on("close", () => resolve()));
  expect((await getRuntimeController(controllerId))?.status).toBe("offline");
  expect((await getRuntimeController(controllerId))?.lastError).toContain("kind does not match");
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
  await Bun.sleep(30);
  expect((await getRuntimeController(controllerId))?.status).toBe("online");
  await expect(old.list("test")).rejects.toBeInstanceOf(ControllerOfflineError);
  first.stop();
  expect(await (await getControllerCommands(controllerId)).list("test")).toEqual([]);
  replacement.stop();
});

test("command timeout closes the session and rejects with an offline error", async () => {
  const client = await connect();
  fake.gate = new Promise(() => {});
  const commands = await getControllerCommands(controllerId);
  await expect(commands.provision(request("owner"))).rejects.toThrow("timed out");
  client.stop();
  await until(async () => (await getRuntimeController(controllerId))?.status === "offline");
  await expect(getControllerCommands(controllerId)).rejects.toBeInstanceOf(ControllerOfflineError);
});

test("disconnect preserves runtimes and pending demand during grace, and reconnect keeps known handles", async () => {
  const client = await connect();
  const pool = await createRuntimePool({
    name: "remote-pool",
    kind: "docker",
    placements: [controllerId],
    image: "worker:test",
    maxRuntimes: 1,
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
  expect(fake.requests).toHaveLength(1);
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

test("supervisor fences runtimes after controller grace without provisioning or changing the circuit", async () => {
  const client = await connect();
  const pool = await createRuntimePool({
    name: "expired-pool",
    kind: "docker",
    placements: [controllerId],
    image: "worker:test",
  });
  const agent = await createPoolAgent(pool.id, { name: "expired-agent" });
  await createTaskExtended("work", { agentId: agent.id });
  await reconcileOnce();
  const runtime = (await listRuntimeInstancesForPool(pool.id))[0]!;
  client.stop();
  await until(async () => (await getRuntimeController(controllerId))?.status === "offline");
  const disconnectedAt = (await getRuntimeController(controllerId))!.updatedAt;
  await reconcileOnce({ now: new Date(Date.parse(disconnectedAt) + 121_000) });
  expect((await getRuntimeInstanceById(runtime.id))?.status).toBe("offline");
  expect(await resolveBySessionToken(fake.requests[0]!.env.API_KEY!)).toBeNull();
  expect(fake.requests).toHaveLength(1);
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
