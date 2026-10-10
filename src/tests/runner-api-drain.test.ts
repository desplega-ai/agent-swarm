/**
 * Worker side of the API drain. When the API answers with `X-Swarm-Draining: 1`
 * the runner hands off every in-flight task through the supersede route while
 * the API still serves, takes no new work, and leaves the SIGTERM handler as the
 * fallback. Against an API that never sends the header nothing changes.
 *
 * Every branch runs against a stub API speaking the real routes' wire shapes,
 * through the runner's real `supersedeTaskViaAPI`.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createServer as createHttpServer, type Server } from "node:http";
import {
  API_DRAIN_HANDOFF_MAX_ATTEMPTS,
  type ApiConfig,
  applyApiDrainSignal,
  checkCompletedProcesses,
  handOffTasksForApiDrain,
  pingServer,
  pollForTrigger,
  type RunnerState,
  type RunningTask,
} from "../commands/runner";
import type { ProviderResult, ProviderSession } from "../providers/types";
import { API_DRAINING_HEADER } from "../utils/api-drain";
import { listenOnFreePort } from "./test-net";

type Recorded = { method: string; path: string; body: string };
type Reply = { status: number; body: unknown };

let api: Server;
let apiUrl = "";
const requests: Recorded[] = [];
const RESUMED: Reply = {
  status: 200,
  body: { success: true, kind: "resumed", resumeTaskId: "resume-1" },
};
/** What the stub API answers; tests flip these. */
const stub = {
  draining: false,
  pingStatus: 204,
  /** Answers to supersede calls in order; the last one repeats. */
  supersede: [RESUMED] as Reply[],
};

const supersedeCalls = () => requests.filter((r) => r.path.endsWith("/supersede"));

