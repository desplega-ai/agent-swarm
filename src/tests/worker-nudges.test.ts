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
import { createServer, type Server } from "node:http";
import WebSocket from "ws";
import {
  acceptTask,
  assignUnassignedTaskPending,
  cancelTask,
  closeDb,
  createAgent,
  createChannel,
  createSteeringMessage,
  createTaskExtended,
  deleteSwarmConfig,
  deleteSwarmConfigByKey,
  getDbClient,
  initDb,
  postMessage,
  startTask,
  upsertSwarmConfig,
} from "../be/db";
import { startWorkerNudgeListener } from "../be/worker-nudge-listener";
import { publishWorkerNudge } from "../be/worker-nudges";
import { realtimeBus } from "../realtime/bus";
import {
  addWorkerSubscription,
  channelTopic,
  listSubscribedWorkerAgents,
  removeWorkerSubscription,
} from "../realtime/channels";
import { attachRealtimeTransport } from "../realtime/transport";
import { type WorkerNudge, WorkerNudgeSchema } from "../types";
import { getApiKey, setApiKey } from "../utils/api-key";
import { workflowEventBus } from "../workflows/event-bus";
import { listenOnFreePort } from "./test-net";

type Frame = { id?: number; type: string; seq: number; data?: unknown; error?: string };
type Client = {
  agentId: string;
  ws: WebSocket;
  nudges: WorkerNudge[];
  request: (op: string, namespace?: string, name?: string) => Promise<Frame>;
};

let server: Server;
let detach: () => void;
let socketUrl: string;
let x: string;
let y: string;
let clientX: Client;
let clientY: Client;
const clients: Client[] = [];
const previousFlag = process.env.RUNTIME_POOLS_ENABLED;
const previousEnv = { ...process.env };
let stopWorkerNudges: () => void;

beforeAll(() => {
  stopWorkerNudges = startWorkerNudgeListener();
});
afterAll(() => stopWorkerNudges());

async function waitUntil(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Worker nudge did not arrive within five seconds");
    await Bun.sleep(5);
  }
}

async function flushDbHooks(): Promise<void> {
  // The FIFO hook barrier dispatches prior hooks, then the query drains their task reads.
  await new Promise<void>((resolve) => getDbClient().afterCommit(resolve));
  await getDbClient().get("SELECT 1");
}

async function createCommittedTask(...args: Parameters<typeof createTaskExtended>) {
  const emitted = new Set<string>();
  const onCreated = (data: unknown) => emitted.add((data as { taskId: string }).taskId);
  workflowEventBus.on("task.created", onCreated);
  try {
    const task = await createTaskExtended(...args);
    await waitUntil(() => emitted.has(task.id));
    await flushDbHooks();
    return task;
  } finally {
    workflowEventBus.off("task.created", onCreated);
  }
}

async function socketBarrier(client: Client): Promise<void> {
  const sentinel: WorkerNudge = {
    v: 1,
    kind: "config",
    taskId: crypto.randomUUID(),
    at: new Date().toISOString(),
  };
  realtimeBus.publish(channelTopic(`worker:${client.agentId}`, "nudge"), sentinel);
  await waitUntil(() => client.nudges.some((nudge) => nudge.taskId === sentinel.taskId));
  expect(client.nudges.at(-1)).toEqual(sentinel);
  client.nudges.pop();
}

async function openClient(agentId: string, runtimeId = crypto.randomUUID()): Promise<Client> {
  const ws = new WebSocket(socketUrl, {
    headers: {
      Authorization: `Bearer ${getApiKey()}`,
      "X-Agent-ID": agentId,
      "X-Runtime-Instance-ID": runtimeId,
    },
  });
  let requestId = 0;
  const frames: Frame[] = [];
  const nudges: WorkerNudge[] = [];
  ws.on("message", (raw) => {
    const frame = JSON.parse(raw.toString()) as Frame;
    ws.send(JSON.stringify({ ack: frame.seq }));
    frames.push(frame);
    if (frame.type === "channel") nudges.push(WorkerNudgeSchema.parse(frame.data));
  });
  const client: Client = {
    agentId,
    ws,
    nudges,
    async request(op, namespace = `worker:${agentId}`, name = "nudge") {
      const id = ++requestId;
      ws.send(JSON.stringify({ id, op, namespace, name }));
      await waitUntil(() => frames.some((frame) => frame.id === id));
      return frames.find((frame) => frame.id === id)!;
    },
  };
  clients.push(client);
  await new Promise<void>((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });
  return client;
}

