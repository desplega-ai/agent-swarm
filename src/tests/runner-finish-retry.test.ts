import { afterAll, afterEach, beforeAll, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { createServer, type Server } from "node:http";
import {
  type ApiConfig,
  checkCompletedProcesses,
  ensureTaskFinished,
  exitAfterTasksIfFinished,
  type RunnerState,
  type RunningTask,
} from "../commands/runner";
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
let hang: boolean;

beforeAll(async () => {
  server = createServer(async (req, res) => {
    const path = req.url?.split("/").at(-1) ?? "";
    let text = "";
    for await (const chunk of req) text += chunk;
    requests.push({ path, method: req.method, body: text ? JSON.parse(text) : {} });
    if (path === "finish" && hang) return;
    if (path === "finish") await finishGate;
    if ((failures[path] ?? 0) > 0) {
      failures[path]!--;
      if (disconnect) {
        req.socket.destroy();
        return;
      }
      res.writeHead(status).end("API unavailable");
      return;
    }
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
  hang = false;
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
