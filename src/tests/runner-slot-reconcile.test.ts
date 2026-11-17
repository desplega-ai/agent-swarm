/**
 * A provider session whose promise never settles must not hold a worker
 * execution slot forever (GitHub issue #1819). These tests drive the runner's
 * real `reconcileActiveTasks` + `checkCompletedProcesses` against a session
 * that never settles, on a fake clock, and check the slot frees within the
 * reconcile interval plus the abort grace.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { createServer as createHttpServer, type Server } from "node:http";
import {
  ABORT_SETTLE_GRACE_MS,
  type ApiConfig,
  checkCompletedProcesses,
  DEFAULT_TASK_RECONCILE_INTERVAL_MS,
  DEFAULT_TERMINAL_TASK_GRACE_MS,
  type RunnerState,
  type RunningTask,
  reconcileActiveTasks,
  resolveTaskReconcileIntervalMs,
  resolveTerminalTaskGraceMs,
} from "../commands/runner";
import type { ProviderResult, ProviderSession } from "../providers/types";
import { registerVolatileSecret } from "../utils/secret-scrubber";
import { listenOnFreePort } from "./test-net";

const INTERVAL_MS = 30_000;
const TICK_MS = 1_000;

let api: Server;
let apiUrl = "";
let deleteFailures = 0;
let hangDelete = false;
/** Worker → API calls, as `METHOD /path`. */
const requests: string[] = [];

