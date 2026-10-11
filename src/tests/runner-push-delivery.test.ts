import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import {
  RunnerPushDelivery,
  resolvePushSafetyPollMs,
  resolveWorkerDeliveryMode,
} from "../commands/push-delivery";
import {
  createSteeringDispatchState,
  fetchResolvedEnv,
  pollAndDispatchSteering,
  pollForTrigger,
  type RunnerState,
  type RunningTask,
  reconcileActiveTasks,
  registerAgent,
} from "../commands/runner";
import type { ProviderSession } from "../providers/types";
import { WorkerRealtimeClient } from "../realtime/worker-client";
import type { DeliveryMode, WorkerNudge } from "../types";

let server: ReturnType<typeof Bun.serve>;
let socket: Bun.ServerWebSocket<undefined> | undefined;
let client: WorkerRealtimeClient;
let delivery: RunnerPushDelivery;
let apiUrl: string;
let requests: string[];
let cancelledId: string | undefined;
let steeringId: string | undefined;
const agentId = crypto.randomUUID();
const apiKey = "test-runner-push-delivery-key";

async function waitUntil(predicate: () => boolean) {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Runner delivery condition timed out");
    await Bun.sleep(5);
  }
}

beforeEach(async () => {
  requests = [];
  cancelledId = undefined;
  steeringId = undefined;
  socket = undefined;
  server = Bun.serve<undefined>({
    port: 0,
    fetch(req, srv) {
      const url = new URL(req.url);
      if (url.pathname === "/api/realtime" && srv.upgrade(req, { data: undefined })) return;
      requests.push(`${req.method} ${url.pathname}`);
      if (url.pathname === "/api/agents") return Response.json({ deliveryMode: "push" });
      if (url.pathname === "/api/config/resolved")
        return Response.json({ configs: [{ key: "MAX_CONCURRENT_TASKS", value: "3" }] });
      if (url.pathname === "/api/poll") return Response.json({ trigger: null });
      if (url.pathname === "/cancelled-tasks")
        return Response.json({ cancelled: cancelledId ? [{ id: cancelledId }] : [] });
      if (url.pathname === "/api/steering-messages")
        return Response.json({
          messages:
            url.searchParams.get("taskId") === steeringId
              ? [
                  {
                    id: crypto.randomUUID(),
                    body: "continue carefully",
                    mode: "queue",
                    status: "pending",
                    createdByKind: "operator",
                  },
                ]
              : [],
        });
      return Response.json({});
    },
    websocket: {
      open(ws) {
        socket = ws;
      },
      message(ws, raw) {
        const message = JSON.parse(String(raw));
        if (message.op === "subscribe")
          ws.send(JSON.stringify({ id: message.id, seq: 1, type: "result" }));
      },
    },
  });
  apiUrl = `http://127.0.0.1:${server.port}`;
  client = new WorkerRealtimeClient({
    apiUrl,
    apiKey,
    agentId,
    runtimeInstanceId: crypto.randomUUID(),
  });
  delivery = new RunnerPushDelivery(client);
  client.start();
  await waitUntil(() => client.isConnected());
  await client.waitForNudge(["work"], 10);
  await client.waitForNudge(["config"], 10);
});
afterEach(async () => {
  client.stop();
  await server.stop(true);
});

async function nudge(kind: WorkerNudge["kind"], taskId?: string) {
  const waiting = client.waitForNudge([kind], 1000);
  socket!.send(
    JSON.stringify({
      type: "channel",
      namespace: `worker:${agentId}`,
      name: "nudge",
      seq: 2,
      data: { v: 1, kind, taskId, at: new Date().toISOString() },
    }),
  );
  expect((await waiting)?.kind).toBe(kind);
}

async function poll(now: number, mode: DeliveryMode = "push") {
  const checks = delivery.checks(mode, now);
  if (!checks.work) return checks;
  delivery.beginPoll();
  const trigger = await pollForTrigger({
    apiUrl,
    apiKey,
    agentId,
    pollInterval: 2,
    pollTimeout: 8,
    singlePoll: checks.push,
  });
  if (trigger) delivery.wakeWork();
  return checks;
}

