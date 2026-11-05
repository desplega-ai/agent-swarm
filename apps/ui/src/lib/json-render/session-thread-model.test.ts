import { describe, expect, test } from "bun:test";
import type { AgentTask } from "@/api/types";
import {
  appActionMessage,
  isDispatchSettled,
  runDispatchChain,
  runResetChain,
  SESSION_THREAD_MAX_REQUEST_CHARS,
  threadRequestText,
} from "./session-thread-model";

function task(overrides: Partial<AgentTask> = {}): AgentTask {
  return {
    id: "task-1",
    task: "do something",
    status: "in_progress",
    source: "api",
    tags: [],
    priority: 50,
    dependsOn: [],
    createdAt: "2026-10-13T00:00:00.000Z",
    lastUpdatedAt: "2026-10-13T00:00:00.000Z",
    ...overrides,
  } as AgentTask;
}

describe("runDispatchChain", () => {
  test("no-op when onDispatch is empty", async () => {
    const calls: unknown[] = [];
    const result = await runDispatchChain({
      onDispatch: [],
      onRootCreated: undefined,
      message: "hi",
      wasEmpty: true,
      leafTaskId: null,
      execute: async (binding) => {
        calls.push(binding);
      },
      getSnapshot: () => ({}),
    });
    expect(result).toEqual({ newTaskId: undefined });
    expect(calls).toEqual([]);
  });

  test("first-ever dispatch (wasEmpty) fires onRootCreated with the new task id", async () => {
    const state: Record<string, unknown> = {};
    const executed: Array<{ action: string; params?: Record<string, unknown> }> = [];
    const result = await runDispatchChain({
      onDispatch: [
        {
          action: "app.action",
          params: { name: "generateScreen", input: {}, parentTaskId: { $chain: "leafTaskId" } },
        },
      ],
      onRootCreated: [
        {
          action: "app.mutate",
          params: {
            model: "screen",
            op: "update",
            values: { rootTaskId: { $chain: "newTaskId" } },
          },
        },
      ],
      message: "add a button",
      wasEmpty: true,
      leafTaskId: null,
      execute: async (binding) => {
        executed.push(binding);
        if (binding.action === "app.action") {
          state.actions = { generateScreen: { status: "running", taskId: "new-task-99" } };
        }
      },
      getSnapshot: () => state,
    });

    expect(result).toEqual({ newTaskId: "new-task-99" });
    expect(executed).toHaveLength(2);
    // No leaf yet: the chain scope publishes `leafTaskId: null`, so the
    // `$chain: "leafTaskId"` param is dropped and the task starts as a root.
    expect(executed[0]).toEqual({
      action: "app.action",
      params: { name: "generateScreen", input: {}, followUp: false },
    });
    expect(Object.hasOwn(executed[0].params ?? {}, "parentTaskId")).toBe(false);
    expect(executed[1]).toEqual({
      action: "app.mutate",
      params: { model: "screen", op: "update", values: { rootTaskId: "new-task-99" } },
    });
  });

  test("follow-up dispatch (not wasEmpty) carries parentTaskId and never fires onRootCreated", async () => {
    const state: Record<string, unknown> = {};
    const executed: Array<{ action: string; params?: Record<string, unknown> }> = [];
    const result = await runDispatchChain({
      onDispatch: [
        {
          action: "app.action",
          params: { name: "generateScreen", input: {}, parentTaskId: { $chain: "leafTaskId" } },
        },
      ],
      onRootCreated: [
        { action: "app.mutate", params: { model: "screen", op: "update", values: {} } },
      ],
      message: "make it blue",
      wasEmpty: false,
      leafTaskId: "leaf-42",
      execute: async (binding) => {
        executed.push(binding);
        if (binding.action === "app.action") {
          state.actions = { generateScreen: { status: "running", taskId: "new-task-100" } };
        }
      },
      getSnapshot: () => state,
    });

    expect(result).toEqual({ newTaskId: "new-task-100" });
    expect(executed).toHaveLength(1);
    expect(executed[0]).toEqual({
      action: "app.action",
      params: { name: "generateScreen", input: {}, parentTaskId: "leaf-42", followUp: false },
    });
  });

  test("no onRootCreated chain configured -> skipped even on first-ever dispatch", async () => {
    const state: Record<string, unknown> = {};
    const result = await runDispatchChain({
      onDispatch: [{ action: "app.action", params: { name: "generateScreen" } }],
      onRootCreated: undefined,
      message: "hi",
      wasEmpty: true,
      leafTaskId: null,
      execute: async () => {
        state.actions = { generateScreen: { status: "running", taskId: "new-task-1" } };
      },
      getSnapshot: () => state,
    });
    expect(result).toEqual({ newTaskId: "new-task-1" });
  });

  test("a misspelled $chain key stays a sentinel on a new thread (the app.action guard rejects it)", async () => {
    const executed: Array<{ action: string; params?: Record<string, unknown> }> = [];
    await runDispatchChain({
      onDispatch: [
        {
          action: "app.action",
          params: { name: "generateScreen", parentTaskId: { $chain: "leaf" } },
        },
      ],
      onRootCreated: undefined,
      message: "hi",
      wasEmpty: true,
      leafTaskId: null,
      execute: async (binding) => {
        executed.push(binding);
      },
      getSnapshot: () => ({}),
    });
    expect(executed[0]?.params?.parentTaskId).toEqual({ $chain: "leaf" });
  });

  test("a follow-up after the leaf completed chains under the leaf, the root id is not rewritten", async () => {
    const state: Record<string, unknown> = {};
    const executed: Array<{ action: string; params?: Record<string, unknown> }> = [];
    await runDispatchChain({
      onDispatch: [
        { action: "app.action", params: { name: "ask", parentTaskId: { $chain: "leafTaskId" } } },
      ],
      onRootCreated: [
        { action: "app.mutate", params: { values: { rootTaskId: { $chain: "newTaskId" } } } },
      ],
      message: "again",
      wasEmpty: false,
      leafTaskId: "leaf",
      execute: async (binding) => {
        executed.push(binding);
        if (binding.action === "app.action") {
          state.actions = { ask: { status: "running", taskId: "next" } };
        }
      },
      getSnapshot: () => state,
    });
    expect(executed).toEqual([
      { action: "app.action", params: { name: "ask", parentTaskId: "leaf", followUp: false } },
    ]);
  });
});