beforeAll(async () => {
  api = createHttpServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const path = new URL(req.url || "/", "http://localhost").pathname;
      requests.push({ method: req.method ?? "", path, body: Buffer.concat(chunks).toString() });
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (stub.draining) headers[API_DRAINING_HEADER] = "1";
      if (path === "/ping") {
        res.writeHead(stub.pingStatus, headers);
        res.end();
      } else if (path === "/api/poll") {
        res.writeHead(200, headers);
        res.end(JSON.stringify({ trigger: null }));
      } else if (path.endsWith("/supersede")) {
        const reply =
          stub.supersede[Math.min(supersedeCalls().length - 1, stub.supersede.length - 1)];
        res.writeHead(reply?.status ?? 500, headers);
        res.end(JSON.stringify(reply?.body ?? {}));
      } else {
        res.writeHead(200, headers);
        res.end("{}");
      }
    });
  });
  apiUrl = `http://127.0.0.1:${await listenOnFreePort(api)}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => api.close(() => resolve()));
});

beforeEach(() => {
  requests.length = 0;
  stub.draining = false;
  stub.pingStatus = 204;
  stub.supersede = [RESUMED];
});

const apiConfig = (): ApiConfig => ({ apiUrl, apiKey: "example-key", agentId: "agent-1" });

function runningSession(): ProviderSession & { abortReasons: string[] } {
  const abortReasons: string[] = [];
  return {
    sessionId: "sess-1",
    abortReasons,
    onEvent: () => {},
    waitForCompletion: () => new Promise<ProviderResult>(() => {}),
    abort: async (reason?: string) => {
      abortReasons.push(reason ?? "");
    },
  };
}

function setup(taskCount = 1) {
  const sessions: Array<ProviderSession & { abortReasons: string[] }> = [];
  const tasks: RunningTask[] = [];
  const activeTasks = new Map<string, RunningTask>();
  for (let i = 0; i < taskCount; i++) {
    const session = runningSession();
    const task = {
      taskId: crypto.randomUUID(),
      session,
      logFile: "/tmp/runner-api-drain.log",
      startTime: new Date(),
      promise: session.waitForCompletion(),
      result: null,
      harnessProvider: "opencode",
      hasLocalEnvironment: false,
    } as RunningTask;
    sessions.push(session);
    tasks.push(task);
    activeTasks.set(task.taskId, task);
  }
  const state = {
    activeTasks,
    maxConcurrent: 2,
    startedAt: Date.now(),
    tasksProcessed: 0,
    harnessProvider: "opencode",
    codexCreditsExhaustedCooldownMs: 7_200_000,
    modelWindowBlocks: new Map(),
  } as RunnerState;
  return { state, sessions, tasks };
}

/** Let the fire-and-forget `session.abort` microtask run. */
const flush = () => Bun.sleep(5);

describe("applyApiDrainSignal", () => {
  test("a draining answer sets the state and a clean answer clears it", () => {
    const { state } = setup(0);
    expect(state.apiDraining).toBeUndefined();
    applyApiDrainSignal(state, "worker", true);
    expect(state.apiDraining).toBe(true);
    applyApiDrainSignal(state, "worker", false);
    expect(state.apiDraining).toBe(false);
  });

  test("no answer keeps the last known state", () => {
    const { state } = setup(0);
    applyApiDrainSignal(state, "worker", true);
    applyApiDrainSignal(state, "worker", undefined);
    expect(state.apiDraining).toBe(true);
  });
});

describe("pingServer", () => {
  test("reports draining only when the header is present", async () => {
    expect(await pingServer(apiConfig(), "worker")).toBe(false);
    stub.draining = true;
    expect(await pingServer(apiConfig(), "worker")).toBe(true);
  });

  test("reports no answer on a 5xx or a refused connection", async () => {
    stub.pingStatus = 503;
    expect(await pingServer(apiConfig(), "worker")).toBeUndefined();
    expect(await pingServer({ ...apiConfig(), apiUrl: "http://127.0.0.1:1" }, "worker")).toBe(
      undefined,
    );
  });
});

describe("pollForTrigger", () => {
  const opts = (extra: Partial<Parameters<typeof pollForTrigger>[0]> = {}) => ({
    apiUrl,
    apiKey: "example-key",
    agentId: "agent-1",
    pollInterval: 2000,
    pollTimeout: 5000,
    ...extra,
  });

  test("a draining answer ends the poll window early and reports the signal", async () => {
    stub.draining = true;
    const signals: boolean[] = [];
    const startedAt = Date.now();
    const trigger = await pollForTrigger(opts({ onApiDrainSignal: (d) => signals.push(d) }));
    expect(trigger).toBeNull();
    expect(signals).toEqual([true]);
    // Not the 2s poll interval, let alone the 5s window.
    expect(Date.now() - startedAt).toBeLessThan(1500);
  });

  test("without the header the poll keeps its normal window and reports not draining", async () => {
    const signals: boolean[] = [];
    const trigger = await pollForTrigger(
      opts({ pollTimeout: 150, pollInterval: 50, onApiDrainSignal: (d) => signals.push(d) }),
    );
    expect(trigger).toBeNull();
    expect(signals.length).toBeGreaterThan(1);
    expect(signals.every((d) => d === false)).toBe(true);
  });
});

describe("handOffTasksForApiDrain", () => {
  test("supersedes with the graceful_shutdown reason and aborts the session once", async () => {
    const { state, sessions, tasks } = setup(2);
    await handOffTasksForApiDrain(state, "worker", apiConfig());
    await flush();

    for (const [i, task] of tasks.entries()) {
      const call = supersedeCalls().find((r) => r.path === `/api/tasks/${task.taskId}/supersede`);
      expect(call?.method).toBe("POST");
      expect(JSON.parse(call?.body ?? "{}")).toEqual({ reason: "graceful_shutdown" });
      expect(task.serverTerminalStatus).toBe("superseded");
      expect(task.drainHandoffSettled).toBe(true);
      expect(sessions[i]?.abortReasons).toEqual(["graceful_shutdown"]);
    }
  });

  test("hands off once: later passes make no call for an answered task", async () => {
    const { state, sessions } = setup(1);
    for (let i = 0; i < 4; i++) await handOffTasksForApiDrain(state, "worker", apiConfig());
    await flush();
    expect(supersedeCalls()).toHaveLength(1);
    expect(sessions[0]?.abortReasons).toHaveLength(1);
  });

  test("a failed call leaves the task running and retries up to the cap", async () => {
    stub.supersede = [{ status: 503, body: { error: "unavailable" } }];
    const { state, sessions, tasks } = setup(1);
    for (let i = 0; i < API_DRAIN_HANDOFF_MAX_ATTEMPTS + 3; i++) {
      await handOffTasksForApiDrain(state, "worker", apiConfig());
    }
    await flush();
    expect(supersedeCalls()).toHaveLength(API_DRAIN_HANDOFF_MAX_ATTEMPTS);
    expect(sessions[0]?.abortReasons).toEqual([]);
    expect(tasks[0]?.serverTerminalStatus).toBeUndefined();
    expect(tasks[0]?.drainHandoffSettled).toBeUndefined();
  });

  test("a retry that lands after a failure completes the handoff", async () => {
    stub.supersede = [{ status: 503, body: { error: "unavailable" } }, RESUMED];
    const { state, sessions } = setup(1);
    await handOffTasksForApiDrain(state, "worker", apiConfig());
    await handOffTasksForApiDrain(state, "worker", apiConfig());
    await flush();
    expect(supersedeCalls()).toHaveLength(2);
    expect(sessions[0]?.abortReasons).toEqual(["graceful_shutdown"]);
  });

  test("a workflow step comes back failed and is still released", async () => {
    stub.supersede = [
      { status: 200, body: { success: true, kind: "workflow-failed", resumeTaskId: null } },
    ];
    const { state, sessions, tasks } = setup(1);
    await handOffTasksForApiDrain(state, "worker", apiConfig());
    await flush();
    expect(tasks[0]?.serverTerminalStatus).toBe("failed");
    expect(sessions[0]?.abortReasons).toEqual(["graceful_shutdown"]);
  });

  test("a rejected or already-finished task keeps its normal path and is not retried", async () => {
    const replies: Reply[] = [
      { status: 403, body: { error: "Task belongs to another agent" } },
      { status: 200, body: { success: true, kind: "alreadyFinished", resumeTaskId: null } },
    ];
    for (const reply of replies) {
      requests.length = 0;
      stub.supersede = [reply];
      const { state, sessions, tasks } = setup(1);
      await handOffTasksForApiDrain(state, "worker", apiConfig());
      await handOffTasksForApiDrain(state, "worker", apiConfig());
      await flush();
      expect(supersedeCalls()).toHaveLength(1);
      expect(sessions[0]?.abortReasons).toEqual([]);
      expect(tasks[0]?.serverTerminalStatus).toBeUndefined();
    }
  });

  test("a session that already settled is left to the completion path", async () => {
    const { state, tasks } = setup(1);
    (tasks[0] as RunningTask).result = { exitCode: 0, isError: false } as ProviderResult;
    await handOffTasksForApiDrain(state, "worker", apiConfig());
    expect(supersedeCalls()).toHaveLength(0);
  });

  test("a handed-off task frees its slot without a finish call", async () => {
    const { state, tasks } = setup(1);
    const task = tasks[0] as RunningTask;
    await handOffTasksForApiDrain(state, "worker", apiConfig());
    // The aborted session settles with a non-zero exit, as a real abort does.
    task.result = {
      exitCode: 1,
      isError: true,
      failureReason: "graceful_shutdown",
    } as ProviderResult;
    requests.length = 0;
    await checkCompletedProcesses(state, "worker", apiConfig());
    expect(state.activeTasks.size).toBe(0);
    expect(requests.some((r) => r.path.endsWith("/finish"))).toBe(false);
  });
});