async function closeClient(client: Client): Promise<void> {
  if (client.ws.readyState === WebSocket.CLOSED) return;
  await new Promise<void>((resolve) => {
    client.ws.once("close", resolve);
    client.ws.close();
  });
}

async function expectNudge(
  client: Client,
  write: () => Promise<unknown>,
  kind: WorkerNudge["kind"],
  taskId?: string | (() => string),
): Promise<void> {
  const count = client.nudges.length;
  await write();
  await waitUntil(() => client.nudges.length > count);
  await flushDbHooks();
  await socketBarrier(client);
  const expectedTaskId = typeof taskId === "function" ? taskId() : taskId;
  expect(client.nudges.slice(count)).toEqual([
    { v: 1, kind, ...(expectedTaskId ? { taskId: expectedTaskId } : {}), at: expect.any(String) },
  ]);
}

describe("worker nudges", () => {
  beforeAll(async () => {
    setApiKey(`worker-nudge-test-${crypto.randomUUID()}`);
    server = createServer();
    detach = attachRealtimeTransport(server);
    const port = await listenOnFreePort(server);
    socketUrl = `ws://127.0.0.1:${port}/api/realtime`;
  });

  beforeEach(async () => {
    process.env.RUNTIME_POOLS_ENABLED = "true";
    initDb(":memory:");
    x = (await createAgent({ name: "nudge-x", isLead: false, status: "idle", capabilities: [] }))
      .id;
    y = (await createAgent({ name: "nudge-y", isLead: false, status: "idle", capabilities: [] }))
      .id;
    clientX = await openClient(x);
    clientY = await openClient(y);
    expect((await clientX.request("subscribe")).type).toBe("result");
    expect((await clientY.request("subscribe")).type).toBe("result");
  });

  afterEach(async () => {
    for (const client of clients.splice(0)) await closeClient(client);
    await waitUntil(() => listSubscribedWorkerAgents().length === 0);
    closeDb();
    if (previousFlag === undefined) delete process.env.RUNTIME_POOLS_ENABLED;
    else process.env.RUNTIME_POOLS_ENABLED = previousFlag;
  });

  afterAll(async () => {
    detach();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    for (const key of ["AGENT_SWARM_API_KEY", "API_KEY"]) {
      if (previousEnv[key] === undefined) delete process.env[key];
      else process.env[key] = previousEnv[key];
    }
  });

  test("allows only the matching agent to subscribe, and rejects client writes", async () => {
    expect((await clientY.request("subscribe", `worker:${x}`)).type).toBe("error");
    expect((await clientX.request("subscribe", `worker:${x}`, "other")).type).toBe("error");
    for (const op of ["publish", "join", "leave", "update", "change", "reset", "presence"]) {
      expect((await clientX.request(op)).type).toBe("error");
    }
    expect((await clientY.request("unsubscribe", `worker:${x}`)).type).toBe("error");
    expect(listSubscribedWorkerAgents().sort()).toEqual([x, y].sort());
  });

  test("nudges for pending creation, offered creation, acceptance, and pool assignment", async () => {
    let pendingId = "";
    await expectNudge(
      clientX,
      async () => {
        pendingId = (await createCommittedTask("pending", { agentId: x })).id;
      },
      "work",
      () => pendingId,
    );
    expect(clientX.nudges.at(-1)?.taskId).toBe(pendingId);
    let offeredId = "";
    const count = clientY.nudges.length;
    offeredId = (await createCommittedTask("offered", { offeredTo: y })).id;
    await waitUntil(() => clientY.nudges.length === count + 1);
    expect(clientY.nudges.at(-1)).toMatchObject({ kind: "work", taskId: offeredId });
    await expectNudge(clientY, () => acceptTask(offeredId, y), "work", offeredId);
    const pool = await createCommittedTask("pool");
    await expectNudge(clientX, () => assignUnassignedTaskPending(pool.id, x), "work", pool.id);
    expect(await assignUnassignedTaskPending(pool.id, y)).toBeNull();
  });

  test("nudges cancellation of offers and deduplicates recipients", async () => {
    const offered = await createCommittedTask("offered cancellation", { offeredTo: y });
    await waitUntil(() => clientY.nudges.length === 1);
    await expectNudge(clientY, () => cancelTask(offered.id), "cancel", offered.id);
    await socketBarrier(clientX);
    expect(clientX.nudges).toHaveLength(0);

    const shared = await createCommittedTask("same cancellation recipient", {
      agentId: x,
      offeredTo: x,
    });
    await waitUntil(() => clientX.nudges.length === 1);
    await expectNudge(clientX, () => cancelTask(shared.id), "cancel", shared.id);

    const both = await createCommittedTask("two cancellation recipients", {
      agentId: x,
      offeredTo: y,
    });
    await socketBarrier(clientY);
    const countX = clientX.nudges.length;
    await expectNudge(clientY, () => cancelTask(both.id), "cancel", both.id);
    await socketBarrier(clientX);
    expect(clientX.nudges.slice(countX)).toEqual([
      { v: 1, kind: "cancel", taskId: both.id, at: expect.any(String) },
    ]);
  });

  test("nudges each unique mention, including reply mentions", async () => {
    const channel = await createChannel(`nudge-${crypto.randomUUID()}`);
    await expectNudge(
      clientX,
      () => postMessage(channel.id, y, "hello", { mentions: [x, x] }),
      "work",
    );
    const parent = await postMessage(channel.id, y, "parent", { mentions: [x] });
    await waitUntil(() => clientX.nudges.length === 2);
    await expectNudge(
      clientX,
      () => postMessage(channel.id, y, "reply", { replyToId: parent.id }),
      "work",
    );
    await socketBarrier(clientY);
    expect(clientY.nudges).toHaveLength(0);
  });

  test("nudges cancellation and steering without their payloads", async () => {
    const task = await createCommittedTask("active", { agentId: x });
    await waitUntil(() => clientX.nudges.length === 1);
    await startTask(task.id);
    await expectNudge(
      clientX,
      () =>
        createSteeringMessage({
          taskId: task.id,
          body: "private steering body",
          mode: "queue",
          source: "api",
          createdByKind: "system",
        }),
      "steer",
      task.id,
    );
    // Cancel another task, so steering promotion does not add a separate work nudge.
    const cancelled = await createCommittedTask("cancel", { agentId: x });
    await waitUntil(() => clientX.nudges.length === 3);
    await expectNudge(
      clientX,
      () => cancelTask(cancelled.id, "private reason"),
      "cancel",
      cancelled.id,
    );
    expect(await cancelTask(cancelled.id)).toBeNull();
    await flushDbHooks();
    await socketBarrier(clientY);
    expect(clientY.nudges).toHaveLength(0);
  });

  test("nudges agent config, broadcasts global and repo config, and covers both delete paths", async () => {
    let configId = "";
    await expectNudge(
      clientX,
      async () => {
        configId = (
          await upsertSwarmConfig({
            scope: "agent",
            scopeId: x,
            key: "NUDGE_TEST",
            value: "private value",
          })
        ).id;
      },
      "config",
    );
    await socketBarrier(clientY);
    expect(clientY.nudges).toHaveLength(0);
    await expectNudge(clientX, () => deleteSwarmConfig(configId), "config");
    await expectNudge(
      clientX,
      () => upsertSwarmConfig({ scope: "global", key: "NUDGE_TEST", value: "global" }),
      "config",
    );
    await waitUntil(() => clientY.nudges.length === 1);
    await expectNudge(
      clientX,
      () => deleteSwarmConfigByKey("global", null, "NUDGE_TEST"),
      "config",
    );
    await waitUntil(() => clientY.nudges.length === 2);
    await expectNudge(
      clientX,
      () =>
        upsertSwarmConfig({
          scope: "repo",
          scopeId: crypto.randomUUID(),
          key: "NUDGE_TEST",
          value: "repo",
        }),
      "config",
    );
    await waitUntil(() => clientY.nudges.length === 3);
    expect(await deleteSwarmConfig(configId)).toBe(false);
  });

  test("publishes only after commit and drops hooks on rollback", async () => {
    let taskId = "";
    await getDbClient().transaction(async () => {
      taskId = (await createTaskExtended("transaction", { agentId: x })).id;
      await upsertSwarmConfig({ scope: "agent", scopeId: x, key: "NUDGE_TX", value: "one" });
      await socketBarrier(clientX);
      expect(clientX.nudges).toHaveLength(0);
    });
    await waitUntil(() => clientX.nudges.length === 2);
    expect(clientX.nudges.map((nudge) => nudge.kind).sort()).toEqual(["config", "work"]);
    clientX.nudges.length = 0;
    await expect(
      getDbClient().transaction(async () => {
        await createTaskExtended("rollback", { agentId: x });
        await cancelTask(taskId);
        await createSteeringMessage({
          taskId,
          body: "rollback",
          mode: "queue",
          source: "api",
          createdByKind: "system",
        });
        await upsertSwarmConfig({ scope: "global", key: "NUDGE_TX", value: "two" });
        throw new Error("rollback");
      }),
    ).rejects.toThrow("rollback");
    await flushDbHooks();
    await socketBarrier(clientX);
    await socketBarrier(clientY);
    expect(clientX.nudges).toHaveLength(0);
    expect(clientY.nudges).toHaveLength(0);
  });

  test("flag off suppresses every nudge and rejects new subscriptions", async () => {
    process.env.RUNTIME_POOLS_ENABLED = "false";
    const task = await createCommittedTask("flag off", { agentId: x });
    await cancelTask(task.id);
    await upsertSwarmConfig({ scope: "global", key: "NUDGE_OFF", value: "one" });
    publishWorkerNudge(x, { kind: "work" });
    expect((await clientX.request("subscribe")).type).toBe("error");
    await flushDbHooks();
    await socketBarrier(clientX);
    await socketBarrier(clientY);
    expect(clientX.nudges).toHaveLength(0);
    expect(clientY.nudges).toHaveLength(0);
  });

  test("tracks each runtime socket and emits connection events", async () => {
    const runtimeId = crypto.randomUUID();
    const connected: unknown[] = [];
    const disconnected: unknown[] = [];
    const stopConnected = realtimeBus.subscribe("worker.socket.connected", (data) =>
      connected.push(data),
    );
    const stopDisconnected = realtimeBus.subscribe("worker.socket.disconnected", (data) =>
      disconnected.push(data),
    );
    try {
      const sibling = await openClient(x, runtimeId);
      await sibling.request("subscribe");
      await sibling.request("subscribe");
      expect(connected).toEqual([{ agentId: x, runtimeId }]);
      await closeClient(sibling);
      await waitUntil(() => disconnected.length === 1);
      expect(disconnected).toEqual([{ agentId: x, runtimeId }]);
      expect(listSubscribedWorkerAgents()).toContain(x);
      await expectNudge(
        clientX,
        () => upsertSwarmConfig({ scope: "global", key: "NUDGE_SIBLING", value: "one" }),
        "config",
      );
      await clientX.request("unsubscribe");
      expect(listSubscribedWorkerAgents()).not.toContain(x);
      expect(realtimeBus.subscriberCount(channelTopic(`worker:${x}`, "nudge"))).toBe(0);
    } finally {
      stopConnected();
      stopDisconnected();
    }
  });

  test.each([
    1, 2,
  ])("pairs events across %i subscribe-unsubscribe cycles and close", async (cycles) => {
    const runtimeId = crypto.randomUUID();
    const events: { kind: string; data: unknown }[] = [];
    const stopConnected = realtimeBus.subscribe("worker.socket.connected", (data) =>
      events.push({ kind: "connected", data }),
    );
    const stopDisconnected = realtimeBus.subscribe("worker.socket.disconnected", (data) =>
      events.push({ kind: "disconnected", data }),
    );
    try {
      const sibling = await openClient(x, runtimeId);
      const expected = [];
      for (let i = 0; i < cycles; i++) {
        await sibling.request("subscribe");
        expected.push({ kind: "connected", data: { agentId: x, runtimeId } });
        if (i === 0) {
          await sibling.request("unsubscribe");
          await sibling.request("unsubscribe");
          expected.push({ kind: "disconnected", data: { agentId: x, runtimeId } });
        }
      }
      if (cycles === 2) {
        // A flag change must not suppress the disconnect paired with this subscription.
        process.env.RUNTIME_POOLS_ENABLED = "false";
        expected.push({ kind: "disconnected", data: { agentId: x, runtimeId } });
      }
      await closeClient(sibling);
      if (cycles === 2) await waitUntil(() => events.length === expected.length);
      process.env.RUNTIME_POOLS_ENABLED = "true";
      await clientX.request("subscribe");
      await waitUntil(() => events.length === expected.length);
      expect(events).toEqual(expected);
    } finally {
      stopConnected();
      stopDisconnected();
    }
  });
});

