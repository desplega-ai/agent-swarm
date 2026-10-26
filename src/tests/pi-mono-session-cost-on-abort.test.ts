import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import {
  type ReconcileActiveTasksOptions,
  type RunnerState,
  type RunningTask,
  reconcileActiveTasks,
} from "../commands/runner";
import { PiMonoSession } from "../providers/pi-mono-adapter";
import type { CostData, ProviderEvent, ProviderSessionConfig } from "../providers/types";

type AgentSessionEvent = Parameters<Parameters<AgentSession["subscribe"]>[0]>[0];

const tmpLogDir = `/tmp/pi-mono-cost-abort-test-${Date.now()}`;

beforeAll(() => {
  mkdirSync(tmpLogDir, { recursive: true });
});

afterAll(() => {
  rmSync(tmpLogDir, { recursive: true, force: true });
});

function makeSessionConfig(logFile: string): ProviderSessionConfig {
  return {
    prompt: "Coordinate sub-agents and complete the lead task",
    systemPrompt: "",
    model: "anthropic/claude-opus-4-6",
    role: "lead",
    agentId: "lead-agent-id",
    taskId: "lead-task-id",
    apiUrl: "http://localhost:3013",
    apiKey: "example-test-key",
    cwd: "/tmp",
    logFile,
    iteration: 1,
  };
}