function activeTask(
  taskId: string,
  abort: (reason?: string) => Promise<void>,
  deliverSteering?: ProviderSession["deliverSteering"],
): RunningTask {
  const session: ProviderSession = {
    sessionId: crypto.randomUUID(),
    onEvent() {},
    waitForCompletion: () => new Promise(() => {}),
    abort,
    deliverSteering,
  };
  return {
    taskId,
    session,
    startTime: new Date(0),
    result: null,
    promise: session.waitForCompletion(),
    harnessProvider: "claude",
    hasLocalEnvironment: false,
  } as RunningTask;
}

function stateFor(tasks: RunningTask[]): RunnerState {
  return {
    deliveryMode: "push",
    activeTasks: new Map(tasks.map((t) => [t.taskId, t])),
    maxConcurrent: 2,
    tasksProcessed: 0,
    startedAt: 0,
    harnessProvider: "claude",
    codexCreditsExhaustedCooldownMs: 7_200_000,
    modelWindowBlocks: new Map(),
  };
}

describe("runner push delivery", () => {
  test("an idle worker polls at boot and on 30 second safety ticks", async () => {
    for (let now = 0; now <= 60_000; now += 1000) await poll(now);
    expect(requests.filter((r) => r === "GET /api/poll")).toHaveLength(3);
    await nudge("work");
    await poll(60_001);
    expect(requests.filter((r) => r === "GET /api/poll")).toHaveLength(4);
  });

  test("a nudge during fetch survives the empty response", async () => {
    delivery.checks("push", 0);
    delivery.beginPoll();
    await nudge("work");
    expect(delivery.checks("push", 1).work).toBe(true);
  });

  test("cancel fetches and aborts only the named task between safety ticks", async () => {
    await poll(0);
    const aborted: string[] = [];
    const targetId = crypto.randomUUID();
    const otherId = crypto.randomUUID();
    const state = stateFor([
      activeTask(targetId, async () => {
        aborted.push(targetId);
      }),
      activeTask(otherId, async () => {
        aborted.push(otherId);
      }),
    ]);
    cancelledId = targetId;
    await nudge("cancel", targetId);
    const checks = delivery.checks("push", 1000);
    const cancelledSignaled = new Set<string>();
    const fetched: string[] = [];
    await reconcileActiveTasks(state, "worker", {
      cancelledSignaled,
      cancelTaskIds: checks.cancelTaskIds,
      checkStatus: checks.safety,
      intervalMs: 30_000,
      now: () => 1000,
      isCancelled: async (taskId) => {
        fetched.push(taskId);
        const response = await fetch(`${apiUrl}/cancelled-tasks?taskId=${taskId}`);
        const body = (await response.json()) as { cancelled: { id: string }[] };
        return body.cancelled.some((task) => task.id === taskId);
      },
      fetchStatus: async () => {
        throw new Error("Status must wait for the safety tick");
      },
    });
    await waitUntil(() => aborted.length === 1);
    expect(fetched).toEqual([targetId]);
    expect(aborted).toEqual([targetId]);
    expect(checks.work).toBe(false);
    // Settlement continues between safety ticks for a session that never exits.
    await reconcileActiveTasks(state, "worker", {
      cancelledSignaled,
      cancelTaskIds: new Set(),
      checkStatus: false,
      intervalMs: 30_000,
      now: () => 20_000,
      isCancelled: async () => false,
      fetchStatus: async () => null,
    });
    expect(state.activeTasks.get(targetId)?.result).not.toBeNull();
  });

  test("steer dispatch targets its task without polling for work", async () => {
    await poll(0);
    const targetId = crypto.randomUUID();
    steeringId = targetId;
    const delivered: string[] = [];
    const tasks = [
      activeTask(
        targetId,
        async () => {},
        async (message) => {
          delivered.push(message.text);
          return { delivered: true, mode: "queue" };
        },
      ),
      activeTask(crypto.randomUUID(), async () => {}),
    ];
    await nudge("steer", targetId);
    const checks = delivery.checks("push", 1000);
    for (const task of tasks) {
      if (!checks.safety && !checks.steerTaskIds.has(task.taskId)) continue;
      await pollAndDispatchSteering(
        { apiUrl, apiKey, agentId },
        task.taskId,
        task.session,
        createSteeringDispatchState(),
      );
    }
    expect(delivered).toHaveLength(1);
    expect(requests.filter((r) => r === "GET /api/steering-messages")).toHaveLength(1);
    expect(checks.work).toBe(false);
  });

  test("config nudges request reconciliation immediately and safety ticks repeat it", async () => {
    await poll(0);
    expect(delivery.checks("push", 1000).config).toBe(false);
    await nudge("config");
    const checks = delivery.checks("push", 1001);
    expect(checks.config).toBe(true);
    if (checks.config) {
      const result = await fetchResolvedEnv(apiUrl, apiKey, agentId, { HARNESS_PROVIDER: "acp" });
      expect(result.env.MAX_CONCURRENT_TASKS).toBe("3");
    }
    expect(requests).toContain("GET /api/config/resolved");
    expect(delivery.checks("push", 1002).config).toBe(false);
    expect(delivery.checks("push", 30_000).config).toBe(true);
  });

  test("socket loss falls back after 60 seconds, warns once, and reconnect restores push", async () => {
    await poll(0);
    socket!.close();
    await waitUntil(() => !client.isConnected());
    const warning = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const disconnectedAt = client.disconnectedSince();
      expect(delivery.checks("push", disconnectedAt).push).toBe(true);
      expect(delivery.checks("push", disconnectedAt + 60_000).push).toBe(true);
      expect(delivery.checks("push", disconnectedAt + 60_001).push).toBe(false);
      expect(delivery.checks("push", disconnectedAt + 62_000).push).toBe(false);
      expect(warning).toHaveBeenCalledTimes(1);
      await waitUntil(() => client.isConnected());
      const checks = delivery.checks("push", client.disconnectedSince() + 63_000);
      expect(checks.push).toBe(true);
      expect(checks.work).toBe(true);
      expect(checks.config).toBe(true);
    } finally {
      warning.mockRestore();
    }
  });

  test("poll mode retains repeated fetching and maintenance eligibility", async () => {
    const checks = await poll(0, "poll");
    expect(checks.push).toBe(false);
    expect(checks.work).toBe(true);
    expect(checks.config).toBe(true);
    expect(requests.filter((r) => r === "GET /api/poll").length).toBeGreaterThan(1);
  });
});

