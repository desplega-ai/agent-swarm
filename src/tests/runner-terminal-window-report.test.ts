/**
 * P1: a session whose task the server already holds as completed or failed
 * (the agent finished before its session ended) still reports the usage
 * windows it observed. The finish call and the key outcome stay skipped.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { checkCompletedProcesses, type RunnerState, type RunningTask } from "../commands/runner";
import type { ProviderSession } from "../providers/types";

/** Worker → API calls, as `METHOD /path` plus the parsed body. */
const requests: Array<{ call: string; body: unknown }> = [];
let server: ReturnType<typeof Bun.serve>;
let apiUrl = "";

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const text = await req.text();
      requests.push({
        call: `${req.method} ${new URL(req.url).pathname}`,
        body: text ? JSON.parse(text) : undefined,
      });
      return Response.json({ success: true });
    },
  });
  apiUrl = `http://127.0.0.1:${server.port}`;
});

afterAll(() => {
  server.stop(true);
});

beforeEach(() => {
  requests.length = 0;
});

const WINDOWS_PATH = "POST /api/keys/report-rate-limit-windows";

function settledSession(): ProviderSession {
  return {
    sessionId: "s-1",
    onEvent: () => {},
    waitForCompletion: () => new Promise(() => {}),
    abort: async () => {},
  } as unknown as ProviderSession;
}

function setup(serverTerminalStatus: string, withWindows = true) {
  const taskId = crypto.randomUUID();
  const task = {
    taskId,
    triggerType: "task_assigned",
    session: settledSession(),
    logFile: "/tmp/runner-terminal-window-report.log",
    startTime: new Date(),
    promise: new Promise(() => {}),
    result: {
      exitCode: 0,
      sessionId: "s-1",
      ...(withWindows
        ? {
            rateLimitWindows: {
              five_hour: {
                status: "allowed",
                utilization: 0.53,
                resetsAt: Math.floor(Date.now() / 1000) + 3600,
                lastSeenAt: new Date().toISOString(),
              },
            },
          }
        : {}),
    },
    harnessProvider: "claude",
    hasLocalEnvironment: false,
    credentialInfo: { keyType: "CLAUDE_CODE_OAUTH_TOKEN", keySuffix: "DNAAA", keyIndex: 3 },
    serverTerminalStatus,
  } as unknown as RunningTask;
  const state = {
    activeTasks: new Map<string, RunningTask>([[taskId, task]]),
    maxConcurrent: 1,
    startedAt: Date.now(),
    tasksProcessed: 0,
    harnessProvider: "claude",
    codexCreditsExhaustedCooldownMs: 7_200_000,
    modelWindowBlocks: new Map(),
  } as RunnerState;
  return { taskId, state };
}

/** The window report is fire-and-forget: wait until it lands or the budget runs out. */
async function waitForCall(call: string, budgetMs = 2_000): Promise<void> {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline && !requests.some((r) => r.call === call)) await Bun.sleep(10);
}

const apiConfig = () => ({ apiUrl, apiKey: "test-key", agentId: crypto.randomUUID() });

describe("checkCompletedProcesses — window telemetry for a task terminal server-side", () => {
  test.each(["completed", "failed"])("%s: one window report, no finish", async (status) => {
    const { taskId, state } = setup(status);
    await checkCompletedProcesses(state, "worker", apiConfig());
    await waitForCall(WINDOWS_PATH);

    const windowReports = requests.filter((r) => r.call === WINDOWS_PATH);
    expect(windowReports).toHaveLength(1);
    expect(windowReports[0]?.body).toMatchObject({
      keyType: "CLAUDE_CODE_OAUTH_TOKEN",
      keySuffix: "DNAAA",
      keyIndex: 3,
      windows: { five_hour: { utilization: 0.53 } },
    });
    // The server result stands: no finish, no key outcome.
    expect(requests.some((r) => r.call.includes("/finish"))).toBe(false);
    expect(requests.some((r) => r.call === "POST /api/keys/clear-rate-limit")).toBe(false);
    expect(state.activeTasks.has(taskId)).toBe(false);
  });

  test("cancelled: no window report", async () => {
    const { state } = setup("cancelled");
    await checkCompletedProcesses(state, "worker", apiConfig());
    await Bun.sleep(100);
    expect(requests.some((r) => r.call === WINDOWS_PATH)).toBe(false);
  });

  test("a session without windows sends no report", async () => {
    const { state } = setup("completed", false);
    await checkCompletedProcesses(state, "worker", apiConfig());
    await Bun.sleep(100);
    expect(requests.some((r) => r.call === WINDOWS_PATH)).toBe(false);
  });
});
