import { afterAll, afterEach, beforeAll, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { createServer, type Server } from "node:http";
import {
  type ApiConfig,
  checkCompletedProcesses,
  ensureTaskFinished,
  exitAfterTasksIfFinished,
  type RunnerState,
  type RunningTask,
  reconcileActiveTasks,
} from "../commands/runner";
import type { CostData } from "../providers/types";
import { registerVolatileSecret } from "../utils/secret-scrubber";
import { listenOnFreePort } from "./test-net";

let server: Server;
let config: ApiConfig;
const taskId = crypto.randomUUID();
const previousMaxSec = process.env.RUNNER_FINISH_RETRY_MAX_SEC;
let failures: Record<string, number>;
let status: number;
let disconnect: boolean;
let requests: Array<{ path: string; method: string | undefined; body: Record<string, string> }>;
let waits: number[];
let sleep: ReturnType<typeof spyOn<typeof Bun, "sleep">>;
let finishGate: Promise<void> | undefined;
let costGate: Promise<void> | undefined;
let savedCosts: unknown[];
let hang: boolean;
let blockedTaskId: string | undefined;
let errorBody: string;

beforeAll(async () => {
  server = createServer(async (req, res) => {
    const path = req.url?.split("/").at(-1) ?? "";
    let text = "";
    for await (const chunk of req) text += chunk;
    requests.push({ path, method: req.method, body: text ? JSON.parse(text) : {} });
    if (path === "finish" && hang) return;
    if (path === "finish" && (!blockedTaskId || req.url?.includes(blockedTaskId))) await finishGate;
    if (path === "session-costs") await costGate;
    if ((failures[path] ?? 0) > 0) {
      failures[path]!--;
      if (disconnect) {
        req.socket.destroy();
        return;
      }
      res.writeHead(status).end(errorBody);
      return;
    }
    if (path === "session-costs") savedCosts.push(JSON.parse(text));
    res.writeHead(200, { "Content-Type": "application/json" }).end("{}");
  });
  config = {
    apiUrl: `http://127.0.0.1:${await listenOnFreePort(server)}`,
    apiKey: "finish-retry-test-credential",
    agentId: crypto.randomUUID(),
  };
});

beforeEach(() => {
  failures = {};
  status = 503;
  disconnect = false;
  requests = [];
  waits = [];
  finishGate = undefined;
  costGate = undefined;
  savedCosts = [];
  hang = false;
  blockedTaskId = undefined;
  errorBody = "API unavailable";
  process.env.RUNNER_FINISH_RETRY_MAX_SEC = "300";
  sleep = spyOn(Bun, "sleep").mockImplementation(async (ms) => {
    waits.push(Number(ms));
  });
});

afterEach(() => {
  sleep.mockRestore();
  if (previousMaxSec === undefined) delete process.env.RUNNER_FINISH_RETRY_MAX_SEC;
  else process.env.RUNNER_FINISH_RETRY_MAX_SEC = previousMaxSec;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

for (const network of [false, true]) {
  test(`final progress and finish survive repeated ${network ? "network" : "5xx"} failures`, async () => {
    failures = { progress: 2, finish: 2 };
    disconnect = network;
    await ensureTaskFinished(
      config,
      "worker",
      taskId,
      0,
      undefined,
      "saved result",
      "codex",
      undefined,
      "final progress",
    );
    expect(
      requests.filter((request) => request.path === "progress").map(({ body }) => body),
    ).toEqual(Array(3).fill({ progress: "final progress" }));
    expect(requests.filter((request) => request.path === "finish").map(({ body }) => body)).toEqual(
      Array(3).fill({ status: "completed", output: "saved result", provider: "codex" }),
    );
    expect(waits).toEqual([1000, 2000, 1000, 2000]);
  });
}

for (const path of ["progress", "finish"]) {
  for (const code of [400, 401, 403, 404, 409, 429]) {
    test(`${path} does not retry HTTP ${code}`, async () => {
      failures[path] = 10;
      status = code;
      await ensureTaskFinished(
        config,
        "worker",
        taskId,
        0,
        undefined,
        "saved result",
        "codex",
        undefined,
        "final progress",
      );
      expect(requests.filter((request) => request.path === path)).toHaveLength(1);
      expect(waits).toEqual([]);
      if (path === "progress" && code === 401)
        expect(requests.some((request) => request.path === "finish")).toBe(false);
    });
  }
}

for (const unresponsive of [false, true]) {
  test(`the retry budget bounds ${unresponsive ? "a hung request" : "persistent 5xx failures"}`, async () => {
    sleep.mockRestore();
    process.env.RUNNER_FINISH_RETRY_MAX_SEC = "0.05";
    failures.finish = 100;
    hang = unresponsive;
    const startedAt = Date.now();
    await ensureTaskFinished(config, "worker", taskId, 0, undefined, "saved result", "codex");
    expect(Date.now() - startedAt).toBeLessThan(1000);
    expect(requests.filter((request) => request.path === "finish")).toHaveLength(1);
  });
}

test("exit-after-N waits for finish acknowledgement and retains the active session", async () => {
  let release!: () => void;
  finishGate = new Promise<void>((resolve) => {
    release = resolve;
  });
  failures.finish = 2;
  const runner: RunnerState = {
    activeTasks: new Map([
      [
        taskId,
        {
          taskId,
          result: { exitCode: 0, output: "saved result" },
          finalProgress: { value: "final progress" },
          triggerType: "task_assigned",
          startTime: new Date(),
          harnessProvider: "codex",
          hasLocalEnvironment: false,
        } as RunningTask,
      ],
    ]),
    maxConcurrent: 1,
    startedAt: Date.now(),
    tasksProcessed: 0,
    harnessProvider: "codex",
    codexCreditsExhaustedCooldownMs: 0,
    modelWindowBlocks: new Map(),
  };
  const shutdown = mock(async (_signal: string) => {});
  const completion = checkCompletedProcesses(runner, "worker", config);
  try {
    const deadline = Date.now() + 1000;
    while (!requests.some((request) => request.path === "finish") && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 5));
    expect(requests.some((request) => request.path === "finish")).toBe(true);
    expect(requests.some((request) => request.method === "DELETE")).toBe(false);
    expect(await exitAfterTasksIfFinished(runner, 1, shutdown)).toBe(false);
    expect(runner.activeTasks.has(taskId)).toBe(true);
  } finally {
    release();
    await completion;
  }
  expect(runner.tasksProcessed).toBe(1);
  expect(requests.filter((request) => request.path === "finish")).toHaveLength(3);
  expect(requests.some((request) => request.method === "DELETE")).toBe(true);
  expect(await exitAfterTasksIfFinished(runner, 1, shutdown)).toBe(true);
  expect(shutdown).toHaveBeenCalledTimes(1);
});

function completedState(ids: string[]): RunnerState {
  return {
    activeTasks: new Map(
      ids.map((id) => [
        id,
        {
          taskId: id,
          result: { exitCode: 0, output: "saved result" },
          triggerType: "task_assigned",
          startTime: new Date(),
          harnessProvider: "codex",
          hasLocalEnvironment: false,
        } as RunningTask,
      ]),
    ),
    maxConcurrent: ids.length,
    startedAt: Date.now(),
    tasksProcessed: 0,
    harnessProvider: "codex",
    codexCreditsExhaustedCooldownMs: 0,
    modelWindowBlocks: new Map(),
  };
}

function sessionCost(): CostData {
  return {
    agentId: config.agentId,
    taskId,
    sessionId: crypto.randomUUID(),
    totalCostUsd: 0.25,
    inputTokens: 100,
    outputTokens: 20,
    durationMs: 1000,
    numTurns: 1,
    model: "gpt-5",
    provider: "codex",
    isError: false,
  };
}

for (const network of [false, true]) {
  test(`cost POST survives repeated ${network ? "network" : "5xx"} failures`, async () => {
    const runner = completedState([taskId]);
    const cost = sessionCost();
    runner.activeTasks.get(taskId)!.result!.cost = cost;
    failures["session-costs"] = 2;
    disconnect = network;
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      await checkCompletedProcesses(runner, "worker", config);
      const bodies = requests
        .filter((request) => request.path === "session-costs")
        .map(({ body }) => body);
      const id = bodies[0]?.id;
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
      expect(bodies).toEqual(Array(3).fill({ ...cost, id }));
      expect(savedCosts).toEqual([{ ...cost, id }]);
      expect(waits).toEqual([1000, 2000]);
      expect(runner.tasksProcessed).toBe(1);
      expect(warn.mock.calls.flat().join(" ")).toContain("Session cost POST failed.");
    } finally {
      warn.mockRestore();
    }
  });
}

for (const code of [400, 401, 403, 404, 409, 429]) {
  test(`cost POST does not retry HTTP ${code}`, async () => {
    const runner = completedState([taskId]);
    runner.activeTasks.get(taskId)!.result!.cost = sessionCost();
    failures["session-costs"] = 10;
    status = code;
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      await checkCompletedProcesses(runner, "worker", config);
      expect(requests.filter((request) => request.path === "session-costs")).toHaveLength(1);
      expect(savedCosts).toEqual([]);
      expect(waits).toEqual([]);
      if (code === 401)
        expect(warn.mock.calls.flat().join(" ")).toContain("runtime token revoked or expired");
    } finally {
      warn.mockRestore();
    }
  });
}

