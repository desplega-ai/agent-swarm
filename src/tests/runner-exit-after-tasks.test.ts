import { afterAll, beforeAll, beforeEach, expect, mock, test } from "bun:test";
import { createServer, type Server } from "node:http";
import {
  checkCompletedProcesses,
  exitAfterTasksIfFinished,
  type RunnerState,
  type RunningTask,
  resolveExitAfterTasks,
} from "../commands/runner";
import { listenOnFreePort } from "./test-net";
import { CHILD_PROCESS_TEST_BUDGET_MS, expectChildOk, runChild } from "./test-proc";

let server: Server;
let url: string;
const requests: Array<{ path: string; headers: Record<string, unknown>; body: unknown }> = [];
const agentId = crypto.randomUUID();
const runtimeId = crypto.randomUUID();
beforeAll(async () => {
  server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks).toString();
    requests.push({ path: req.url!, headers: req.headers, body: body ? JSON.parse(body) : {} });
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

test("completed task count invokes shutdown only after the limit with no active task", async () => {
  const runner = state();
  const shutdown = mock(async (_signal: string) => {});
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
  expect(await exitAfterTasksIfFinished(runner, 1, shutdown)).toBe(false);
  await checkCompletedProcesses(runner, "worker");
  expect(runner.tasksProcessed).toBe(1);
  expect(await exitAfterTasksIfFinished(runner, 2, shutdown)).toBe(false);
  expect(await exitAfterTasksIfFinished(runner, null, shutdown)).toBe(false);
  expect(shutdown).not.toHaveBeenCalled();
  expect(await exitAfterTasksIfFinished(runner, 1, shutdown)).toBe(true);
  expect(shutdown).toHaveBeenCalledTimes(1);
  expect(shutdown).toHaveBeenCalledWith("SWARM_EXIT_AFTER_TASKS");
});

test("another active task delays close after the limit", async () => {
  const runner = state();
  const shutdown = mock(async (_signal: string) => {});
  runner.tasksProcessed = 2;
  runner.activeTasks.set(crypto.randomUUID(), { result: null } as RunningTask);
  expect(await exitAfterTasksIfFinished(runner, 2, shutdown)).toBe(false);
  expect(shutdown).not.toHaveBeenCalled();
});

for (const serverTerminalStatus of [undefined, "completed"]) {
  test(`only assigned and resumed task executions count (server status: ${serverTerminalStatus ?? "unset"})`, async () => {
    const runner = state();
    for (const triggerType of [
      "task_assigned",
      "task_resumed",
      "task_offered",
      "unread_mentions",
      "pool_tasks_available",
      "channel_activity",
    ]) {
      const taskId = crypto.randomUUID();
      runner.activeTasks.set(taskId, {
        taskId,
        result: { exitCode: 0 },
        triggerType,
        startTime: new Date(),
        harnessProvider: "claude",
        hasLocalEnvironment: false,
        serverTerminalStatus,
      } as RunningTask);
    }
    await checkCompletedProcesses(runner, "worker");
    expect(runner.tasksProcessed).toBe(2);
    expect(runner.activeTasks.size).toBe(0);
    await checkCompletedProcesses(runner, "worker");
    expect(runner.tasksProcessed).toBe(2);
  });
}

test(
  "exit limit uses runner shutdown cleanup and sends an explicit termination signal",
  async () => {
    const tempDir = `/tmp/runner-exit-shutdown-${crypto.randomUUID()}`;
    await Bun.$`mkdir -p ${tempDir}`.quiet();
    try {
      await Bun.write(
        `${tempDir}/runner.ts`,
        `
      import { exitAfterTasksIfFinished, setupShutdownHandlers } from ${JSON.stringify(`${import.meta.dir}/../commands/runner.ts`)};
      const state = { activeTasks: new Map(), tasksProcessed: 1, startedAt: Date.now() };
      const shutdown = setupShutdownHandlers("worker", ${JSON.stringify(config())}, () => state, () => console.log("shutdown callback"));
      await exitAfterTasksIfFinished(state, 1, shutdown);
      console.log("unexpected return");
    `,
      );
      const result = expectChildOk(
        await runChild([process.execPath, `${tempDir}/runner.ts`], {
          cwd: tempDir,
          env: {
            ...process.env,
            PATH: tempDir,
            ANONYMIZED_TELEMETRY: "false",
          },
        }),
        "runner shutdown",
      );
      expect(result.stdout).toContain("shutdown callback");
      expect(result.stdout).not.toContain("unexpected return");
      expect(requests).toHaveLength(1);
      expect(requests[0]?.path).toBe("/close");
      expect(requests[0]?.headers["x-agent-id"]).toBe(agentId);
      expect(requests[0]?.headers["x-runtime-instance-id"]).toBe(runtimeId);
      expect(requests[0]?.headers.authorization).toBe("Bearer test-worker-credential");
      expect(requests[0]?.body).toEqual({ runtimeShutdown: true });
    } finally {
      await Bun.$`rm -rf ${tempDir}`.quiet();
    }
  },
  CHILD_PROCESS_TEST_BUDGET_MS,
);
