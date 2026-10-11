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
import { closeDb, createAgent, initDb } from "../be/db";
import { realtimeBus } from "../realtime/bus";
import { channelTopic, listSubscribedWorkerAgents } from "../realtime/channels";
import { attachRealtimeTransport } from "../realtime/transport";
import { WorkerRealtimeClient, workerReconnectDelay } from "../realtime/worker-client";
import type { WorkerNudge } from "../types";
import { getApiKey, setApiKey } from "../utils/api-key";
import { listenOnFreePort } from "./test-net";

const previousEnv = { ...process.env };
let server: Server;
let detach: () => void;
let client: WorkerRealtimeClient;
let agentId: string;
let runtimeInstanceId: string;
let nudges: WorkerNudge[];
let removeListener: () => void;

async function waitUntil(predicate: () => boolean) {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Worker socket condition timed out");
    await Bun.sleep(5);
  }
}

beforeAll(() => {
  initDb(":memory:");
  setApiKey("test-worker-realtime-client-key");
  process.env.RUNTIME_POOLS_ENABLED = "true";
});
afterAll(() => {
  closeDb();
  process.env = previousEnv;
});
beforeEach(async () => {
  agentId = crypto.randomUUID();
  runtimeInstanceId = crypto.randomUUID();
  await createAgent({
    id: agentId,
    name: "socket-worker",
    isLead: false,
    status: "idle",
    capabilities: [],
  });
  server = createServer();
  const port = await listenOnFreePort(server);
  detach = attachRealtimeTransport(server);
  client = new WorkerRealtimeClient({
    apiUrl: `http://127.0.0.1:${port}`,
    apiKey: getApiKey(),
    agentId,
    runtimeInstanceId,
  });
  nudges = [];
  removeListener = client.onNudge((nudge) => nudges.push(nudge));
});
afterEach(async () => {
  client.stop();
  detach();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function publish(kind: WorkerNudge["kind"], taskId?: string) {
  const nudge: WorkerNudge = { v: 1, kind, taskId, at: new Date().toISOString() };
  realtimeBus.publish(channelTopic(`worker:${agentId}`, "nudge"), nudge);
  return nudge;
}

describe("worker realtime client through the real transport", () => {
  test("subscribes with agent/runtime headers and replays work/config after subscription", async () => {
    const connected: unknown[] = [];
    const stop = realtimeBus.subscribe("worker.socket.connected", (event) => connected.push(event));
    try {
      client.start();
      client.start();
      await waitUntil(() => client.isConnected());
      expect(connected).toEqual([{ agentId, runtimeId: runtimeInstanceId }]);
      expect(listSubscribedWorkerAgents()).toContain(agentId);
      expect(nudges.map((n) => n.kind)).toEqual(["work", "config"]);
      expect(await client.waitForNudge(["work"], 5)).toBeNull();
      expect(await client.waitForNudge(["config"], 5)).toBeNull();
      expect(await client.waitForNudge(["work"], 5)).toBeNull();
      const waiting = client.waitForNudge(["cancel"], 1000);
      const nudge = publish("cancel", crypto.randomUUID());
      expect(await waiting).toEqual(nudge);
    } finally {
      stop();
    }
  });

  test("queues nudges only when neither listeners nor waiters consumed them", async () => {
    removeListener();
    client.start();
    await waitUntil(() => client.isConnected());
    expect((await client.waitForNudge(["work"], 5))?.kind).toBe("work");
    expect((await client.waitForNudge(["config"], 5))?.kind).toBe("config");
    const waiting = client.waitForNudge(["cancel"], 1000);
    const nudge = publish("cancel", crypto.randomUUID());
    expect(await waiting).toEqual(nudge);
    expect(await client.waitForNudge(["cancel"], 5)).toBeNull();
  });

  test("short subscriptions keep exponential backoff and a stable subscription resets it", async () => {
    const timers = spyOn(globalThis, "setTimeout");
    const random = spyOn(Math, "random").mockReturnValue(0.5);
    let clock: ReturnType<typeof spyOn> | undefined;
    try {
      client.start();
      await waitUntil(() => client.isConnected());
      for (const delay of [1000, 2000]) {
        detach();
        await waitUntil(() => !client.isConnected());
        expect(timers.mock.calls.at(-1)?.[1]).toBe(delay);
        detach = attachRealtimeTransport(server);
        await waitUntil(() => client.isConnected());
      }
      const stableAt = Date.now() + 31_000;
      clock = spyOn(Date, "now").mockReturnValue(stableAt);
      detach();
      await waitUntil(() => !client.isConnected());
      expect(timers.mock.calls.at(-1)?.[1]).toBe(1000);
      detach = attachRealtimeTransport(server);
    } finally {
      clock?.mockRestore();
      timers.mockRestore();
      random.mockRestore();
    }
  });

  test("acknowledges frames beyond the server's 128-frame limit and ignores invalid envelopes", async () => {
    client.start();
    await waitUntil(() => client.isConnected());
    realtimeBus.publish(channelTopic(`worker:${agentId}`, "nudge"), { v: 2, kind: "work" });
    for (let batch = 0; batch < 12; batch++) {
      for (let i = 0; i < 20; i++) publish("steer", crypto.randomUUID());
      await waitUntil(() => nudges.length === 2 + (batch + 1) * 20);
    }
    expect(client.isConnected()).toBe(true);
    expect(nudges).toHaveLength(242);
  });

  test("reconnects after server-side close and replays synthetic nudges", async () => {
    client.start();
    await waitUntil(() => client.isConnected());
    detach();
    await waitUntil(() => !client.isConnected());
    detach = attachRealtimeTransport(server);
    await waitUntil(() => client.isConnected() && nudges.length >= 4);
    expect(nudges.map((n) => n.kind)).toEqual(["work", "config", "work", "config"]);
    const nudge = publish("work", crypto.randomUUID());
    await waitUntil(() => nudges.some((n) => n.taskId === nudge.taskId));
  });

  test("stop resolves waiters and suppresses reconnect", async () => {
    client.start();
    await waitUntil(() => client.isConnected());
    const waiting = client.waitForNudge(["cancel"], 5000);
    client.stop();
    expect(await waiting).toBeNull();
    expect(client.isConnected()).toBe(false);
    expect(await client.waitForNudge(["work"], 5000)).toBeNull();
    await waitUntil(() => !listSubscribedWorkerAgents().includes(agentId));
  });
});

test("reconnect delay grows with jitter inside 1 to 30 second bounds", () => {
  for (const attempt of [0, 1, 2, 3, 4, 5, 50, 1000]) {
    for (const random of [0, 0.5, 1]) {
      expect(workerReconnectDelay(attempt, random)).toBeGreaterThanOrEqual(1000);
      expect(workerReconnectDelay(attempt, random)).toBeLessThanOrEqual(30_000);
    }
  }
  expect(workerReconnectDelay(0, 0.5)).toBe(1000);
  expect(workerReconnectDelay(1, 0.5)).toBe(2000);
  expect(workerReconnectDelay(5, 1)).toBe(30_000);
});