for (const unresponsive of [false, true]) {
  test(`cost retry budget bounds ${unresponsive ? "a hung request" : "persistent 5xx failures"}`, async () => {
    sleep.mockRestore();
    process.env.RUNNER_FINISH_RETRY_MAX_SEC = "0.05";
    const runner = completedState([taskId]);
    runner.activeTasks.get(taskId)!.result!.cost = sessionCost();
    failures["session-costs"] = 100;
    let release = () => {};
    if (unresponsive)
      costGate = new Promise<void>((resolve) => {
        release = resolve;
      });
    try {
      const startedAt = Date.now();
      await checkCompletedProcesses(runner, "worker", config);
      expect(Date.now() - startedAt).toBeLessThan(1000);
      expect(requests.filter((request) => request.path === "session-costs")).toHaveLength(1);
      expect(savedCosts).toEqual([]);
      expect(runner.tasksProcessed).toBe(1);
    } finally {
      release();
    }
  });
}

test("cost and finish POSTs run concurrently and exit-after-N waits for cost before runtime close", async () => {
  const runner = completedState([taskId]);
  const cost = sessionCost();
  runner.activeTasks.get(taskId)!.result!.cost = cost;
  let releaseCost!: () => void;
  let releaseFinish!: () => void;
  costGate = new Promise<void>((resolve) => {
    releaseCost = resolve;
  });
  finishGate = new Promise<void>((resolve) => {
    releaseFinish = resolve;
  });
  failures["session-costs"] = 2;
  const shutdown = mock(async (_signal: string) => {
    await fetch(`${config.apiUrl}/close`, {
      method: "POST",
      body: JSON.stringify({ runtimeShutdown: true }),
    });
  });
  const completion = checkCompletedProcesses(runner, "worker", config);
  try {
    const deadline = Date.now() + 1000;
    while (
      (!requests.some((request) => request.path === "finish") ||
        !requests.some((request) => request.path === "session-costs")) &&
      Date.now() < deadline
    )
      await new Promise((resolve) => setTimeout(resolve, 5));
    expect(requests.some((request) => request.path === "finish")).toBe(true);
    expect(requests.some((request) => request.path === "session-costs")).toBe(true);
    releaseFinish();
    expect(await exitAfterTasksIfFinished(runner, 1, shutdown)).toBe(false);
    expect(runner.activeTasks.has(taskId)).toBe(true);
    expect(requests.some((request) => request.method === "DELETE")).toBe(false);
    expect(requests.some((request) => request.path === "close")).toBe(false);
  } finally {
    releaseFinish();
    releaseCost();
    await completion;
  }
  expect(savedCosts).toMatchObject([cost]);
  expect(await exitAfterTasksIfFinished(runner, 1, shutdown)).toBe(true);
  expect(shutdown).toHaveBeenCalledTimes(1);
  expect(requests.at(-1)?.body).toEqual({ runtimeShutdown: true });
});