describe("PiMonoSession & runner — long lead session cost preservation (#2073)", () => {
  test("abort() unblocks waitForIdle() and preserves cost after terminal store-progress", async () => {
    const listeners: Array<(event: AgentSessionEvent) => void> = [];
    const mockSession = {
      sessionId: "lead-pi-session-1",
      isStreaming: true,
      model: { provider: "anthropic", id: "claude-opus-4-6" },
      subscribe(listener: (event: AgentSessionEvent) => void) {
        listeners.push(listener);
        return () => {
          const idx = listeners.indexOf(listener);
          if (idx >= 0) listeners.splice(idx, 1);
        };
      },
      async prompt() {
        for (const l of listeners) {
          l({
            type: "tool_execution_start",
            toolCallId: "sp-1",
            toolName: "agent-swarm_store-progress",
            args: { status: "completed", output: "All sub-tasks merged" },
          } as unknown as AgentSessionEvent);
          l({
            type: "tool_execution_end",
            toolCallId: "sp-1",
            toolName: "agent-swarm_store-progress",
            result: { success: true },
            isError: false,
          } as unknown as AgentSessionEvent);
        }
        // Simulate a streaming turn that never emits agent_end before runner aborts it
      },
      getContextUsage: () => null,
      getSessionStats: () => ({
        tokens: { input: 42000, output: 3800, cacheRead: 120000, cacheWrite: 15000, total: 180800 },
        cost: 1.85,
        userMessages: 1,
        assistantMessages: 14,
      }),
      abort: async () => {},
      dispose: () => {},
    } as unknown as AgentSession;

    const logFile = join(tmpLogDir, `lead-abort-idle-${Date.now()}.log`);
    const session = new PiMonoSession(mockSession, makeSessionConfig(logFile), false);
    const events: ProviderEvent[] = [];
    session.onEvent((e) => events.push(e));

    // Allow prompt() to emit store-progress and enter waitForIdle()
    await Bun.sleep(20);

    // Mid-session result snapshot should already be emitted on terminal store-progress
    const resultEventsBeforeAbort = events.filter((e) => e.type === "result");
    expect(resultEventsBeforeAbort.length).toBeGreaterThanOrEqual(1);

    // Runner reconciliation aborts the session because the task is now completed server-side
    await session.abort();

    const result = await session.waitForCompletion();
    expect(result.exitCode).toBe(0);
    expect(result.isError).toBe(false);
    expect(result.cost).toBeDefined();
    expect(result.cost?.totalCostUsd).toBe(1.85);
    expect(result.cost?.inputTokens).toBe(42000);
    expect(result.cost?.outputTokens).toBe(3800);
    expect(result.cost?.cacheReadTokens).toBe(120000);
    expect(result.cost?.cacheWriteTokens).toBe(15000);
    expect(result.cost?.numTurns).toBe(15);
    expect(result.cost?.provider).toBe("pi");
  });

  test("prompt() rejection on abort after terminal store-progress still returns cost and exitCode 0", async () => {
    const listeners: Array<(event: AgentSessionEvent) => void> = [];
    let rejectPrompt: (err: Error) => void = () => {};
    const promptBlocked = new Promise<void>((_, reject) => {
      rejectPrompt = reject;
    });

    const mockSession = {
      sessionId: "lead-pi-session-2",
      isStreaming: true,
      model: { provider: "anthropic", id: "claude-opus-4-6" },
      subscribe(listener: (event: AgentSessionEvent) => void) {
        listeners.push(listener);
        return () => {
          const idx = listeners.indexOf(listener);
          if (idx >= 0) listeners.splice(idx, 1);
        };
      },
      async prompt() {
        for (const l of listeners) {
          l({
            type: "tool_execution_start",
            toolCallId: "sp-2",
            toolName: "store-progress",
            args: { status: "completed", output: "Done" },
          } as unknown as AgentSessionEvent);
          l({
            type: "tool_execution_end",
            toolCallId: "sp-2",
            toolName: "store-progress",
            result: { ok: true },
            isError: false,
          } as unknown as AgentSessionEvent);
        }
        await promptBlocked;
      },
      getContextUsage: () => null,
      getSessionStats: () => ({
        tokens: { input: 18500, output: 2100, cacheRead: 50000, cacheWrite: 6000, total: 76600 },
        cost: 0.92,
        userMessages: 1,
        assistantMessages: 8,
      }),
      abort: async () => {
        rejectPrompt(new Error("Request aborted"));
      },
      dispose: () => {},
    } as unknown as AgentSession;

    const logFile = join(tmpLogDir, `lead-abort-throw-${Date.now()}.log`);
    const session = new PiMonoSession(mockSession, makeSessionConfig(logFile), false);

    await Bun.sleep(20);
    await session.abort();

    const result = await session.waitForCompletion();
    expect(result.exitCode).toBe(0);
    expect(result.isError).toBe(false);
    expect(result.cost).toBeDefined();
    expect(result.cost?.totalCostUsd).toBe(0.92);
    expect(result.cost?.inputTokens).toBe(18500);
    expect(result.cost?.outputTokens).toBe(2100);
  });

  test("unexpected throw in runSession attaches partial session cost with isError: true", async () => {
    const mockSession = {
      sessionId: "lead-pi-session-3",
      isStreaming: false,
      model: { provider: "anthropic", id: "claude-opus-4-6" },
      subscribe: () => () => {},
      async prompt() {
        throw new Error("MCP transport disconnected after 10 turns");
      },
      getContextUsage: () => null,
      getSessionStats: () => ({
        tokens: { input: 9000, output: 1100, cacheRead: 4000, cacheWrite: 1000, total: 15100 },
        cost: 0.41,
        userMessages: 1,
        assistantMessages: 5,
      }),
      abort: async () => {},
      dispose: () => {},
    } as unknown as AgentSession;

    const logFile = join(tmpLogDir, `lead-unexpected-throw-${Date.now()}.log`);
    const session = new PiMonoSession(mockSession, makeSessionConfig(logFile), false);

    const result = await session.waitForCompletion();
    expect(result.exitCode).toBe(1);
    expect(result.isError).toBe(true);
    expect(result.cost).toBeDefined();
    expect(result.cost?.isError).toBe(true);
    expect(result.cost?.totalCostUsd).toBe(0.41);
    expect(result.cost?.inputTokens).toBe(9000);
  });

  test("reconcileActiveTasks preserves task.lastCost when settling an unresponsive aborted session", async () => {
    const snapshotCost: CostData = {
      sessionId: "runner-session-1",
      taskId: "task-2073",
      agentId: "lead-agent-id",
      totalCostUsd: 2.34,
      inputTokens: 64000,
      outputTokens: 5200,
      cacheReadTokens: 150000,
      cacheWriteTokens: 20000,
      durationMs: 1_200_000,
      numTurns: 22,
      model: "anthropic/claude-opus-4-6",
      isError: false,
      provider: "pi",
    };

    const task: RunningTask = {
      taskId: "task-2073",
      session: {
        sessionId: "pi-session-2073",
        onEvent: () => {},
        waitForCompletion: () => new Promise(() => {}),
        abort: async () => {},
      },
      logFile: "/tmp/task-2073.log",
      startTime: new Date(1_000),
      promise: new Promise(() => {}),
      result: null,
      harnessProvider: "pi",
      hasLocalEnvironment: true,
      abortRequestedAt: 10_000,
      serverTerminalStatus: "completed",
      lastCost: { value: snapshotCost },
    };

    const state: RunnerState = {
      activeTasks: new Map([["task-2073", task]]),
      deliveryMode: "poll",
      maxConcurrent: 2,
      startedAt: 0,
      tasksProcessed: 0,
      harnessProvider: "pi",
      codexCreditsExhaustedCooldownMs: 60_000,
      modelWindowBlocks: new Map(),
    };

    const opts: ReconcileActiveTasksOptions = {
      cancelledSignaled: new Set(),
      isCancelled: async () => false,
      fetchStatus: async () => "completed",
      intervalMs: 30_000,
      abortGraceMs: 10_000,
      now: () => 25_000,
    };

    await reconcileActiveTasks(state, "lead", opts);

    expect(task.result).not.toBeNull();
    expect(task.result?.cost).toEqual(snapshotCost);
  });
});
