import { describe, expect, test } from "bun:test";
import type { AgentTask } from "@/api/types";
import {
  appActionMessage,
  dispatchAppId,
  isDispatchSettled,
  isValidSessionKey,
  pickSessionRoot,
  runDispatchChain,
  SESSION_THREAD_MAX_REQUEST_CHARS,
  threadContextKey,
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

type Executed = Array<{ action: string; params?: Record<string, unknown> }>;
const SESSION = { key: "item-1", scope: "user" as const };

/** Runs `onDispatch` with an app.action handler that reports `slot`. */
async function dispatchWith(
  onDispatch: Parameters<typeof runDispatchChain>[0]["onDispatch"],
  options: { leafTaskId?: string | null; slot?: Record<string, unknown> } = {},
) {
  const state: Record<string, unknown> = {};
  const executed: Executed = [];
  const result = await runDispatchChain({
    onDispatch,
    message: "make it blue",
    leafTaskId: options.leafTaskId ?? null,
    session: SESSION,
    execute: async (binding) => {
      executed.push(binding);
      if (binding.action === "app.action" && options.slot) {
        state.actions = { [String(binding.params?.name)]: options.slot };
      }
    },
    getSnapshot: () => state,
  });
  return { result, executed };
}

describe("runDispatchChain", () => {
  test("no-op when onDispatch is empty", async () => {
    const { result, executed } = await dispatchWith([]);
    expect(result).toEqual({ newTaskId: undefined });
    expect(executed).toEqual([]);
  });

  test("a first message drops parentTaskId, carries the session and reads the new task id", async () => {
    const { result, executed } = await dispatchWith(
      [
        {
          action: "app.action",
          params: { name: "ask", input: { $form: "" }, parentTaskId: { $chain: "leafTaskId" } },
        },
      ],
      { slot: { status: "running", taskId: "new-1" } },
    );
    expect(result).toEqual({ newTaskId: "new-1" });
    expect(executed).toEqual([
      {
        action: "app.action",
        params: {
          name: "ask",
          input: { message: "make it blue" },
          session: SESSION,
          followUp: false,
        },
      },
    ]);
  });

  test("a follow-up chains under the leaf", async () => {
    const { executed } = await dispatchWith(
      [{ action: "app.action", params: { name: "ask", parentTaskId: { $chain: "leafTaskId" } } }],
      { leafTaskId: "leaf-42" },
    );
    expect(executed[0]?.params).toEqual({
      name: "ask",
      parentTaskId: "leaf-42",
      session: SESSION,
      followUp: false,
    });
  });

  test("the thread's session always wins over one the step names", async () => {
    const { executed } = await dispatchWith([
      { action: "app.action", params: { name: "ask", session: { key: "other" } } },
    ]);
    expect(executed[0]?.params?.session).toEqual(SESSION);
  });

  test("a followUp the step sets explicitly wins; other steps are untouched", async () => {
    const { executed } = await dispatchWith([
      { action: "app.action", params: { name: "ask", followUp: true } },
      { action: "app.mutate", params: { model: "m" } },
    ]);
    expect(executed[0]?.params?.followUp).toBe(true);
    expect(executed[1]?.params).toEqual({ model: "m" });
  });

  test("a misspelled $chain key stays a sentinel (the app.action guard rejects it)", async () => {
    const { executed } = await dispatchWith([
      { action: "app.action", params: { name: "ask", parentTaskId: { $chain: "leaf" } } },
    ]);
    expect(executed[0]?.params?.parentTaskId).toEqual({ $chain: "leaf" });
  });
});

describe("runDispatchChain failures", () => {
  test("an app.action error slot rejects and skips later steps", async () => {
    const state: Record<string, unknown> = {};
    const executed: string[] = [];
    const run = runDispatchChain({
      onDispatch: [
        { action: "app.action", params: { name: "ask" } },
        { action: "ui.toast", params: { message: "sent" } },
      ],
      message: "hi",
      leafTaskId: null,
      session: SESSION,
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
      message: "hi",
      leafTaskId: null,
      session: SESSION,
      execute: async () => {
        state.refs = { other: { actions: { ask: { status: "error" } } } };
      },
      getSnapshot: () => state,
    });
    await expect(run).rejects.toThrow("Action ask failed");
  });
});

describe("session lookup", () => {
  test("the context key matches the server's", () => {
    expect(threadContextKey("app-1", "item-1", "u1")).toBe("task:app:app-1:item-1:user:u1");
  });

  test("session keys are plain tokens", () => {
    expect(isValidSessionKey("item-1_A")).toBe(true);
    for (const bad of ["", "a:b", "a b", "x".repeat(129), 3, undefined]) {
      expect(isValidSessionKey(bad)).toBe(false);
    }
  });

  test("the newest root with exactly this key is the session", () => {
    const key = "task:app:a:k:user:u";
    const roots = [
      { id: "old", createdAt: "2026-11-05T01:00:00Z", contextKey: key },
      { id: "new", createdAt: "2026-11-05T03:00:00Z", contextKey: key },
      { id: "other", createdAt: "2026-11-05T04:00:00Z", contextKey: `${key}x` },
    ];
    expect(pickSessionRoot(roots, key, null)?.id).toBe("new");
    expect(pickSessionRoot([], key, null)).toBeNull();
  });

  test("after New session only roots created later count", () => {
    const key = "task:app:a:k:user:u";
    const roots = [{ id: "old", createdAt: "2026-11-05T01:00:00Z", contextKey: key }];
    expect(pickSessionRoot(roots, key, "2026-11-05T01:00:00Z")).toBeNull();
    const later = [...roots, { id: "fresh", createdAt: "2026-11-05T02:00:00Z", contextKey: key }];
    expect(pickSessionRoot(later, key, "2026-11-05T01:00:00Z")?.id).toBe("fresh");
  });

  test("steps run on the app a borrowed element names, else the page's app", () => {
    expect(
      dispatchAppId([{ action: "app.action", params: { $app: "lib", name: "a" } }], "page"),
    ).toBe("lib");
    expect(dispatchAppId([{ action: "app.action", params: { name: "a" } }], "page")).toBe("page");
    expect(dispatchAppId(undefined, null)).toBeNull();
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

  test("a first send settles once the lookup finds it as the root", () => {
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