test("abort after server task completion still posts collected cost", async () => {
  const runner = completedState([taskId]);
  const task = runner.activeTasks.get(taskId)!;
  const result = { ...task.result!, cost: sessionCost() };
  task.result = null;
  const abort = mock(async () => {
    task.result = result;
  });
  task.session = {
    sessionId: result.cost.sessionId,
    onEvent: () => {},
    waitForCompletion: async () => result,
    abort,
  };
  await reconcileActiveTasks(runner, "worker", {
    cancelledSignaled: new Set(),
    isCancelled: async () => false,
    fetchStatus: async () => "completed",
    intervalMs: 1,
    now: () => task.startTime.getTime() + 2,
  });
  await checkCompletedProcesses(runner, "worker", config);
  expect(abort).toHaveBeenCalledTimes(1);
  expect(task.serverTerminalStatus).toBe("completed");
  expect(savedCosts).toMatchObject([result.cost]);
  expect(requests.some((request) => request.path === "finish")).toBe(false);
  expect(runner.activeTasks.size).toBe(0);
});

test("a blocked finish does not delay a sibling's retries or slot release", async () => {
  const siblingId = crypto.randomUUID();
  const runner = completedState([taskId, siblingId]);
  blockedTaskId = taskId;
  failures.finish = 2;
  let release!: () => void;
  finishGate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const completion = checkCompletedProcesses(runner, "worker", config);
  try {
    const deadline = Date.now() + 1000;
    while (runner.activeTasks.has(siblingId) && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 5));
    expect(runner.activeTasks.has(siblingId)).toBe(false);
    expect(runner.activeTasks.has(taskId)).toBe(true);
    expect(runner.tasksProcessed).toBe(1);
    expect(waits).toEqual([1000, 2000]);
  } finally {
    release();
    await completion;
  }
  expect(runner.tasksProcessed).toBe(2);
  expect(runner.activeTasks.size).toBe(0);
});

