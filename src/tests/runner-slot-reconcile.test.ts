/**
 * A provider session whose promise never settles must not hold a worker
 * execution slot forever (GitHub issue #1819). These tests drive the runner's
 * real `reconcileActiveTasks` + `checkCompletedProcesses` against a session
 * that never settles, on a fake clock, and check the slot frees within the
 * reconcile interval plus the abort grace.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createServer as createHttpServer, type Server } from "node:http";
import {
  ABORT_SETTLE_GRACE_MS,
  type ApiConfig,
  checkCompletedProcesses,
  DEFAULT_TASK_RECONCILE_INTERVAL_MS,
  type RunnerState,
  type RunningTask,
  reconcileActiveTasks,
  resolveTaskReconcileIntervalMs,
} from "../commands/runner";
import type { ProviderResult, ProviderSession } from "../providers/types";
import { listenOnFreePort } from "./test-net";

const INTERVAL_MS = 30_000;
const TICK_MS = 1_000;

let api: Server;
let apiUrl = "";
/** Worker → API calls, as `METHOD /path`. */
const requests: string[] = [];

beforeAll(async () => {
  api = createHttpServer((req, res) => {
    requests.push(`${req.method} ${new URL(req.url || "/", "http://localhost").pathname}`);
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