beforeAll(async () => {
  api = createHttpServer((req, res) => {
    requests.push(`${req.method} ${new URL(req.url || "/", "http://localhost").pathname}`);
    if (req.method === "DELETE") {
      if (hangDelete) return;
      if (deleteFailures-- > 0) {
        res.writeHead(503);
        res.end();
        return;
      }
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end("{}");
  });
  apiUrl = `http://127.0.0.1:${await listenOnFreePort(api)}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => api.close(() => resolve()));
});

beforeEach(() => {
  requests.length = 0;
  deleteFailures = 0;
  hangDelete = false;
});

/** A session like the one in #1819: abort() returns, the promise never settles. */
function hungSession(): ProviderSession & { abortReasons: string[] } {
  const abortReasons: string[] = [];
  return {
    sessionId: "sess-hung",
    abortReasons,
    onEvent: () => {},
    waitForCompletion: () => new Promise<ProviderResult>(() => {}),
    abort: async (reason?: string) => {
      abortReasons.push(reason ?? "");
    },
  };
}

function setup(startedAt: number) {
  const session = hungSession();
  const taskId = crypto.randomUUID();
  const task = {
    taskId,
    triggerType: "task_assigned",
    session,
    logFile: "/tmp/runner-slot-reconcile.log",
    startTime: new Date(startedAt),
    promise: session.waitForCompletion(),
    result: null,
    harnessProvider: "opencode",
    hasLocalEnvironment: false,
  } as RunningTask;
  const state = {
    activeTasks: new Map<string, RunningTask>([[taskId, task]]),
    maxConcurrent: 1,
    startedAt,
    tasksProcessed: 0,
    harnessProvider: "opencode",
    codexCreditsExhaustedCooldownMs: 7_200_000,
    modelWindowBlocks: new Map(),
  } as RunnerState;
  return { session, taskId, task, state };
}

/**
 * Run main-loop iterations (complete → reconcile) on a fake clock until the
 * slot frees or `maxMs` elapses. Returns the elapsed fake time.
 */
async function runUntilFree(
  state: RunnerState,
  startedAt: number,
  opts: {
    serverStatus: () => string | null;
    cancelled?: () => boolean;
    apiConfig?: ApiConfig;
    maxMs: number;
  },
): Promise<{ elapsedMs: number; statusReads: number }> {
  let clock = startedAt;
  let statusReads = 0;
  const cancelledSignaled = new Set<string>();
  while (clock - startedAt <= opts.maxMs) {
    await checkCompletedProcesses(state, "worker", opts.apiConfig, cancelledSignaled);
    if (state.activeTasks.size === 0) break;
    await reconcileActiveTasks(state, "worker", {
      cancelledSignaled,
      isCancelled: async () => opts.cancelled?.() ?? false,
      fetchStatus: async () => {
        statusReads += 1;
        return opts.serverStatus();
      },
      intervalMs: INTERVAL_MS,
      now: () => clock,
    });
    clock += TICK_MS;
  }
  return { elapsedMs: clock - startedAt, statusReads };
}

describe("reconcileActiveTasks: a session that never settles", () => {
  test("server-terminal task: slot frees within interval + grace and the server result is kept", async () => {
    const startedAt = 1_000_000;
    const { session, task, state } = setup(startedAt);
    const apiConfig: ApiConfig = { apiUrl, apiKey: "test-key", agentId: crypto.randomUUID() };

    const { elapsedMs, statusReads } = await runUntilFree(state, startedAt, {
      serverStatus: () => "failed",
      apiConfig,
      maxMs: 5 * 60_000,
    });

    expect(state.activeTasks.size).toBe(0);
    expect(elapsedMs).toBeLessThanOrEqual(INTERVAL_MS + ABORT_SETTLE_GRACE_MS + 2 * TICK_MS);
    expect(statusReads).toBe(1);
    expect(session.abortReasons).toEqual(["server task failed"]);
    expect(task.serverTerminalStatus).toBe("failed");
    expect(task.result?.failureReason).toContain("runner exited without result");
    expect(state.tasksProcessed).toBe(1);
    // The server already finished the task: no finish write, no outcome reports.
    expect(requests.some((r) => r.endsWith("/finish"))).toBe(false);
    expect(requests.some((r) => r.startsWith("POST /api/keys/"))).toBe(false);
  });

  test("cancelled task: the abort is followed by a forced settle once the grace passes", async () => {
    const startedAt = 2_000_000;
    const { session, state } = setup(startedAt);

    const { elapsedMs } = await runUntilFree(state, startedAt, {
      serverStatus: () => "cancelled",
      cancelled: () => true,
      maxMs: 5 * 60_000,
    });

    expect(state.activeTasks.size).toBe(0);
    expect(elapsedMs).toBeLessThanOrEqual(ABORT_SETTLE_GRACE_MS + 2 * TICK_MS);
    expect(session.abortReasons).toEqual(["cancelled"]);
  });

  test("a task still in progress server-side keeps its slot, and status reads are throttled", async () => {
    const startedAt = 3_000_000;
    const { session, state } = setup(startedAt);

    const { statusReads } = await runUntilFree(state, startedAt, {
      serverStatus: () => "in_progress",
      maxMs: 3 * INTERVAL_MS,
    });

    expect(state.activeTasks.size).toBe(1);
    expect(session.abortReasons).toEqual([]);
    expect(statusReads).toBe(3);
  });

  test("an unreadable server status leaves the task alone", async () => {
    const startedAt = 4_000_000;
    const { session, state } = setup(startedAt);

    await runUntilFree(state, startedAt, { serverStatus: () => null, maxMs: 2 * INTERVAL_MS });

    expect(state.activeTasks.size).toBe(1);
    expect(session.abortReasons).toEqual([]);
  });
});

describe("reconcileActiveTasks: a server-terminal task whose session can finish its input", () => {
  /** Like Claude: `finishInput` closes stdin; `endsTurn` says whether the turn then ends. */
  function finishableSetup(startedAt: number, endsTurn: boolean) {
    const ctx = setup(startedAt);
    const finishCalls: number[] = [];
    ctx.session.finishInput = () => {
      finishCalls.push(finishCalls.length);
      if (!endsTurn) return;
      ctx.task.result = {
        exitCode: 0,
        isError: false,
        sessionId: "sess-hung",
        cost: {
          sessionId: "runner-session",
          taskId: ctx.taskId,
          agentId: crypto.randomUUID(),
          totalCostUsd: 0.42,
          durationMs: 1_000,
          numTurns: 3,
          model: "claude-sonnet-5-5",
          isError: false,
          provider: "claude",
        },
      };
    };
    return { ...ctx, finishCalls };
  }

  test("closes input instead of aborting, so the session's result and cost still land", async () => {
    const startedAt = 6_000_000;
    const { session, task, state, finishCalls } = finishableSetup(startedAt, true);
    const apiConfig: ApiConfig = { apiUrl, apiKey: "test-key", agentId: crypto.randomUUID() };

    await runUntilFree(state, startedAt, {
      serverStatus: () => "completed",
      apiConfig,
      maxMs: 5 * 60_000,
    });

    expect(state.activeTasks.size).toBe(0);
    expect(finishCalls).toHaveLength(1);
    expect(session.abortReasons).toEqual([]);
    expect(task.serverTerminalStatus).toBe("completed");
    expect(requests).toContain("POST /api/session-costs");
    expect(requests.some((r) => r.endsWith("/finish"))).toBe(false);
  });

  test("a session still running when the grace ends is aborted, then force-settled", async () => {
    const startedAt = 7_000_000;
    const { session, task, state, finishCalls } = finishableSetup(startedAt, false);

    const { elapsedMs, statusReads } = await runUntilFree(state, startedAt, {
      serverStatus: () => "completed",
      maxMs: 5 * 60_000,
    });

    expect(state.activeTasks.size).toBe(0);
    expect(finishCalls).toHaveLength(1);
    expect(statusReads).toBe(1);
    expect(session.abortReasons).toEqual(["server task completed"]);
    expect(elapsedMs).toBeGreaterThanOrEqual(INTERVAL_MS + DEFAULT_TERMINAL_TASK_GRACE_MS);
    expect(elapsedMs).toBeLessThanOrEqual(
      INTERVAL_MS + DEFAULT_TERMINAL_TASK_GRACE_MS + ABORT_SETTLE_GRACE_MS + 2 * TICK_MS,
    );
    expect(task.result?.failureReason).toContain("runner exited without result");
  });

  test("a cancelled task is aborted at once, without the grace", async () => {
    const startedAt = 8_000_000;
    const { session, state, finishCalls } = finishableSetup(startedAt, true);

    const { elapsedMs } = await runUntilFree(state, startedAt, {
      serverStatus: () => "cancelled",
      maxMs: 5 * 60_000,
    });

    expect(state.activeTasks.size).toBe(0);
    expect(finishCalls).toHaveLength(0);
    expect(session.abortReasons).toEqual(["server task cancelled"]);
    expect(elapsedMs).toBeLessThanOrEqual(INTERVAL_MS + ABORT_SETTLE_GRACE_MS + 2 * TICK_MS);
  });
});

describe("resolveTerminalTaskGraceMs", () => {
  test("reads RUNNER_TERMINAL_TASK_GRACE_MS, accepts 0, and falls back on unset or invalid values", () => {
    expect(resolveTerminalTaskGraceMs({ RUNNER_TERMINAL_TASK_GRACE_MS: "60000" })).toBe(60_000);
    expect(resolveTerminalTaskGraceMs({ RUNNER_TERMINAL_TASK_GRACE_MS: "0" })).toBe(0);
    expect(resolveTerminalTaskGraceMs({})).toBe(DEFAULT_TERMINAL_TASK_GRACE_MS);
    expect(resolveTerminalTaskGraceMs({ RUNNER_TERMINAL_TASK_GRACE_MS: "" })).toBe(
      DEFAULT_TERMINAL_TASK_GRACE_MS,
    );
    expect(resolveTerminalTaskGraceMs({ RUNNER_TERMINAL_TASK_GRACE_MS: "-1" })).toBe(
      DEFAULT_TERMINAL_TASK_GRACE_MS,
    );
    expect(resolveTerminalTaskGraceMs({ RUNNER_TERMINAL_TASK_GRACE_MS: "soon" })).toBe(
      DEFAULT_TERMINAL_TASK_GRACE_MS,
    );
  });
});

describe("resolveTaskReconcileIntervalMs", () => {
  test("reads RUNNER_TASK_RECONCILE_INTERVAL_MS and falls back on unset or invalid values", () => {
    expect(resolveTaskReconcileIntervalMs({ RUNNER_TASK_RECONCILE_INTERVAL_MS: "5000" })).toBe(
      5000,
    );
    expect(resolveTaskReconcileIntervalMs({})).toBe(DEFAULT_TASK_RECONCILE_INTERVAL_MS);
    expect(resolveTaskReconcileIntervalMs({ RUNNER_TASK_RECONCILE_INTERVAL_MS: "0" })).toBe(
      DEFAULT_TASK_RECONCILE_INTERVAL_MS,
    );
    expect(resolveTaskReconcileIntervalMs({ RUNNER_TASK_RECONCILE_INTERVAL_MS: "soon" })).toBe(
      DEFAULT_TASK_RECONCILE_INTERVAL_MS,
    );
  });
});

describe("completed session deletion", () => {
  test.each([
    "transient",
    "permanent",
    "timeout",
  ])("%s DELETE failure retries and completes within a few seconds", async (failure) => {
    const { task, taskId, state } = setup(Date.now());
    task.result = { exitCode: 0, sessionId: task.session.sessionId };
    task.serverTerminalStatus = "completed";
    const taskIds = [taskId];
    if (failure === "timeout") {
      for (let i = 0; i < 2; i++) {
        const sibling = setup(Date.now());
        sibling.task.result = { exitCode: 0, sessionId: sibling.task.session.sessionId };
        sibling.task.serverTerminalStatus = "completed";
        state.activeTasks.set(sibling.taskId, sibling.task);
        taskIds.push(sibling.taskId);
      }
    }
    deleteFailures = failure === "transient" ? 2 : 3;
    hangDelete = failure === "timeout";
    const warning = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const start = Date.now();
      await checkCompletedProcesses(state, "worker", {
        apiUrl,
        apiKey: "test-key",
        agentId: crypto.randomUUID(),
      });
      expect(Date.now() - start).toBeLessThan(5_000);
      expect(requests).toHaveLength(3 * taskIds.length);
      for (const id of taskIds)
        expect(
          requests.filter((request) => request === `DELETE /api/active-sessions/by-task/${id}`),
        ).toHaveLength(3);
      expect(state.activeTasks.size).toBe(0);
      expect(state.tasksProcessed).toBe(taskIds.length);
      if (failure === "transient") {
        expect(warning).not.toHaveBeenCalled();
      } else {
        expect(warning).toHaveBeenCalledTimes(taskIds.length);
        expect(warning.mock.calls[0]?.[0]).toContain("after 3 attempts");
      }
    } finally {
      warning.mockRestore();
    }
  });

  test("network failures retry and the final warning scrubs secrets", async () => {
    const { task, state } = setup(Date.now());
    task.result = { exitCode: 0, sessionId: task.session.sessionId };
    task.serverTerminalStatus = "completed";
    const secret = `delete-secret-${crypto.randomUUID()}`;
    registerVolatileSecret(secret, "session-delete-test");
    const fetchSpy = spyOn(globalThis, "fetch").mockRejectedValue(new Error(secret));
    const warning = spyOn(console, "warn").mockImplementation(() => {});
    try {
      await checkCompletedProcesses(state, "worker", {
        apiUrl,
        apiKey: "test-key",
        agentId: crypto.randomUUID(),
      });
      expect(fetchSpy).toHaveBeenCalledTimes(3);
      expect(warning).toHaveBeenCalledTimes(1);
      expect(warning.mock.calls[0]?.[0]).toContain("after 3 attempts");
      expect(warning.mock.calls[0]?.[0]).not.toContain(secret);
      expect(state.tasksProcessed).toBe(1);
    } finally {
      fetchSpy.mockRestore();
      warning.mockRestore();
    }
  });
});

describe("reconcileActiveTasks: several active tasks", () => {
  test("checks every task's cancellation together, not one after another", async () => {
    const first = setup(1_000_000);
    const second = setup(1_000_000);
    const state = first.state;
    state.activeTasks.set(second.taskId, second.task);
    state.maxConcurrent = 2;

    // Each cancellation read resolves only once both reads are in flight, so a
    // sequential loop would wait out the fallback timer instead.
    const started: string[] = [];
    let releaseAll: () => void = () => {};
    const bothStarted = new Promise<void>((resolve) => {
      releaseAll = resolve;
    });
    let ranAlone = false;
    const cancelledSignaled = new Set<string>();
    await reconcileActiveTasks(state, "worker", {
      cancelledSignaled,
      isCancelled: async (taskId) => {
        started.push(taskId);
        if (started.length === 2) releaseAll();
        await Promise.race([bothStarted, Bun.sleep(500)]);
        if (started.length < 2) ranAlone = true;
        return taskId === second.taskId;
      },
      fetchStatus: async () => null,
      intervalMs: INTERVAL_MS,
      now: () => 1_000_000,
    });

    expect(ranAlone).toBe(false);
    expect([...cancelledSignaled]).toEqual([second.taskId]);
    expect(second.session.abortReasons).toEqual(["cancelled"]);
    expect(first.session.abortReasons).toEqual([]);
  });
});
