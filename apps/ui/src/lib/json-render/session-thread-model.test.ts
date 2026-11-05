import { describe, expect, test } from "bun:test";
import type { AgentTask } from "@/api/types";
import {
  boundTurnTask,
  extractRequestText,
  isDispatchSettled,
  latestStepText,
  pendingTurnLabel,
  resolveLeafTask,
  resolveSessionThreadRoute,
  runDispatchChain,
  runResetChain,
  SESSION_THREAD_MAX_OUTPUT_CHARS,
  SESSION_THREAD_MAX_REQUEST_CHARS,
  SESSION_THREAD_MAX_TURNS,
  turnRequestText,
  visibleTurns,
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

describe("resolveLeafTask", () => {
  test("returns undefined for an empty chain", () => {
    expect(resolveLeafTask([])).toBeUndefined();
  });

  test("returns the single entry for a one-task chain", () => {
    const only = task({ id: "only" });
    expect(resolveLeafTask([only])).toBe(only);
  });

  test("returns the entry with the latest createdAt", () => {
    const first = task({ id: "first", createdAt: "2026-10-13T00:00:00.000Z" });
    const second = task({ id: "second", createdAt: "2026-10-13T01:00:00.000Z" });
    const third = task({ id: "third", createdAt: "2026-10-13T00:30:00.000Z" });
    expect(resolveLeafTask([first, second, third])).toBe(second);
  });
});

describe("resolveSessionThreadRoute", () => {
  test("no rootTaskId -> dispatchRoute only", () => {
    const route = resolveSessionThreadRoute({
      rootTaskId: "",
      chainLoaded: true,
      leafTask: undefined,
    });
    expect(route).toEqual({
      dispatchRoute: true,
      steerRoute: false,
      chainedDispatchRoute: false,
      chainMissing: false,
    });
  });

  test("rootTaskId set but chain still loading -> no route decided yet", () => {
    const route = resolveSessionThreadRoute({
      rootTaskId: "root-1",
      chainLoaded: false,
      leafTask: undefined,
    });
    expect(route).toEqual({
      dispatchRoute: false,
      steerRoute: false,
      chainedDispatchRoute: false,
      chainMissing: false,
    });
  });

  test("rootTaskId set, non-terminal leaf -> steerRoute", () => {
    const route = resolveSessionThreadRoute({
      rootTaskId: "root-1",
      chainLoaded: true,
      leafTask: task({ status: "in_progress" }),
    });
    expect(route).toEqual({
      dispatchRoute: false,
      steerRoute: true,
      chainedDispatchRoute: false,
      chainMissing: false,
    });
  });

  test("rootTaskId set, indeterminate (paused) leaf -> still steerRoute", () => {
    const route = resolveSessionThreadRoute({
      rootTaskId: "root-1",
      chainLoaded: true,
      leafTask: task({ status: "paused" }),
    });
    expect(route).toEqual({
      dispatchRoute: false,
      steerRoute: true,
      chainedDispatchRoute: false,
      chainMissing: false,
    });
  });

  for (const status of [
    "completed",
    "failed",
    "cancelled",
    "superseded",
    "skipped",
    "draft",
  ] as const) {
    test(`rootTaskId set, terminal leaf (${status}) -> chainedDispatchRoute, never steerRoute`, () => {
      const route = resolveSessionThreadRoute({
        rootTaskId: "root-1",
        chainLoaded: true,
        leafTask: task({ status }),
      });
      expect(route).toEqual({
        dispatchRoute: false,
        steerRoute: false,
        chainedDispatchRoute: true,
        chainMissing: false,
      });
    });
  }

  test("rootTaskId set, chain loaded but empty -> chainMissing, no send route", () => {
    const route = resolveSessionThreadRoute({
      rootTaskId: "root-1",
      chainLoaded: true,
      leafTask: undefined,
    });
    expect(route).toEqual({
      dispatchRoute: false,
      steerRoute: false,
      chainedDispatchRoute: false,
      chainMissing: true,
    });
  });
});

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
      params: { name: "generateScreen", input: {} },
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
      params: { name: "generateScreen", input: {}, parentTaskId: "leaf-42" },
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
    const leaf = resolveLeafTask([
      task({ id: "root", status: "completed", createdAt: "2026-10-13T00:00:00.000Z" }),
      task({ id: "leaf", status: "completed", createdAt: "2026-10-13T01:00:00.000Z" }),
    ]);
    const route = resolveSessionThreadRoute({
      rootTaskId: "root",
      chainLoaded: true,
      leafTask: leaf,
    });
    expect(route.chainedDispatchRoute).toBe(true);
    await runDispatchChain({
      onDispatch: [
        { action: "app.action", params: { name: "ask", parentTaskId: { $chain: "leafTaskId" } } },
      ],
      onRootCreated: [
        { action: "app.mutate", params: { values: { rootTaskId: { $chain: "newTaskId" } } } },
      ],
      message: "again",
      wasEmpty: route.dispatchRoute,
      leafTaskId: leaf?.id ?? null,
      execute: async (binding) => {
        executed.push(binding);
        if (binding.action === "app.action") {
          state.actions = { ask: { status: "running", taskId: "next" } };
        }
      },
      getSnapshot: () => state,
    });
    expect(executed).toEqual([
      { action: "app.action", params: { name: "ask", parentTaskId: "leaf" } },
    ]);
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

describe("pendingTurnLabel", () => {
  test("only in_progress reads Working…", () => {
    expect(pendingTurnLabel("in_progress")).toBe("Working…");
  });

  for (const [status, label] of [
    ["pending", "Queued"],
    ["offered", "Queued"],
    ["unassigned", "Queued"],
    ["backlog", "Queued"],
    ["draft", "Draft"],
    ["paused", "Paused"],
    ["reviewing", "In review"],
  ] as const) {
    test(`${status} reads ${label}`, () => {
      expect(pendingTurnLabel(status)).toBe(label);
    });
  }

  for (const status of ["completed", "failed", "cancelled", "superseded", "skipped"] as const) {
    test(`${status} has an outcome, no label`, () => {
      expect(pendingTurnLabel(status)).toBeNull();
    });
  }
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

describe("latestStepText", () => {
  const summarize = (entry: { text?: string }) => entry.text ?? null;

  test("returns null for an empty log list", () => {
    expect(latestStepText([], summarize)).toBeNull();
  });

  test("returns the latest non-null summary, scanning backwards", () => {
    // A trailing noise entry with no summary must not mask "Reading files".
    const logs = [{ text: "Created" }, { text: "Reading files" }, {}];
    expect(latestStepText(logs, summarize)).toBe("Reading files");
  });

  test("returns null when no entry summarizes", () => {
    expect(latestStepText([{}, {}], summarize)).toBeNull();
  });
});

describe("extractRequestText", () => {
  test("pulls the user's message out of an app-dispatched task's trailing JSON marker", () => {
    const prompt =
      '# Edit a screen doc\n\nYou are an editing agent...\n\n\n[App action] app=663d7831-2d76-4465-930d-72662ed88a52 action=generateScreen input={"screenId":"d8d9e50d-ef22-49b5-a81a-e296477d6be9","message":"Add a card with a title \'Hello\'"}';
    expect(extractRequestText(task({ task: prompt }))).toBe("Add a card with a title 'Hello'");
  });

  test("falls back to the raw task text when there is no [App action] marker", () => {
    expect(extractRequestText(task({ task: "Just steer this task directly" }))).toBe(
      "Just steer this task directly",
    );
  });

  test("falls back to the raw task text when the trailing JSON has no message field", () => {
    const prompt = '...\n\n[App action] app=a action=b input={"screenId":"s1"}';
    expect(extractRequestText(task({ task: prompt }))).toBe(prompt);
  });

  test("falls back to the raw task text when the trailing JSON is malformed", () => {
    const prompt = '...\n\n[App action] app=a action=b input={"message": unquoted}';
    expect(extractRequestText(task({ task: prompt }))).toBe(prompt);
  });
});

describe("turn bounds", () => {
  test("renders every turn of a short chain, oldest first", () => {
    const later = task({ id: "b", createdAt: "2026-10-13T01:00:00.000Z" });
    const earlier = task({ id: "a", createdAt: "2026-10-13T00:00:00.000Z" });
    expect(visibleTurns([later, earlier])).toEqual({ turns: [earlier, later], hidden: 0 });
  });

  test("keeps only the latest SESSION_THREAD_MAX_TURNS turns of a long chain", () => {
    const total = SESSION_THREAD_MAX_TURNS + 25;
    const chain = Array.from({ length: total }, (_, i) =>
      task({ id: `t${i}`, createdAt: new Date(Date.UTC(2026, 9, 13, 0, 0, i)).toISOString() }),
    );
    const { turns, hidden } = visibleTurns(chain.toReversed());
    expect(hidden).toBe(25);
    expect(turns).toHaveLength(SESSION_THREAD_MAX_TURNS);
    expect(turns[0]?.id).toBe("t25");
    expect(turns.at(-1)?.id).toBe(`t${total - 1}`);
  });

  test("caps the request text of a turn", () => {
    const text = turnRequestText(task({ task: "x".repeat(SESSION_THREAD_MAX_REQUEST_CHARS + 50) }));
    expect(text).toHaveLength(SESSION_THREAD_MAX_REQUEST_CHARS + 1);
    expect(text.endsWith("…")).toBe(true);
  });

  test("caps an app-action message extracted from the marker", () => {
    const message = "y".repeat(SESSION_THREAD_MAX_REQUEST_CHARS * 2);
    const prompt = `p\n[App action] app=a action=b input=${JSON.stringify({ message })}`;
    expect(turnRequestText(task({ task: prompt }))).toHaveLength(
      SESSION_THREAD_MAX_REQUEST_CHARS + 1,
    );
  });

  test("caps output and failure reason, keeping identity when both fit", () => {
    const small = task({ status: "completed", output: "done" });
    expect(boundTurnTask(small)).toBe(small);
    const big = task({
      status: "failed",
      output: "o".repeat(SESSION_THREAD_MAX_OUTPUT_CHARS + 10),
      failureReason: "f".repeat(SESSION_THREAD_MAX_OUTPUT_CHARS + 10),
    });
    const bounded = boundTurnTask(big);
    expect(bounded.output).toHaveLength(SESSION_THREAD_MAX_OUTPUT_CHARS + 1);
    expect(bounded.failureReason).toHaveLength(SESSION_THREAD_MAX_OUTPUT_CHARS + 1);
    expect(big.output).toHaveLength(SESSION_THREAD_MAX_OUTPUT_CHARS + 10);
  });
});
