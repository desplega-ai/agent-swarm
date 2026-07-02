import { describe, expect, test } from "bun:test";
import { emitTaskStarted, onTaskStarted } from "../be/task-lifecycle-events";
import type { AgentTask } from "../types";

function makeTask(overrides: Partial<AgentTask> = {}): AgentTask {
  return {
    id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    agentId: "11111111-2222-3333-4444-555555555555",
    task: "Test task",
    status: "in_progress",
    source: "github",
    priority: 50,
    tags: [],
    dependsOn: [],
    wasPaused: false,
    createdAt: new Date().toISOString(),
    lastUpdatedAt: new Date().toISOString(),
    ...overrides,
  } as AgentTask;
}

describe("task-lifecycle-events", () => {
  test("emitTaskStarted invokes a registered onTaskStarted handler with the task", () => {
    const received: AgentTask[] = [];
    onTaskStarted((task) => {
      received.push(task);
    });

    const task = makeTask();
    emitTaskStarted(task);

    expect(received).toContain(task);
  });

  test("a throwing handler does not break emit and later handlers still run", () => {
    let laterRan = false;
    onTaskStarted(() => {
      throw new Error("boom");
    });
    onTaskStarted(() => {
      laterRan = true;
    });

    expect(() => emitTaskStarted(makeTask())).not.toThrow();
    expect(laterRan).toBe(true);
  });

  test("a promise-rejecting handler is fire-and-forget and does not throw", () => {
    onTaskStarted(() => Promise.reject(new Error("async boom")));

    expect(() => emitTaskStarted(makeTask())).not.toThrow();
  });
});