test("a completion exception releases its slot and preserves sibling completion", async () => {
  const siblingId = crypto.randomUUID();
  const runner = completedState([taskId, siblingId]);
  runner.activeTasks.get(taskId)!.result = { exitCode: 1, failureReason: "provider failed" };
  const log = spyOn(console, "log").mockImplementation((message) => {
    if (String(message).includes("Detected error for task"))
      throw new Error("completion preparation failed");
  });
  try {
    await checkCompletedProcesses(runner, "worker", config);
    expect(runner.activeTasks.size).toBe(0);
    expect(runner.tasksProcessed).toBe(2);
    expect(requests.filter((request) => request.path === "finish")).toHaveLength(1);
    expect(requests.filter((request) => request.method === "DELETE")).toHaveLength(2);
    const shutdown = mock(async (_signal: string) => {});
    expect(await exitAfterTasksIfFinished(runner, 2, shutdown)).toBe(true);
  } finally {
    log.mockRestore();
  }
});

test("HTTP 401 reports that the runtime token is revoked or expired", async () => {
  failures.finish = 1;
  status = 401;
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  try {
    await ensureTaskFinished(config, "worker", taskId, 0, undefined, "saved result", "codex");
    expect(warn.mock.calls.flat().join(" ")).toContain(
      "runtime token revoked or expired; giving up on finish",
    );
    expect(waits).toEqual([]);
  } finally {
    warn.mockRestore();
  }
});

test("5xx diagnostics scrub secrets before truncating the response body", async () => {
  const secret = `finish-${crypto.randomUUID()}`;
  registerVolatileSecret(secret, "runner.finish-retry-test");
  failures.finish = 1;
  errorBody = `${secret} ${"x".repeat(1000)} END_OF_BODY`;
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  try {
    await ensureTaskFinished(config, "worker", taskId, 0, undefined, "saved result", "codex");
    const diagnostic = warn.mock.calls.flat().join(" ");
    expect(diagnostic).not.toContain(secret);
    expect(diagnostic).toContain("REDACTED");
    expect(diagnostic).toContain("Final task finish POST failed.");
    expect(diagnostic).not.toContain("END_OF_BODY");
    expect(diagnostic.length).toBeLessThan(400);
  } finally {
    warn.mockRestore();
  }
});