describe("worker nudge database hooks", () => {
  let agentId: string;
  let nudges: WorkerNudge[];
  let stop: () => void;
  const subscriber = {};

  beforeEach(async () => {
    process.env.RUNTIME_POOLS_ENABLED = "true";
    initDb(":memory:");
    agentId = (
      await createAgent({ name: "nudge-db", isLead: false, status: "idle", capabilities: [] })
    ).id;
    nudges = [];
    addWorkerSubscription(agentId, subscriber);
    stop = realtimeBus.subscribe(channelTopic(`worker:${agentId}`, "nudge"), (data) => {
      nudges.push(WorkerNudgeSchema.parse(data));
    });
  });

  afterEach(async () => {
    await flushDbHooks();
    stop();
    removeWorkerSubscription(agentId, subscriber);
    closeDb();
    if (previousFlag === undefined) delete process.env.RUNTIME_POOLS_ENABLED;
    else process.env.RUNTIME_POOLS_ENABLED = previousFlag;
  });

  test("publishes one envelope for each committed write", async () => {
    const pending = await createCommittedTask("pending", { agentId });
    await waitUntil(() => nudges.length === 1);
    expect(nudges.at(-1)).toMatchObject({ kind: "work", taskId: pending.id });
    const offered = await createCommittedTask("offered", { offeredTo: agentId });
    await waitUntil(() => nudges.length === 2);
    expect(nudges.at(-1)).toMatchObject({ kind: "work", taskId: offered.id });
    await acceptTask(offered.id, agentId);
    await waitUntil(() => nudges.length === 3);
    const pool = await createCommittedTask("pool");
    await assignUnassignedTaskPending(pool.id, agentId);
    await waitUntil(() => nudges.length === 4);
    const channel = await createChannel(`db-${crypto.randomUUID()}`);
    await postMessage(channel.id, null, "mention", { mentions: [agentId, agentId] });
    await waitUntil(() => nudges.length === 5);
    await cancelTask(pool.id);
    await waitUntil(() => nudges.length === 6);
    await createSteeringMessage({
      taskId: pending.id,
      body: "private",
      mode: "queue",
      source: "api",
      createdByKind: "system",
    });
    await waitUntil(() => nudges.length === 7);
    const config = await upsertSwarmConfig({
      scope: "agent",
      scopeId: agentId,
      key: "NUDGE_DB",
      value: "private",
    });
    await waitUntil(() => nudges.length === 8);
    await deleteSwarmConfig(config.id);
    await waitUntil(() => nudges.length === 9);
    await flushDbHooks();
    expect(nudges.map((nudge) => nudge.kind)).toEqual([
      "work",
      "work",
      "work",
      "work",
      "work",
      "cancel",
      "steer",
      "config",
      "config",
    ]);
    for (const nudge of nudges)
      expect(Object.keys(nudge).sort()).toEqual(
        nudge.taskId ? ["at", "kind", "taskId", "v"] : ["at", "kind", "v"],
      );
  });

  test("defers until commit and suppresses every rolled-back hook", async () => {
    const pending = await createCommittedTask("pending", { agentId });
    const offered = await createCommittedTask("offered", { offeredTo: agentId });
    const pool = await createCommittedTask("pool");
    const channel = await createChannel(`rollback-${crypto.randomUUID()}`);
    const config = await upsertSwarmConfig({
      scope: "agent",
      scopeId: agentId,
      key: "NUDGE_DELETE",
      value: "one",
    });
    await waitUntil(() => nudges.length === 3);
    nudges.length = 0;
    await expect(
      getDbClient().transaction(async () => {
        await createTaskExtended("rollback", { agentId });
        await acceptTask(offered.id, agentId);
        await assignUnassignedTaskPending(pool.id, agentId);
        await postMessage(channel.id, null, "rollback", { mentions: [agentId] });
        await cancelTask(pending.id);
        await createSteeringMessage({
          taskId: pending.id,
          body: "rollback",
          mode: "queue",
          source: "api",
          createdByKind: "system",
        });
        await upsertSwarmConfig({
          scope: "agent",
          scopeId: agentId,
          key: "NUDGE_TX",
          value: "two",
        });
        await deleteSwarmConfig(config.id);
        await getDbClient().get("SELECT 1");
        expect(nudges).toHaveLength(0);
        throw new Error("rollback");
      }),
    ).rejects.toThrow("rollback");
    await flushDbHooks();
    expect(nudges).toHaveLength(0);
    await getDbClient().transaction(async () => {
      await acceptTask(offered.id, agentId);
      await upsertSwarmConfig({
        scope: "agent",
        scopeId: agentId,
        key: "NUDGE_TX",
        value: "committed",
      });
      await getDbClient().get("SELECT 1");
      expect(nudges).toHaveLength(0);
    });
    await waitUntil(() => nudges.length === 2);
    expect(nudges.map((nudge) => nudge.kind)).toEqual(["work", "config"]);
  });

  test("flag off suppresses write hooks", async () => {
    process.env.RUNTIME_POOLS_ENABLED = "false";
    const task = await createCommittedTask("off", { agentId });
    await cancelTask(task.id);
    await createSteeringMessage({
      taskId: task.id,
      body: "off",
      mode: "queue",
      source: "api",
      createdByKind: "system",
    });
    await upsertSwarmConfig({ scope: "agent", scopeId: agentId, key: "NUDGE_OFF", value: "off" });
    await flushDbHooks();
    expect(nudges).toHaveLength(0);
  });

  test("skips task reads without subscribers or with the flag off", () => {
    removeWorkerSubscription(agentId, subscriber);
    const read = spyOn(getDbClient(), "get");
    try {
      workflowEventBus.emit("task.created", { taskId: crypto.randomUUID() });
      expect(read).not.toHaveBeenCalled();
      addWorkerSubscription(agentId, subscriber);
      process.env.RUNTIME_POOLS_ENABLED = "false";
      workflowEventBus.emit("task.created", { taskId: crypto.randomUUID() });
      expect(read).not.toHaveBeenCalled();
    } finally {
      read.mockRestore();
    }
  });
});