describe("runDispatchChain follow-up opt-out", () => {
  const run = async (params: Record<string, unknown>) => {
    const executed: Array<{ action: string; params?: Record<string, unknown> }> = [];
    await runDispatchChain({
      onDispatch: [
        { action: "app.action", params },
        { action: "app.mutate", params: { model: "m" } },
      ],
      onRootCreated: undefined,
      message: "hi",
      wasEmpty: true,
      leafTaskId: null,
      execute: async (binding) => {
        executed.push(binding);
      },
      getSnapshot: () => ({}),
    });
    return executed;
  };

  test("an app.action step asks for no Lead follow-up; other steps are untouched", async () => {
    const executed = await run({ name: "ask" });
    expect(executed[0]?.params).toEqual({ name: "ask", followUp: false });
    expect(executed[1]?.params).toEqual({ model: "m" });
  });

  test("a followUp the chain sets explicitly wins", async () => {
    const executed = await run({ name: "ask", followUp: true });
    expect(executed[0]?.params).toEqual({ name: "ask", followUp: true });
  });
});

describe("runDispatchChain failures", () => {
  test("an app.action error slot rejects and skips later steps and onRootCreated", async () => {
    const state: Record<string, unknown> = {};
    const executed: string[] = [];
    const run = runDispatchChain({
      onDispatch: [
        { action: "app.action", params: { name: "ask" } },
        { action: "ui.toast", params: { message: "sent" } },
      ],
      onRootCreated: [{ action: "app.mutate", params: {} }],
      message: "hi",
      wasEmpty: true,
      leafTaskId: null,
      execute: async (binding) => {
        executed.push(binding.action);
        if (binding.action === "app.action") {
          state.actions = { ask: { status: "error", error: "quota exceeded" } };
        }
      },
      getSnapshot: () => state,
    });
    await expect(run).rejects.toThrow("quota exceeded");
    expect(executed).toEqual(["app.action"]);
  });

  test("an error slot of a borrowed app instance is read from /refs", async () => {
    const state: Record<string, unknown> = {};
    const run = runDispatchChain({
      onDispatch: [{ action: "app.action", params: { $app: "other", name: "ask" } }],
      onRootCreated: undefined,
      message: "hi",
      wasEmpty: true,
      leafTaskId: null,
      execute: async () => {
        state.refs = { other: { actions: { ask: { status: "error" } } } };
      },
      getSnapshot: () => state,
    });
    await expect(run).rejects.toThrow("Action ask failed");
  });

  test("a follow-up with no leaf refuses to dispatch (it would start a disconnected root)", async () => {
    const executed: unknown[] = [];
    const run = runDispatchChain({
      onDispatch: [
        { action: "app.action", params: { name: "ask", parentTaskId: { $chain: "leafTaskId" } } },
      ],
      onRootCreated: undefined,
      message: "hi",
      wasEmpty: false,
      leafTaskId: null,
      execute: async (binding) => {
        executed.push(binding);
      },
      getSnapshot: () => ({}),
    });
    await expect(run).rejects.toThrow("latest task is unknown");
    expect(executed).toEqual([]);
  });
});

