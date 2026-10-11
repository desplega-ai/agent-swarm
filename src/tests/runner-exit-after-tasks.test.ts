import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { createServer, type Server } from "node:http";
import {
  checkCompletedProcesses,
  exitAfterTasksIfFinished,
  type RunnerState,
  type RunningTask,
  resolveExitAfterTasks,
} from "../commands/runner";
import { listenOnFreePort } from "./test-net";

let server: Server;
let url: string;
const requests: Array<{ path: string; headers: Record<string, unknown> }> = [];
const agentId = crypto.randomUUID();
const runtimeId = crypto.randomUUID();
beforeAll(async () => {
  server = createServer((req, res) => {
    requests.push({ path: req.url!, headers: req.headers });
    res.writeHead(200);
    res.end("{}");
  });
  url = `http://localhost:${await listenOnFreePort(server)}`;
});
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});
beforeEach(() => {
  requests.length = 0;
});
function state(): RunnerState {
  return {
    activeTasks: new Map(),
    maxConcurrent: 2,
    startedAt: Date.now(),
    tasksProcessed: 0,
    harnessProvider: "claude",
    codexCreditsExhaustedCooldownMs: 0,
    modelWindowBlocks: new Map(),
  };
}
function config() {
  return { apiUrl: url, apiKey: "test-worker-credential", agentId, runtimeInstanceId: runtimeId };
}

test("exit limit requires a positive integer and defaults to disabled", () => {
  for (const value of [undefined, "", "0", "-1", "1.5", "invalid"])
    expect(resolveExitAfterTasks({ SWARM_EXIT_AFTER_TASKS: value })).toBeNull();
  expect(resolveExitAfterTasks({ SWARM_EXIT_AFTER_TASKS: "2" })).toBe(2);
});

test("completed task count closes only after the limit with no active task", async () => {
  const runner = state();
  const taskId = crypto.randomUUID();
  runner.activeTasks.set(taskId, {
    taskId,
    result: { exitCode: 0 },
    triggerType: "task_assigned",
    startTime: new Date(),
    harnessProvider: "claude",
    hasLocalEnvironment: false,
    serverTerminalStatus: "completed",
  } as RunningTask);
  expect(await exitAfterTasksIfFinished(runner, 1, config(), "worker")).toBe(false);
  await checkCompletedProcesses(runner, "worker");
  expect(runner.tasksProcessed).toBe(1);
  expect(await exitAfterTasksIfFinished(runner, 2, config(), "worker")).toBe(false);
  expect(await exitAfterTasksIfFinished(runner, null, config(), "worker")).toBe(false);
  expect(requests).toHaveLength(0);
  expect(await exitAfterTasksIfFinished(runner, 1, config(), "worker")).toBe(true);
  expect(requests[0]?.path).toBe("/close");
  expect(requests[0]?.headers["x-agent-id"]).toBe(agentId);
  expect(requests[0]?.headers["x-runtime-instance-id"]).toBe(runtimeId);
  expect(requests[0]?.headers.authorization).toBe("Bearer test-worker-credential");
});

test("another active task delays close after the limit", async () => {
  const runner = state();
  runner.tasksProcessed = 2;
  runner.activeTasks.set(crypto.randomUUID(), { result: null } as RunningTask);
  expect(await exitAfterTasksIfFinished(runner, 2, config(), "worker")).toBe(false);
  expect(requests).toHaveLength(0);
});
