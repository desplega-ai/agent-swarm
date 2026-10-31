import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, useLayoutEffect, useState } from "react";

// A DOM for the composer; removed after this file so other files keep their
// server-render environment.
GlobalRegistrator.register();
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
mock.module("@radix-ui/react-use-layout-effect", () => ({ useLayoutEffect }));
afterAll(async () => {
  await GlobalRegistrator.unregister();
});

mock.module("@/lib/utils", () => require("../../lib/utils"));
// The real grants hooks: outside a provider they answer "operator tab", so every control shows.
mock.module("@/lib/use-can", () => require("../../lib/use-can"));
mock.module("@/lib/enter-submit", () => require("../../lib/enter-submit"));
mock.module("@/lib/chat-width", () => require("../../lib/chat-width"));
mock.module("@/lib/task-title", () => require("../../lib/task-title"));
mock.module("@/hooks/use-object-url", () => require("../../hooks/use-object-url"));
mock.module("@/components/ui/button", () => require("../ui/button"));
mock.module("@/components/ui/kbd", () => require("../ui/kbd"));
mock.module("@/components/ui/textarea", () => require("../ui/textarea"));
mock.module("@/components/ui/tooltip", () => require("../ui/tooltip"));
mock.module("@/components/sessions/composer-dock", () => require("../sessions/composer-dock"));
mock.module("@/components/sessions/compose-attachment-upload", () =>
  require("../sessions/compose-attachment-upload"),
);
mock.module("@/components/sessions/audio-recorder", () => require("../sessions/audio-recorder"));

const createdTasks: Array<Record<string, unknown>> = [];
const uploads: Array<{ taskId: string; file: File }> = [];
// Promotions the server committed, and every promotion request sent.
const promoted: string[] = [];
const promoteCalls: string[] = [];
// "reject": every request fails before the server commits it.
// "lose-first-response": the first request commits, then its response is lost.
let promoteMode: "ok" | "reject" | "lose-first-response" = "ok";
// Cancels the server committed, and every cancel request sent. Same modes,
// plus "lose-every-response": the first request commits and every response,
// that one and the 400s after it, is lost.
const cancelled: string[] = [];
const cancelCalls: string[] = [];
let cancelMode: "ok" | "reject" | "lose-first-response" | "lose-every-response" = "ok";
// Every status read fails.
let rejectReads = false;
let rejectUploads = false;
let nextTaskId = 0;
mock.module("@/api/client", () => ({
  api: {
    createTask: async (input: Record<string, unknown>) => {
      createdTasks.push(input);
      nextTaskId += 1;
      return { id: nextTaskId === 1 ? "follow-up" : `follow-up-${nextTaskId}`, ...input };
    },
    promoteDraftTask: async (id: string) => {
      promoteCalls.push(id);
      if (promoteMode === "reject") throw new Error("promotion failed");
      // Like the server: a task already out of draft comes back unchanged.
      if (cancelled.includes(id)) return { id, status: "cancelled" };
      if (!promoted.includes(id)) promoted.push(id);
      if (promoteMode === "lose-first-response" && promoteCalls.length === 1) {
        throw new Error("network error");
      }
      return { id, status: "pending" };
    },
    cancelTask: async (id: string) => {
      cancelCalls.push(id);
      if (cancelMode === "reject") throw new Error("cancel failed");
      if (cancelMode === "lose-every-response") {
        if (!cancelled.includes(id)) cancelled.push(id);
        throw new Error("network error");
      }
      // A second cancel on a cancelled task is a 400, like the server.
      if (cancelled.includes(id)) throw new Error("Cannot cancel task with status 'cancelled'");
      cancelled.push(id);
      if (cancelMode === "lose-first-response" && cancelCalls.length === 1) {
        throw new Error("network error");
      }
      return { success: true, task: { id, status: "cancelled" } };
    },
    fetchTask: async (id: string) => {
      if (rejectReads) throw new Error("network error");
      return {
        id,
        status: cancelled.includes(id) ? "cancelled" : promoted.includes(id) ? "pending" : "draft",
      };
    },
  },
}));
mock.module("@/api/fs", () => ({
  uploadTaskAttachment: async (input: { taskId: string; file: File }) => {
    if (rejectUploads) throw new Error("upload failed");
    uploads.push(input);
    return {};
  },
}));
mock.module("@/contexts/current-user-context", () => ({
  useCurrentUser: () => ({ userId: "u1" }),
}));
// Steering is its own surface; the stub shows which composer is up, the send
// label, placeholder and route detail it was handed, and renders its extra actions.
mock.module("@/components/steering/steer-composer", () => ({
  SteerComposer: ({
    extraActions,
    sendLabel,
    placeholder,
    routeDetail,
  }: {
    extraActions?: React.ReactNode;
    sendLabel?: string;
    placeholder?: string;
    routeDetail?: string;
  }) => (
    <div
      data-testid="steer-composer"
      data-send-label={sendLabel}
      data-placeholder={placeholder}
      data-route-detail={routeDetail}
    >
      {extraActions}
    </div>
  ),
}));