describe("runResetChain", () => {
  test("no-op when onReset is not configured", async () => {
    const calls: unknown[] = [];
    await runResetChain({
      onReset: undefined,
      execute: async (binding) => {
        calls.push(binding);
      },
      getSnapshot: () => ({}),
    });
    expect(calls).toEqual([]);
  });

  test("no-op for an empty onReset chain", async () => {
    const calls: unknown[] = [];
    await runResetChain({
      onReset: [],
      execute: async (binding) => {
        calls.push(binding);
      },
      getSnapshot: () => ({}),
    });
    expect(calls).toEqual([]);
  });

  test("executes every onReset binding with the state scope resolved", async () => {
    const executed: Array<{ action: string; params?: Record<string, unknown> }> = [];
    await runResetChain({
      onReset: [
        {
          action: "app.mutate",
          params: {
            model: "screen",
            op: "update",
            id: { $state: "/route/params/screenId" },
            values: { rootTaskId: "" },
          },
        },
      ],
      execute: async (binding) => {
        executed.push(binding);
      },
      getSnapshot: () => ({ route: { params: { screenId: "screen-7" } } }),
    });

    expect(executed).toEqual([
      {
        action: "app.mutate",
        params: {
          model: "screen",
          op: "update",
          id: "screen-7",
          values: { rootTaskId: "" },
        },
      },
    ]);
  });
});

describe("isDispatchSettled", () => {
  test("nothing pending is settled", () => {
    expect(isDispatchSettled({ pendingTaskId: null, rootTaskId: "", chain: [] })).toBe(true);
  });

  test("a sent task missing from the chain is not settled", () => {
    expect(
      isDispatchSettled({
        pendingTaskId: "new",
        rootTaskId: "root",
        chain: [task({ id: "root" })],
      }),
    ).toBe(false);
  });

  test("settles once the chain holds the sent task", () => {
    const chain = [task({ id: "root" }), task({ id: "new" })];
    expect(isDispatchSettled({ pendingTaskId: "new", rootTaskId: "root", chain })).toBe(true);
  });

  test("a first send settles once the page binds it as the root", () => {
    expect(isDispatchSettled({ pendingTaskId: "new", rootTaskId: "new", chain: [] })).toBe(true);
  });
});

describe("appActionMessage", () => {
  test("reads the marker when a Caller line follows it (the current template)", () => {
    const prompt = [
      "Edit the screen.",
      "",
      '[App action] app=a1 action=editScreen input={"message":"Make it blue"}',
      'Caller (server-verified): {"kind":"user","userId":"u1"}',
    ].join("\n");
    expect(appActionMessage(task({ task: prompt }))).toBe("Make it blue");
  });

  test("the last marker line wins over one quoted in the configured prompt", () => {
    const prompt = [
      'Example: [App action] app=x action=y input={"message":"quoted"}',
      '[App action] app=x action=y input={"message":"quoted"}',
      "",
      '[App action] app=a1 action=ask input={"message":"real"}',
      "Caller (server-verified): {}",
    ].join("\n");
    expect(appActionMessage(task({ task: prompt }))).toBe("real");
  });

  test("pulls the user's message out of an app-dispatched task's trailing JSON marker", () => {
    const prompt =
      '# Edit a screen doc\n\nYou are an editing agent...\n\n\n[App action] app=663d7831-2d76-4465-930d-72662ed88a52 action=generateScreen input={"screenId":"d8d9e50d-ef22-49b5-a81a-e296477d6be9","message":"Add a card with a title \'Hello\'"}';
    expect(appActionMessage(task({ task: prompt }))).toBe("Add a card with a title 'Hello'");
  });

  test("null when there is no [App action] marker", () => {
    expect(appActionMessage(task({ task: "Just steer this task directly" }))).toBeNull();
  });

  test("null when the trailing JSON has no message field", () => {
    const prompt = '...\n\n[App action] app=a action=b input={"screenId":"s1"}';
    expect(appActionMessage(task({ task: prompt }))).toBeNull();
  });

  test("null when the trailing JSON is malformed", () => {
    const prompt = '...\n\n[App action] app=a action=b input={"message": unquoted}';
    expect(appActionMessage(task({ task: prompt }))).toBeNull();
  });
});

describe("threadRequestText", () => {
  const prompt = (message: string) =>
    `p\n[App action] app=a action=b input=${JSON.stringify({ message })}`;

  test("an api task's app action message is its person text", () => {
    expect(threadRequestText(task({ task: prompt("hello") }))).toBe("hello");
  });

  test("caps the message", () => {
    const message = "y".repeat(SESSION_THREAD_MAX_REQUEST_CHARS * 2);
    const text = threadRequestText(task({ task: prompt(message) }));
    expect(text).toHaveLength(SESSION_THREAD_MAX_REQUEST_CHARS + 1);
    expect(text?.endsWith("…")).toBe(true);
  });

  test("a task of another source, or with no marker, is left to the timeline", () => {
    expect(threadRequestText(task({ source: "mcp", task: prompt("quoted") }))).toBeNull();
    expect(threadRequestText(task({ task: "plain prompt" }))).toBeNull();
  });
});
