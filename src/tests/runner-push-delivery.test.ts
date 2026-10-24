import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import {
  deliverySchedule,
  RunnerPushDelivery,
  resolvePushSafetyPollMs,
  resolveWorkerDeliveryMode,
  shouldRunDeliveryLoop,
  taskReconciliation,
  updateWorkerDeliveryMode,
} from "../commands/push-delivery";
import {
  createSteeringDispatchState,
  fetchResolvedEnv,
  pollForTrigger,
  type RunnerState,
  type RunningTask,
  reconcileActiveTasks,
  registerAgent,
  scheduleSteeringDispatch,
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
let pollStatus: number;
let steeringReadGate: Promise<void> | undefined;
let pollRequired: boolean | undefined;
let pollTriggerAfter: number | undefined;
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
  pollStatus = 200;
  steeringReadGate = undefined;
  pollRequired = undefined;
  pollTriggerAfter = undefined;
  socket = undefined;
  server = Bun.serve<undefined>({
    port: 0,
    async fetch(req, srv) {
      const url = new URL(req.url);
      if (url.pathname === "/api/realtime" && srv.upgrade(req, { data: undefined })) return;
      requests.push(`${req.method} ${url.pathname}`);
      if (url.pathname === "/api/agents")
        return Response.json({ deliveryMode: "push", pollRequired });
      if (url.pathname === "/api/config/resolved")
        return Response.json({ configs: [{ key: "MAX_CONCURRENT_TASKS", value: "3" }] });
      if (url.pathname === "/api/poll") {
        const count = requests.filter((r) => r === "GET /api/poll").length;
        return Response.json(
          {
            trigger:
              pollTriggerAfter && count >= pollTriggerAfter
                ? { type: "task_assigned", taskId: crypto.randomUUID() }
                : null,
          },
          { status: pollStatus },
        );
      }
      if (url.pathname === "/cancelled-tasks")
        return Response.json({ cancelled: cancelledId ? [{ id: cancelledId }] : [] });
      if (url.pathname === "/api/steering-messages") {
        const response = Response.json({
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
        await steeringReadGate;
        return response;
      }
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

test("shutdown stops an open poll window before it can claim a resume", async () => {
  let shuttingDown = false;
  // The second poll would claim the resume created during shutdown.
  pollTriggerAfter = 2;
  const sleep = spyOn(Bun, "sleep").mockImplementation(async () => {
    expect(requests.filter((r) => r === "GET /api/poll")).toHaveLength(1);
    shuttingDown = true;
  });
  try {
    const trigger = await pollForTrigger({
      apiUrl,
      apiKey,
      agentId,
      pollInterval: 2,
      pollTimeout: 5000,
      shouldStop: () => shuttingDown,
    });
    expect(shuttingDown).toBe(true);
    expect(trigger).toBeNull();
    expect(requests.filter((r) => r === "GET /api/poll")).toHaveLength(1);
  } finally {
    sleep.mockRestore();
  }
});

async function poll(now: number, mode: DeliveryMode = "push") {
  const checks = delivery.checks(mode, now);
  const schedule = delivery.schedule({
    mode,
    push: checks.push,
    activeCount: 0,
    maxConcurrent: 2,
    lastPushPingAt: now,
    pollInterval: 2,
    now,
  });
  if (!schedule.poll) return checks;
  await delivery.poll(schedule.singlePoll, (onPollFailure) =>
    pollForTrigger({
      apiUrl,
      apiKey,
      agentId,
      pollInterval: 2,
      pollTimeout: 5000,
      singlePoll: schedule.singlePoll,
      onPollFailure,
    }),
  );
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
    const schedule = delivery.schedule({
      mode: "push",
      push: true,
      activeCount: 0,
      maxConcurrent: 2,
      lastPushPingAt: Date.now(),
      pollInterval: 2000,
    });
    await delivery.poll(true, async () => {
      await nudge("work");
      return null;
    });
    const wait = spyOn(client, "waitForNudge").mockResolvedValue(null);
    try {
      await delivery.waitForSchedule(schedule);
      expect(wait).not.toHaveBeenCalled();
    } finally {
      wait.mockRestore();
    }
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
      ...taskReconciliation(checks),
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
    const dispatchState = createSteeringDispatchState();
    const errors: unknown[] = [];
    for (const task of tasks) {
      delivery.dispatchSteering(checks, task.taskId, () =>
        scheduleSteeringDispatch(
          { apiUrl, apiKey, agentId },
          task.taskId,
          task.session,
          dispatchState,
          (error) => errors.push(error),
        ),
      );
    }
    await waitUntil(() => delivered.length === 1);
    await waitUntil(
      () => dispatchState.pollingTaskIds.size === 0 && dispatchState.inFlightMessageIds.size === 0,
    );
    expect(errors).toEqual([]);
    expect(delivered).toHaveLength(1);
    expect(requests.filter((r) => r === "GET /api/steering-messages")).toHaveLength(1);
    expect(checks.work).toBe(false);
  });

  test("a steering nudge during an in-flight queue read retries that task", async () => {
    await poll(0);
    const taskId = crypto.randomUUID();
    const delivered: string[] = [];
    const task = activeTask(
      taskId,
      async () => {},
      async (message) => {
        delivered.push(message.text);
        return { delivered: true, mode: "queue" };
      },
    );
    const dispatchState = createSteeringDispatchState();
    const errors: unknown[] = [];
    const dispatch = () =>
      scheduleSteeringDispatch(
        { apiUrl, apiKey, agentId },
        taskId,
        task.session,
        dispatchState,
        (error) => errors.push(error),
      );
    let release!: () => void;
    steeringReadGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await nudge("steer", taskId);
    delivery.dispatchSteering(delivery.checks("push", 1), taskId, dispatch);
    await waitUntil(() => requests.includes("GET /api/steering-messages"));
    steeringId = taskId;
    await nudge("steer", taskId);
    delivery.dispatchSteering(delivery.checks("push", 2), taskId, dispatch);
    release();
    await waitUntil(() => !dispatchState.pollingTaskIds.has(taskId));
    delivery.dispatchSteering(delivery.checks("push", 3), taskId, dispatch);
    await waitUntil(() => delivered.length === 1);
    await waitUntil(
      () => dispatchState.pollingTaskIds.size === 0 && dispatchState.inFlightMessageIds.size === 0,
    );
    expect(errors).toEqual([]);
    expect(requests.filter((r) => r === "GET /api/steering-messages")).toHaveLength(2);
  });

  test.each([
    "http",
    "network",
  ])("a %s poll failure retries after the poll interval", async (failure) => {
    await poll(0);
    await nudge("work");
    const checks = delivery.checks("push", 1);
    const schedule = delivery.schedule({
      mode: "push",
      push: checks.push,
      activeCount: 0,
      maxConcurrent: 2,
      lastPushPingAt: Date.now(),
      pollInterval: 2,
    });
    pollStatus = 503;
    const fetchSpy =
      failure === "network"
        ? spyOn(globalThis, "fetch").mockRejectedValueOnce(new Error("connection lost"))
        : undefined;
    const warning = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const result = await delivery.poll(true, (onPollFailure) =>
        pollForTrigger({
          apiUrl,
          apiKey,
          agentId,
          pollInterval: 2,
          pollTimeout: 8,
          singlePoll: true,
          onPollFailure,
        }),
      );
      expect(result).toEqual({ trigger: null, failed: true });
      const sleep = spyOn(Bun, "sleep").mockResolvedValue(undefined);
      try {
        await delivery.waitForSchedule(schedule, result.failed, 2);
        expect(sleep).toHaveBeenCalledWith(2);
      } finally {
        sleep.mockRestore();
      }
      expect(
        delivery.schedule({
          mode: "push",
          push: true,
          activeCount: 0,
          maxConcurrent: 2,
          lastPushPingAt: 0,
          pollInterval: 2,
          now: 2,
        }).poll,
      ).toBe(true);
      pollStatus = 200;
      await poll(2);
      expect(delivery.checks("push", 3).work).toBe(false);
    } finally {
      fetchSpy?.mockRestore();
      warning.mockRestore();
    }
  });

  test("fallback fetches once, then waits for a nudge at poll cadence", async () => {
    const schedule = deliverySchedule({
      mode: "push",
      push: false,
      work: false,
      activeCount: 1,
      maxConcurrent: 2,
      lastPushPingAt: 0,
      pollInterval: 2000,
      now: 1,
    });
    const before = requests.filter((r) => r === "GET /api/poll").length;
    await delivery.poll(schedule.singlePoll, (onPollFailure) =>
      pollForTrigger({
        apiUrl,
        apiKey,
        agentId,
        pollInterval: 2,
        pollTimeout: 8,
        singlePoll: schedule.singlePoll,
        onPollFailure,
      }),
    );
    expect(requests.filter((r) => r === "GET /api/poll").length).toBe(before + 1);
    const wait = spyOn(client, "waitForNudge").mockResolvedValue(null);
    try {
      await delivery.waitForSchedule(schedule);
      expect(wait).toHaveBeenCalledWith(["work", "cancel", "steer", "config"], 2000);
    } finally {
      wait.mockRestore();
    }
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
    pollTriggerAfter = 2;
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
    expect(resolveWorkerDeliveryMode("poll", true, { SWARM_DELIVERY_MODE: "push" }, true)).toBe(
      "poll",
    );
    for (const flag of ["1", "TRUE", "yes"]) {
      expect(resolveWorkerDeliveryMode("push", true, { LEAD_MONITOR_CHANNELS: flag })).toBe("push");
    }
    expect(resolveWorkerDeliveryMode("push", true, { LEAD_MONITOR_CHANNELS: "false" })).toBe(
      "push",
    );
    expect(resolveWorkerDeliveryMode("push", false, { LEAD_MONITOR_CHANNELS: "true" })).toBe(
      "push",
    );
    expect(warning).toHaveBeenCalledTimes(2);
    expect(resolvePushSafetyPollMs({})).toBe(30_000);
    expect(resolvePushSafetyPollMs({ RUNNER_PUSH_SAFETY_POLL_MS: "5000" })).toBe(5000);
    expect(resolvePushSafetyPollMs({ RUNNER_PUSH_SAFETY_POLL_MS: "0" })).toBe(30_000);
    expect(resolvePushSafetyPollMs({ RUNNER_PUSH_SAFETY_POLL_MS: "invalid" })).toBe(30_000);
  } finally {
    warning.mockRestore();
  }
});

test("delivery logs report the source at startup and only repeat when the mode changes", () => {
  const log = spyOn(console, "log").mockImplementation(() => {});
  const warning = spyOn(console, "warn").mockImplementation(() => {});
  try {
    let mode = updateWorkerDeliveryMode(undefined, { deliveryMode: "poll" }, false, {});
    expect(log.mock.calls).toEqual([["[runner] Delivery mode: poll (register response: poll)."]]);
    mode = updateWorkerDeliveryMode(mode, { deliveryMode: "poll" }, false, {});
    expect(log).toHaveBeenCalledTimes(1);
    mode = updateWorkerDeliveryMode(mode, { deliveryMode: "push" }, false, {});
    expect(log.mock.calls.at(-1)?.[0]).toBe(
      "[runner] Delivery mode: push (register response: push).",
    );
    mode = updateWorkerDeliveryMode(mode, { deliveryMode: "push" }, false, {
      SWARM_DELIVERY_MODE: "poll",
    });
    expect(mode).toBe("poll");
    expect(log.mock.calls.at(-1)?.[0]).toBe(
      "[runner] Delivery mode: poll (SWARM_DELIVERY_MODE override: poll).",
    );
    updateWorkerDeliveryMode(undefined, {}, false, { SWARM_DELIVERY_MODE: "invalid" });
    expect(log.mock.calls.at(-1)?.[0]).toContain("register response omitted deliveryMode");
    updateWorkerDeliveryMode(undefined, { deliveryMode: "push", pollRequired: true }, true, {
      SWARM_DELIVERY_MODE: "push",
    });
    expect(log.mock.calls.at(-1)?.[0]).toBe(
      "[runner] Delivery mode: poll (SWARM_DELIVERY_MODE override: push, LEAD_MONITOR_CHANNELS requires poll).",
    );
  } finally {
    log.mockRestore();
    warning.mockRestore();
  }
});

test("scheduling bounds idle waits by ping time and preserves capacity and drain waits", () => {
  const options = {
    mode: "push" as const,
    push: true,
    work: false,
    activeCount: 0,
    maxConcurrent: 2,
    lastPushPingAt: 1000,
    pollInterval: 2000,
    now: 26_000,
  };
  expect(deliverySchedule(options)).toMatchObject({
    poll: false,
    singlePoll: true,
    waitKind: "push",
    waitMs: 5000,
  });
  expect(deliverySchedule({ ...options, now: 32_000 }).waitMs).toBe(0);
  expect(deliverySchedule({ ...options, activeCount: 1 }).waitMs).toBe(1000);
  for (const blocked of [{ activeCount: 2 }, { draining: true }]) {
    expect(deliverySchedule({ ...options, work: true, ...blocked })).toMatchObject({
      poll: false,
      waitKind: "push",
      waitMs: 1000,
    });
    expect(deliverySchedule({ ...options, mode: "poll", push: false, ...blocked })).toMatchObject({
      poll: false,
      singlePoll: false,
      waitKind: "sleep",
      waitMs: 1000,
    });
  }
  expect(deliverySchedule({ ...options, mode: "poll", push: false })).toMatchObject({
    poll: true,
    singlePoll: false,
  });
  expect(shouldRunDeliveryLoop("poll", true)).toBe(true);
  expect(shouldRunDeliveryLoop(undefined, true)).toBe(true);
  expect(shouldRunDeliveryLoop("push", true)).toBe(false);
  expect(shouldRunDeliveryLoop("push", false)).toBe(true);
});

test("completion wakes work after checks have already consumed the current iteration", async () => {
  await poll(0);
  expect(delivery.checks("push", 1).work).toBe(false);
  delivery.wakeWork();
  expect(
    delivery.schedule({
      mode: "push",
      push: true,
      activeCount: 0,
      maxConcurrent: 2,
      lastPushPingAt: 0,
      pollInterval: 2000,
      now: 1,
    }).poll,
  ).toBe(true);
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

test("registration preserves the API poll restriction without worker-side channel configuration", async () => {
  pollRequired = true;
  const result = await registerAgent({
    apiUrl,
    apiKey,
    agentId,
    name: "lead",
    isLead: true,
    harnessProvider: "acp",
  });
  expect(result.pollRequired).toBe(true);
  const warning = spyOn(console, "warn").mockImplementation(() => {});
  try {
    expect(
      resolveWorkerDeliveryMode(
        result.deliveryMode,
        true,
        { SWARM_DELIVERY_MODE: "push" },
        result.pollRequired,
      ),
    ).toBe("poll");
  } finally {
    warning.mockRestore();
  }
});