const { createRoot } = await import("react-dom/client");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { TooltipProvider } = await import("../ui/tooltip");
const { TaskComposer } = await import("./task-composer");
const { GrantsContext } = await import("../../lib/use-can");

const runningLeadTask = {
  id: "lead-1",
  status: "in_progress",
  isLeadTask: true,
  supportedSteerModes: ["queue"],
} as never;

const completedWorkerTask = {
  id: "done-1",
  agentId: "worker-7",
  status: "completed",
  isLeadTask: false,
} as never;

const screenshot = new File([new Uint8Array([1, 2, 3])], "screenshot-x.png", {
  type: "image/png",
});

async function mount(node: React.ReactNode) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const queryClient = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  await act(async () =>
    root.render(
      <QueryClientProvider client={queryClient}>
        <TooltipProvider>{node}</TooltipProvider>
      </QueryClientProvider>,
    ),
  );
  return {
    container,
    unmount: async () => {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

async function type(container: HTMLElement, text: string) {
  const textarea = container.querySelector("textarea") as HTMLTextAreaElement;
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
  await act(async () => {
    setter?.call(textarea, text);
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function send(container: HTMLElement) {
  const button = container.querySelector('button[type="submit"]') as HTMLButtonElement;
  await act(async () => button.click());
  for (let i = 0; i < 50 && createdTasks.length === 0; i++) {
    await act(async () => new Promise((r) => setTimeout(r, 10)));
  }
  await act(async () => {});
}

/** Waits for `done`, up to 2 s (promotion retries back off for 600 ms). */
async function waitFor(done: () => boolean) {
  for (let i = 0; i < 200 && !done(); i++) {
    await act(async () => new Promise((r) => setTimeout(r, 10)));
  }
}

const sendButton = (container: HTMLElement) =>
  container.querySelector('button[type="submit"]') as HTMLButtonElement;

beforeEach(() => {
  createdTasks.length = 0;
  uploads.length = 0;
  promoted.length = 0;
  promoteCalls.length = 0;
  promoteMode = "ok";
  cancelled.length = 0;
  cancelCalls.length = 0;
  cancelMode = "ok";
  rejectReads = false;
  rejectUploads = false;
  nextTaskId = 0;
});

/** The send button's label: the steer stub's, or the follow-up dock's submit button. */
function sendLabelOf(container: HTMLElement): string | null {
  const steer = container.querySelector('[data-testid="steer-composer"]') as HTMLElement | null;
  if (steer) return steer.dataset.sendLabel ?? null;
  return container.querySelector('button[type="submit"]')?.getAttribute("aria-label") ?? null;
}

/** The placeholder: the steer stub's, or the follow-up dock's textarea. */
function placeholderOf(container: HTMLElement): string | null {
  const steer = container.querySelector('[data-testid="steer-composer"]') as HTMLElement | null;
  if (steer) return steer.dataset.placeholder ?? null;
  return container.querySelector("textarea")?.getAttribute("placeholder") ?? null;
}

/** Focuses `element` and returns the text of the tooltip that opens, if any. */
async function tooltipOnFocus(element: HTMLElement): Promise<string | null> {
  await act(async () => element.focus());
  const text = document.querySelector('[role="tooltip"]')?.textContent ?? null;
  await act(async () => element.blur());
  return text;
}

/**
 * The target named in the routing label's tooltip: the steer stub's, or the
 * follow-up dock's (its routing label takes focus only when it has one).
 */
async function routeDetailOf(container: HTMLElement): Promise<string | null> {
  const steer = container.querySelector('[data-testid="steer-composer"]') as HTMLElement | null;
  if (steer) return steer.dataset.routeDetail ?? null;
  const routeLine = container.querySelector('form div[tabindex="0"]') as HTMLElement | null;
  return routeLine ? tooltipOnFocus(routeLine) : null;
}

const textOf = (container: HTMLElement) =>
  (container.querySelector("textarea") as HTMLTextAreaElement).value;

const fileInBox = (container: HTMLElement) =>
  container.querySelector('button[aria-label="Remove screenshot-x.png"]') !== null;

/** Adds the test file through the extra action, types a message and sends it. */
async function attachAndSend(container: HTMLElement) {
  const add = container.querySelector('button[aria-label="Add test file"]') as HTMLButtonElement;
  await act(async () => add.click());
  await type(container, "see the screenshot");
  await send(container);
}

describe("TaskComposer on Sessions", () => {
  test("a file added while steering is up switches to a follow-up task that carries it", async () => {
    const { container, unmount } = await mount(
      <TaskComposer
        rootTaskId="root-1"
        targetTask={runningLeadTask}
        canSteer
        renderActions={(add) => (
          <button type="button" aria-label="Add test file" onClick={() => add(screenshot)} />
        )}
      />,
    );

    // Running lead task: the steering composer is up, with the extra action.
    expect(container.querySelector('[data-testid="steer-composer"]')).not.toBeNull();
    const add = container.querySelector('button[aria-label="Add test file"]') as HTMLButtonElement;
    await act(async () => add.click());

    // The attachment moves the composer to the follow-up path, with a preview.
    expect(container.querySelector('[data-testid="steer-composer"]')).toBeNull();
    expect(container.querySelector('button[aria-label="Remove screenshot-x.png"]')).not.toBeNull();

    await type(container, "see the screenshot");
    await send(container);
    for (let i = 0; i < 50 && uploads.length === 0; i++) {
      await act(async () => new Promise((r) => setTimeout(r, 10)));
    }

    expect(createdTasks[0]).toMatchObject({
      task: "see the screenshot",
      parentTaskId: "lead-1",
      source: "ui",
      // A draft until its uploads settle, so no worker claims it without them.
      draft: true,
    });
    // Sessions never pins an agent: the server routes the follow-up to the Lead.
    expect(createdTasks[0]).not.toHaveProperty("agentId");
    expect(createdTasks[0]).not.toHaveProperty("routingReason");
    expect(uploads).toEqual([{ taskId: "follow-up", file: screenshot, intent: "user-upload" }]);
    for (let i = 0; i < 50 && promoted.length === 0; i++) {
      await act(async () => new Promise((r) => setTimeout(r, 10)));
    }
    expect(promoted).toEqual(["follow-up"]);
    // Sent: the attachment clears and steering is back for the running task.
    await act(async () => {});
    expect(container.querySelector('[data-testid="steer-composer"]')).not.toBeNull();

    await unmount();
  });

  test("before the chain loads, the follow-up chains off the session root", async () => {
    const { container, unmount } = await mount(
      <TaskComposer rootTaskId="root-1" targetTask={null} canSteer={false} showTarget />,
    );
    expect(container.querySelector('[data-testid="steer-composer"]')).toBeNull();
    const textarea = container.querySelector("textarea") as HTMLTextAreaElement;
    expect(textarea.placeholder).toBe("Follow up…");
    // No target yet, so no tooltip names one.
    expect(await routeDetailOf(container)).toBeNull();

    await type(container, "next step");
    await send(container);

    expect(createdTasks[0]).toMatchObject({ task: "next step", parentTaskId: "root-1" });
    expect(createdTasks[0]).not.toHaveProperty("agentId");
    await unmount();
  });

  test("a promotion response lost after the server committed it is retried, not resent", async () => {
    promoteMode = "lose-first-response";
    const { container, unmount } = await mount(
      <TaskComposer
        rootTaskId="root-1"
        targetTask={null}
        canSteer={false}
        renderActions={(add) => (
          <button type="button" aria-label="Add test file" onClick={() => add(screenshot)} />
        )}
      />,
    );
    const add = container.querySelector('button[aria-label="Add test file"]') as HTMLButtonElement;
    await act(async () => add.click());
    await type(container, "do this once");
    await send(container);
    await waitFor(() => promoteCalls.length === 2);
    await act(async () => {});

    // The retry finds the task promoted; the send counts as done.
    expect(promoted).toEqual(["follow-up"]);
    expect((container.querySelector("textarea") as HTMLTextAreaElement).value).toBe("");
    expect(container.textContent).not.toContain("network error");
    await act(async () => sendButton(container).click());
    expect(createdTasks).toHaveLength(1);
    await unmount();
  });

  test("a failed upload cancels the draft and keeps the text and the file in the box", async () => {
    rejectUploads = true;
    const started: string[] = [];
    const { container, unmount } = await mount(
      <TaskComposer
        targetTask={completedWorkerTask}
        canSteer={false}
        onCreated={(task) => started.push(task.id)}
        renderActions={(add) => (
          <button type="button" aria-label="Add test file" onClick={() => add(screenshot)} />
        )}
      />,
    );
    await attachAndSend(container);
    await waitFor(() => container.textContent?.includes("nothing was sent") ?? false);

    // Nothing is left in draft for the heartbeat sweep to start without the file.
    expect(cancelled).toEqual(["follow-up"]);
    expect(promoteCalls).toEqual([]);
    expect(started).toEqual([]);
    expect(container.textContent).toContain(
      "screenshot-x.png failed to upload, so nothing was sent. Send again to retry.",
    );
    expect(textOf(container)).toBe("see the screenshot");
    expect(fileInBox(container)).toBe(true);
    await unmount();
  });

  test("Send again after a failed upload starts one new task with the file", async () => {
    rejectUploads = true;
    const started: string[] = [];
    const { container, unmount } = await mount(
      <TaskComposer
        targetTask={completedWorkerTask}
        canSteer={false}
        onCreated={(task) => started.push(task.id)}
        renderActions={(add) => (
          <button type="button" aria-label="Add test file" onClick={() => add(screenshot)} />
        )}
      />,
    );
    await attachAndSend(container);
    // The failed send has settled once its error shows. A click before that
    // lands on a pending (disabled) button and does nothing.
    await waitFor(() => (container.textContent ?? "").includes("nothing was sent"));
    expect(cancelled).toHaveLength(1);

    rejectUploads = false;
    await act(async () => sendButton(container).click());
    await waitFor(() => started.length === 1);

    expect(createdTasks).toHaveLength(2);
    expect(createdTasks[1]).toMatchObject({ task: "see the screenshot", draft: true });
    expect(uploads).toEqual([{ taskId: "follow-up-2", file: screenshot, intent: "user-upload" }]);
    // Only the new task runs: the first one stays cancelled.
    expect(promoted).toEqual(["follow-up-2"]);
    expect(cancelled).toEqual(["follow-up"]);
    expect(started).toEqual(["follow-up-2"]);
    expect(textOf(container)).toBe("");
    expect(fileInBox(container)).toBe(false);
    expect(container.textContent).not.toContain("nothing was sent");
    await unmount();
  });

  test("a cancel response lost after the server committed it still counts as withdrawn", async () => {
    rejectUploads = true;
    cancelMode = "lose-first-response";
    const { container, unmount } = await mount(
      <TaskComposer
        targetTask={completedWorkerTask}
        canSteer={false}
        renderActions={(add) => (
          <button type="button" aria-label="Add test file" onClick={() => add(screenshot)} />
        )}
      />,
    );
    await attachAndSend(container);
    await waitFor(() => container.textContent?.includes("nothing was sent") ?? false);

    expect(cancelCalls).toEqual(["follow-up"]);
    expect(cancelled).toEqual(["follow-up"]);
    expect(promoteCalls).toEqual([]);
    expect(textOf(container)).toBe("see the screenshot");
    expect(fileInBox(container)).toBe(true);
    await unmount();
  });

  test("a cancel that commits with every response and read lost is not reported as started", async () => {
    rejectUploads = true;
    cancelMode = "lose-every-response";
    rejectReads = true;
    const started: string[] = [];
    const { container, unmount } = await mount(
      <TaskComposer
        targetTask={completedWorkerTask}
        canSteer={false}
        onCreated={(task) => started.push(task.id)}
        renderActions={(add) => (
          <button type="button" aria-label="Add test file" onClick={() => add(screenshot)} />
        )}
      />,
    );
    await attachAndSend(container);
    await waitFor(() => container.textContent?.includes("nothing was sent") ?? false);

    // Promotion comes back `cancelled`: the send failed, and nothing runs.
    expect(cancelled).toEqual(["follow-up"]);
    expect(promoteCalls).toEqual(["follow-up"]);
    expect(promoted).toEqual([]);
    expect(started).toEqual([]);
    expect(container.textContent).not.toContain("started without");
    expect(textOf(container)).toBe("see the screenshot");
    expect(fileInBox(container)).toBe(true);
    await unmount();
  });

  test("a draft whose cancel and promotion both go unanswered claims neither", async () => {
    rejectUploads = true;
    cancelMode = "reject";
    rejectReads = true;
    promoteMode = "reject";
    const started: string[] = [];
    const { container, unmount } = await mount(
      <TaskComposer
        targetTask={completedWorkerTask}
        canSteer={false}
        onCreated={(task) => started.push(task.id)}
        renderActions={(add) => (
          <button type="button" aria-label="Add test file" onClick={() => add(screenshot)} />
        )}
      />,
    );
    await attachAndSend(container);
    await waitFor(
      () => container.textContent?.includes("could not be withdrawn or checked") ?? false,
    );

    expect(promoteCalls).toHaveLength(3);
    expect(started).toEqual([]);
    expect(container.textContent).toContain(
      "screenshot-x.png failed to upload, and #follow-u could not be withdrawn or checked. Open #follow-u before sending again",
    );
    expect(container.textContent).not.toContain("started without");
    expect(textOf(container)).toBe("see the screenshot");
    expect(fileInBox(container)).toBe(true);
    await unmount();
  });

  test("a draft that cannot be cancelled starts now; its file stays for a new follow-up", async () => {
    rejectUploads = true;
    cancelMode = "reject";
    const started: string[] = [];
    const { container, unmount } = await mount(
      <TaskComposer
        targetTask={completedWorkerTask}
        canSteer={false}
        onCreated={(task) => started.push(task.id)}
        renderActions={(add) => (
          <button type="button" aria-label="Add test file" onClick={() => add(screenshot)} />
        )}
      />,
    );
    await attachAndSend(container);
    await waitFor(() => promoted.length === 1);
    await act(async () => {});

    expect(cancelCalls).toHaveLength(3);
    expect(promoted).toEqual(["follow-up"]);
    // The text is gone, so it cannot run twice; the file waits in the box and
    // the page stays put so it is not dropped.
    expect(textOf(container)).toBe("");
    expect(fileInBox(container)).toBe(true);
    expect(container.textContent).toContain(
      "#follow-u started without screenshot-x.png: it could not be withdrawn.",
    );
    expect(started).toEqual([]);
    await unmount();
  });
});

describe("TaskComposer mode", () => {
  test("a steerable task sends with Steer, and names the target in the routing tooltip with showTarget", async () => {
    const { container, unmount } = await mount(
      <TaskComposer
        rootTaskId="root-1"
        targetTask={{ ...(runningLeadTask as object), task: "Fix the parser" } as never}
        canSteer
        showTarget
      />,
    );
    expect(sendLabelOf(container)).toBe("Steer");
    expect(await routeDetailOf(container)).toBe("Steers #lead-1 Fix the parser…");
    // The steer box keeps its own short placeholder.
    expect(placeholderOf(container)).toBeNull();
    await unmount();
  });

  test("a long target title is cut so the routing tooltip stays short", async () => {
    const title = `Migrate the billing service from the legacy cron runner to the workflow engine.`;
    const { container, unmount } = await mount(
      <TaskComposer
        rootTaskId="root-1"
        targetTask={{ ...(runningLeadTask as object), task: title } as never}
        canSteer
        showTarget
      />,
    );
    expect(await routeDetailOf(container)).toBe(
      "Steers #lead-1 Migrate the billing service from the legacy cron runner to…",
    );
    await unmount();
  });

  test("without showTarget no task is named", async () => {
    const { container, unmount } = await mount(
      <TaskComposer targetTask={runningLeadTask} canSteer />,
    );
    expect(sendLabelOf(container)).toBe("Steer");
    expect(await routeDetailOf(container)).toBeNull();
    expect(placeholderOf(container)).toBeNull();
    await unmount();
  });

  test("an ended task sends with Follow up: an icon button named for it, a short placeholder", async () => {
    const { container, unmount } = await mount(
      <TaskComposer targetTask={completedWorkerTask} canSteer={false} />,
    );
    expect(sendLabelOf(container)).toBe("Follow up");
    // Icon only: the name lives in aria-label and the tooltip.
    expect(sendButton(container).textContent).toBe("");
    expect(placeholderOf(container)).toBe("Follow up…");
    expect(await routeDetailOf(container)).toBeNull();
    await unmount();
  });

  test("on Sessions an ended target is named in the routing tooltip, not the placeholder", async () => {
    const { container, unmount } = await mount(
      <TaskComposer
        rootTaskId="root-1"
        targetTask={{ ...(completedWorkerTask as object), task: "Ship the docs" } as never}
        canSteer={false}
        showTarget
      />,
    );
    expect(placeholderOf(container)).toBe("Follow up…");
    expect(await routeDetailOf(container)).toBe("Follows up #done-1 Ship the docs…");
    await unmount();
  });

  test("the send button's tooltip names the send and its keys, and an empty box blocks it", async () => {
    const { container, unmount } = await mount(
      <TaskComposer targetTask={completedWorkerTask} canSteer={false} />,
    );
    expect(container.textContent).not.toContain("newline");
    const button = sendButton(container);
    // Empty: blocked but focusable, so the tooltip still opens.
    expect(button.disabled).toBe(false);
    expect(button.getAttribute("aria-disabled")).toBe("true");
    expect(await tooltipOnFocus(button)).toBe(
      "Follow up. Enter sends, Shift+Enter adds a new line.",
    );
    await act(async () => button.click());
    expect(createdTasks).toEqual([]);

    await type(container, "one more thing");
    expect(sendButton(container).hasAttribute("aria-disabled")).toBe(false);
    await unmount();
  });

  test("a file switches a steer box to Follow up, and removing it switches back", async () => {
    const { container, unmount } = await mount(
      <TaskComposer
        targetTask={runningLeadTask}
        canSteer
        renderActions={(add) => (
          <button type="button" aria-label="Add test file" onClick={() => add(screenshot)} />
        )}
      />,
    );
    expect(sendLabelOf(container)).toBe("Steer");
    const add = container.querySelector('button[aria-label="Add test file"]') as HTMLButtonElement;
    await act(async () => add.click());
    expect(sendLabelOf(container)).toBe("Follow up");
    const remove = container.querySelector(
      'button[aria-label="Remove screenshot-x.png"]',
    ) as HTMLButtonElement;
    await act(async () => remove.click());
    expect(sendLabelOf(container)).toBe("Steer");
    await unmount();
  });

  test("a harness with no live delivery sends with Follow up in the steer box", async () => {
    const { container, unmount } = await mount(
      <TaskComposer
        targetTask={{ ...(runningLeadTask as object), supportedSteerModes: [] } as never}
        canSteer
      />,
    );
    expect(container.querySelector('[data-testid="steer-composer"]')).not.toBeNull();
    expect(sendLabelOf(container)).toBe("Follow up");
    await unmount();
  });
});

describe("TaskComposer on the task page", () => {
  test("a follow-up goes to the same agent, clears the page draft and reports the new task", async () => {
    const created: Array<{ id: string }> = [];
    const drafts: string[] = [];
    function Page() {
      const [draft, setDraft] = useState("");
      return (
        <TaskComposer
          targetTask={completedWorkerTask}
          canSteer={false}
          followUpAgentId="worker-7"
          value={draft}
          onValueChange={(next) => {
            drafts.push(next);
            setDraft(next);
          }}
          onCreated={(task) => created.push(task)}
          fullWidth
        />
      );
    }
    const { container, unmount } = await mount(<Page />);

    const textarea = container.querySelector("textarea") as HTMLTextAreaElement;
    expect(textarea.placeholder).toBe("Follow up…");
    await type(container, "now ship it");
    await send(container);

    expect(createdTasks[0]).toMatchObject({
      task: "now ship it",
      parentTaskId: "done-1",
      agentId: "worker-7",
      routingReason: "continuity",
      requestedByUserId: "u1",
      source: "ui",
    });
    expect(created.map((task) => task.id)).toEqual(["follow-up"]);
    // The page owns the draft: the composer clears it through `onValueChange`.
    expect(drafts.at(-1)).toBe("");
    expect(textarea.value).toBe("");
    await unmount();
  });

  test("a promotion that keeps failing still counts as one sent task", async () => {
    promoteMode = "reject";
    const created: Array<{ id: string }> = [];
    function Page() {
      const [draft, setDraft] = useState("");
      return (
        <TaskComposer
          targetTask={completedWorkerTask}
          canSteer={false}
          followUpAgentId="worker-7"
          value={draft}
          onValueChange={setDraft}
          onCreated={(task) => created.push(task)}
          renderActions={(add) => (
            <button type="button" aria-label="Add test file" onClick={() => add(screenshot)} />
          )}
        />
      );
    }
    const { container, unmount } = await mount(<Page />);
    const add = container.querySelector('button[aria-label="Add test file"]') as HTMLButtonElement;
    await act(async () => add.click());
    await type(container, "do this once");
    await send(container);
    await waitFor(() => created.length === 1);

    // Every attempt failed, so the heartbeat promotes the draft later. The
    // task exists: the text clears and the page hears about it once.
    expect(promoteCalls).toEqual(["follow-up", "follow-up", "follow-up"]);
    expect(created.map((task) => task.id)).toEqual(["follow-up"]);
    expect((container.querySelector("textarea") as HTMLTextAreaElement).value).toBe("");
    expect(container.textContent).not.toContain("promotion failed");
    await act(async () => sendButton(container).click());
    await act(async () => new Promise((r) => setTimeout(r, 30)));
    expect(createdTasks).toHaveLength(1);
    await unmount();
  });

  test("a steerable task gets the steer box, whatever agent it runs on", async () => {
    const { container, unmount } = await mount(
      <TaskComposer
        targetTask={{ ...(runningLeadTask as object), isLeadTask: false } as never}
        canSteer
        followUpAgentId="worker-7"
      />,
    );
    expect(container.querySelector('[data-testid="steer-composer"]')).not.toBeNull();
    await unmount();
  });
  test("a Viewer gets no composer: no create and no steer verb", async () => {
    const viewer = {
      operatorTab: false,
      pending: false,
      grants: { grantsAll: false, verbs: ["session.presence"], roles: ["viewer"] },
    };
    const { container, unmount } = await mount(
      <GrantsContext.Provider value={viewer}>
        <TaskComposer targetTask={runningLeadTask} canSteer followUpAgentId="worker-7" />
      </GrantsContext.Provider>,
    );
    expect(container.querySelector('[data-testid="steer-composer"]')).toBeNull();
    expect(container.querySelector("textarea")).toBeNull();
    await unmount();
  });
});

describe("composer attachment types", () => {
  test("audio files are accepted, so they reach the draft and get transcribed", async () => {
    const { partitionAttachmentFiles } = await import("../sessions/composer-dock");
    const audio = [
      "note.mp3",
      "memo.m4a",
      "clip.wav",
      "voice.ogg",
      "voice.oga",
      "a.opus",
      "b.flac",
    ];
    const files = audio.map((name) => new File([new Uint8Array([1])], name));
    expect(partitionAttachmentFiles(files)).toEqual({ valid: files, error: null });

    const binary = new File([new Uint8Array([1])], "tool.exe");
    expect(partitionAttachmentFiles([binary]).error).toContain(
      '"tool.exe" isn\'t an allowed file type',
    );
  });
});

// A fake mic: `getUserMedia` hands out a stream whose track stop is counted,
// and the recorder emits one webm chunk on stop, as Chrome does.
let micMode: "ok" | "blocked" = "ok";
let micPermission: PermissionState = "prompt";
let stoppedTracks = 0;
const micRequests: unknown[] = [];

class FakeMediaRecorder {
  static isTypeSupported = (type: string) => type.startsWith("audio/webm");
  state: "inactive" | "recording" = "inactive";
  mimeType: string;
  ondataavailable: ((event: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  constructor(_stream: unknown, options?: { mimeType?: string }) {
    this.mimeType = options?.mimeType ?? "";
  }
  start() {
    this.state = "recording";
  }
  stop() {
    this.state = "inactive";
    this.ondataavailable?.({
      data: new Blob([new Uint8Array([0x1a, 0x45, 0xdf, 0xa3])], { type: this.mimeType }),
    });
    this.onstop?.();
  }
}

function installMic() {
  (globalThis as { MediaRecorder?: unknown }).MediaRecorder = FakeMediaRecorder;
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: {
      getUserMedia: async (constraints: unknown) => {
        micRequests.push(constraints);
        if (micMode === "blocked") throw new DOMException("Permission denied", "NotAllowedError");
        return { getTracks: () => [{ stop: () => stoppedTracks++ }] };
      },
    },
  });
  Object.defineProperty(navigator, "permissions", {
    configurable: true,
    value: {
      query: async () => ({
        state: micPermission,
        addEventListener: () => {},
        removeEventListener: () => {},
      }),
    },
  });
}

function removeMic() {
  delete (globalThis as { MediaRecorder?: unknown }).MediaRecorder;
  Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: undefined });
}

const micButton = (container: HTMLElement) =>
  container.querySelector('button[aria-label^="Record audio"]') as HTMLButtonElement;

describe("composer audio recording", () => {
  beforeEach(() => {
    micMode = "ok";
    micPermission = "prompt";
    stoppedTracks = 0;
    micRequests.length = 0;
    installMic();
  });
  afterEach(() => {
    removeMic();
  });

  test("record then stop attaches a webm clip, which the follow-up uploads to its draft", async () => {
    const { container, unmount } = await mount(
      <TaskComposer rootTaskId="root-1" targetTask={runningLeadTask} canSteer />,
    );
    // The mic button sits in the steer box too.
    expect(container.querySelector('[data-testid="steer-composer"]')).not.toBeNull();
    expect(micButton(container).disabled).toBe(false);

    await act(async () => micButton(container).click());
    expect(micRequests).toEqual([{ audio: true }]);
    const stop = container.querySelector(
      'button[aria-label="Stop recording"]',
    ) as HTMLButtonElement;
    expect(stop.textContent).toContain("0:00");

    await act(async () => stop.click());
    // The mic is released, and the clip moves the composer to the follow-up path.
    expect(stoppedTracks).toBe(1);
    expect(container.querySelector('[data-testid="steer-composer"]')).toBeNull();
    const remove = container.querySelector(
      'button[aria-label^="Remove recording-"]',
    ) as HTMLButtonElement;
    expect(remove.getAttribute("aria-label")).toMatch(/^Remove recording-[\d-]+\.webm$/);

    await type(container, "listen to this");
    await send(container);
    await waitFor(() => promoted.length === 1);

    expect(createdTasks[0]).toMatchObject({ task: "listen to this", draft: true });
    expect(uploads).toHaveLength(1);
    const clip = uploads[0]!.file;
    expect(clip.name).toMatch(/^recording-[\d-]+\.webm$/);
    // No `;codecs=`: the server reads the container from the content type.
    expect(clip.type).toBe("audio/webm");
    expect(clip.size).toBe(4);
    expect(promoted).toEqual(["follow-up"]);
    await unmount();
  });

  test("a refused mic disables the button and the composer still sends", async () => {
    micMode = "blocked";
    const { container, unmount } = await mount(
      <TaskComposer rootTaskId="root-1" targetTask={null} canSteer={false} />,
    );
    await act(async () => micButton(container).click());

    expect(micButton(container).disabled).toBe(true);
    expect(micButton(container).getAttribute("aria-label")).toBe(
      "Record audio (Microphone access is blocked)",
    );
    await type(container, "typed instead");
    await send(container);
    expect(createdTasks[0]).toMatchObject({ task: "typed instead", draft: false });
    await unmount();
  });

  test("a mic blocked before the first click disables the button on mount", async () => {
    micPermission = "denied";
    const { container, unmount } = await mount(
      <TaskComposer rootTaskId="root-1" targetTask={null} canSteer={false} />,
    );
    await act(async () => {});
    expect(micButton(container).disabled).toBe(true);
    expect(micRequests).toEqual([]);
    await unmount();
  });

  test("a browser without MediaRecorder gets a disabled button, nothing else changes", async () => {
    removeMic();
    const { container, unmount } = await mount(
      <TaskComposer rootTaskId="root-1" targetTask={null} canSteer={false} />,
    );
    expect(micButton(container).disabled).toBe(true);
    expect(micButton(container).getAttribute("aria-label")).toBe(
      "Record audio (This browser cannot record audio)",
    );
    await type(container, "still works");
    await send(container);
    expect(createdTasks[0]).toMatchObject({ task: "still works" });
    await unmount();
  });

  test("a recorded webm clip passes the dock's attachment check", async () => {
    const { partitionAttachmentFiles } = await import("../sessions/composer-dock");
    const { recordingFileName } = await import("../sessions/audio-recorder");
    const clips = ["audio/webm", "audio/mp4", "audio/ogg"].map(
      (type) => new File([new Uint8Array([1])], recordingFileName(type), { type }),
    );
    expect(clips.map((clip) => clip.name.split(".").pop())).toEqual(["webm", "m4a", "ogg"]);
    expect(partitionAttachmentFiles(clips)).toEqual({ valid: clips, error: null });
  });
});