test("delivery resolution honors worker overrides, older APIs, and channel-monitoring leads", () => {
  const warning = spyOn(console, "warn").mockImplementation(() => {});
  try {
    expect(resolveWorkerDeliveryMode(undefined, false, {})).toBe("poll");
    expect(resolveWorkerDeliveryMode("push", false, { SWARM_DELIVERY_MODE: "poll" })).toBe("poll");
    expect(resolveWorkerDeliveryMode("poll", false, { SWARM_DELIVERY_MODE: "push" })).toBe("push");
    expect(resolveWorkerDeliveryMode("push", true, { LEAD_MONITOR_CHANNELS: "true" })).toBe("poll");
    expect(resolveWorkerDeliveryMode("push", true, { LEAD_MONITOR_CHANNELS: "false" })).toBe(
      "push",
    );
    expect(resolveWorkerDeliveryMode("push", false, { LEAD_MONITOR_CHANNELS: "true" })).toBe(
      "push",
    );
    expect(warning).toHaveBeenCalledTimes(1);
    expect(resolvePushSafetyPollMs({})).toBe(30_000);
    expect(resolvePushSafetyPollMs({ RUNNER_PUSH_SAFETY_POLL_MS: "5000" })).toBe(5000);
    expect(resolvePushSafetyPollMs({ RUNNER_PUSH_SAFETY_POLL_MS: "0" })).toBe(30_000);
    expect(resolvePushSafetyPollMs({ RUNNER_PUSH_SAFETY_POLL_MS: "invalid" })).toBe(30_000);
  } finally {
    warning.mockRestore();
  }
});

test("registration preserves delivery mode when an API omits capability flags", async () => {
  const result = await registerAgent({
    apiUrl,
    apiKey,
    agentId,
    name: "push-worker",
    isLead: false,
    harnessProvider: "acp",
  });
  expect(result.deliveryMode).toBe("push");
  expect(result.serverCapabilities).toBeUndefined();
});
