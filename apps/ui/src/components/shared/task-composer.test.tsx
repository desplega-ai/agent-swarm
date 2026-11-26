import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, useLayoutEffect, useState } from "react";
import type { AgentTask } from "../../api/types";

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
mock.module("@/api/hooks/session-query-keys", () => require("../../api/hooks/session-query-keys"));
mock.module("@/hooks/use-object-url", () => require("../../hooks/use-object-url"));
mock.module("@/components/ui/button", () => require("../ui/button"));
mock.module("@/components/ui/kbd", () => require("../ui/kbd"));
mock.module("@/components/ui/textarea", () => require("../ui/textarea"));
mock.module("@/components/ui/tooltip", () => require("../ui/tooltip"));
mock.module("@/lib/composer-paste", () => require("../../lib/composer-paste"));
mock.module("@/lib/composer-drafts", () => require("../../lib/composer-drafts"));
mock.module("@/lib/composer-citations", () => require("../../lib/composer-citations"));
mock.module("@/components/shared/error-boundary", () => ({
  ErrorBoundary: ({ children }: { children: React.ReactNode }) => children,
}));
// The editor chunk never loads here: the dock's textarea stand-in is the box under test.
mock.module("@/components/sessions/composer-editor", () => ({
  default: () => {
    throw new Promise(() => {});
  },
}));
mock.module("@/components/sessions/composer-dock", () => require("../sessions/composer-dock"));
mock.module("@/components/sessions/compose-attachment-upload", () =>
  require("../sessions/compose-attachment-upload"),
);
mock.module("@/components/sessions/audio-recorder", () => require("../sessions/audio-recorder"));
mock.module("@/lib/uuid", () => require("../../lib/uuid"));
mock.module("@/api/hooks/session-query-keys", () => require("../../api/hooks/session-query-keys"));
mock.module("@/components/shared/transcript/message-text", () => ({
  MessageText: ({ text }: { text: string }) => text,
}));
mock.module("@/components/sessions/pending-follow-ups", () =>
  require("../sessions/pending-follow-ups"),
);

const createdTasks: Array<Record<string, unknown>> = [];
// The second argument of each create (the Sessions follow-up's idempotency key).
const createOpts: Array<{ idempotencyKey?: string } | undefined> = [];
// Creates that fail before the server commits them.
let rejectCreates = 0;
// Held creates wait here until the test settles them (a slow response).
let holdCreates = false;
const heldCreates: Array<{ settle: (error?: Error) => void }> = [];
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
// Set: every upload waits for it, so a test can look while files upload.
let uploadGate: Promise<void> | null = null;
let nextTaskId = 0;
mock.module("@/api/client", () => ({
  api: {
    createTask: async (input: Record<string, unknown>, opts?: { idempotencyKey?: string }) => {
      createdTasks.push(input);
      createOpts.push(opts);
      if (holdCreates) {
        await new Promise<void>((resolve, reject) =>
          heldCreates.push({ settle: (error) => (error ? reject(error) : resolve()) }),
        );
      }
      if (rejectCreates > 0) {
        rejectCreates -= 1;
        throw new Error("network error");
      }
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
    if (uploadGate) await uploadGate;
    if (rejectUploads) throw new Error("upload failed");
    uploads.push(input);
    return {};
  },
  deleteTaskAttachment: async () => {},
}));
// The person using the tab; a test switches it mid-send.
let viewerId = "u1";
mock.module("@/contexts/current-user-context", () => ({
  useCurrentUser: () => ({ userId: viewerId }),
}));
// Steering is its own surface; the stub shows which composer is up, the send
// label, placeholder and route detail it was handed, and renders its extra actions.
mock.module("@/components/steering/steer-composer", () => ({
  SteerComposer: ({
    extraActions,
    sendLabel,
    placeholder,
    routeDetail,
    source,
    attachments,
    onAttachmentsChange,
  }: {
    extraActions?: React.ReactNode;
    sendLabel?: string;
    placeholder?: string;
    routeDetail?: string;
    source?: string;
    attachments?: File[];
    onAttachmentsChange?: (files: File[]) => void;
  }) => (
    <div
      data-testid="steer-composer"
      data-send-label={sendLabel}
      data-placeholder={placeholder}
      data-route-detail={routeDetail}
      data-source={source}
      data-files={onAttachmentsChange ? (attachments ?? []).map((f) => f.name).join(",") : undefined}
    >
      {extraActions}
    </div>
  ),
}));

const { createRoot } = await import("react-dom/client");
const { QueryClient, QueryClientProvider, useQueryClient } = await import("@tanstack/react-query");
const { TooltipProvider } = await import("../ui/tooltip");
const { TaskComposer } = await import("./task-composer");
const { GrantsContext } = await import("../../lib/use-can");
const { sessionDetailKey } = await import("../../api/hooks/session-query-keys");
const { PendingFollowUps, usePendingFollowUps } = await import("../sessions/pending-follow-ups");

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
// A voice clip: only a draft task transcribes it, so it always sends a follow-up.
const clip = new File([new Uint8Array([4, 5, 6])], "clip.webm", { type: "audio/webm" });

async function mount(node: React.ReactNode) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const queryClient = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  const render = (next: React.ReactNode) =>
    act(async () =>
      root.render(
        <QueryClientProvider client={queryClient}>
          <TooltipProvider>{next}</TooltipProvider>
        </QueryClientProvider>,
      ),
    );
  await render(node);
  return {
    container,
    queryClient,
    rerender: render,
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

/** Picks `files` in the dock's hidden file input. */
async function pick(container: HTMLElement, files: File[]) {
  const input = container.querySelector('input[type="file"]') as HTMLInputElement;
  Object.defineProperty(input, "files", { configurable: true, value: files });
  await act(async () => input.dispatchEvent(new Event("change", { bubbles: true })));
}

const sendButton = (container: HTMLElement) =>
  container.querySelector('button[type="submit"]') as HTMLButtonElement;

beforeEach(() => {
  createdTasks.length = 0;
  createOpts.length = 0;
  rejectCreates = 0;
  holdCreates = false;
  heldCreates.length = 0;
  viewerId = "u1";
  uploads.length = 0;
  promoted.length = 0;
  promoteCalls.length = 0;
  promoteMode = "ok";
  cancelled.length = 0;
  cancelCalls.length = 0;
  cancelMode = "ok";
  rejectReads = false;
  rejectUploads = false;
  uploadGate = null;
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
  container.querySelector(
    'button[aria-label="Remove screenshot-x.png"], button[aria-label="Remove clip.webm"]',
  ) !== null;

/** Adds the test file through the extra action, types a message and sends it. */
async function attachAndSend(container: HTMLElement) {
  const add = container.querySelector('button[aria-label="Add test file"]') as HTMLButtonElement;
  await act(async () => add.click());
  await type(container, "see the screenshot");
  await send(container);
}

describe("TaskComposer on Sessions", () => {
  test("a citation can be sent without a comment and clears on success", async () => {
    const clear = mock(() => {});
    const { container, unmount } = await mount(
      <TaskComposer
        targetTask={completedWorkerTask}
        canSteer={false}
        citations={{ quotes: ["First line\n\nSecond line"], remove: () => {}, clear }}
      />,
    );
    await send(container);
    expect(createdTasks[0]?.task).toBe("> First line\n>\n> Second line");
    expect(clear).toHaveBeenCalledTimes(1);
    await unmount();
  });

  test("a voice clip added while steering is up switches to a follow-up task that carries it", async () => {
    const { container, unmount } = await mount(
      <TaskComposer
        rootTaskId="root-1"
        targetTask={runningLeadTask}
        canSteer
        renderActions={(add) => (
          <button type="button" aria-label="Add test file" onClick={() => add(clip)} />
        )}
      />,
    );

    // Running lead task: the steering composer is up, with the extra action.
    expect(container.querySelector('[data-testid="steer-composer"]')).not.toBeNull();
    const add = container.querySelector('button[aria-label="Add test file"]') as HTMLButtonElement;
    await act(async () => add.click());

    // The attachment moves the composer to the follow-up path, with a preview.
    expect(container.querySelector('[data-testid="steer-composer"]')).toBeNull();
    expect(container.querySelector('button[aria-label="Remove clip.webm"]')).not.toBeNull();

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
    expect(uploads).toEqual([{ taskId: "follow-up", file: clip, intent: "user-upload" }]);
    for (let i = 0; i < 50 && promoted.length === 0; i++) {
      await act(async () => new Promise((r) => setTimeout(r, 10)));
    }
    expect(promoted).toEqual(["follow-up"]);
    // Sent: the attachment clears and steering is back for the running task.
    await act(async () => {});
    expect(container.querySelector('[data-testid="steer-composer"]')).not.toBeNull();

    await unmount();
  });

  test("a Sessions follow-up clears the box at once; a failed one keeps its text, Retry resends its key, Edit takes it back", async () => {
    rejectCreates = 2;
    const { PendingFollowUps, usePendingFollowUps } = await import(
      "../sessions/pending-follow-ups"
    );
    function Session() {
      const items = usePendingFollowUps("root-1", []);
      return (
        <>
          <PendingFollowUps rootTaskId="root-1" items={items} draftKey="session:root-1" />
          <TaskComposer
            rootTaskId="root-1"
            targetTask={null}
            canSteer={false}
            draftKey="session:root-1"
          />
        </>
      );
    }
    const { container, unmount } = await mount(<Session />);
    const bubbleText = () =>
      container.querySelector('section[aria-label="Your message"]')?.textContent ?? null;
    const action = (name: string) =>
      [...container.querySelectorAll("button")].find((b) => b.textContent === name);

    await type(container, "ship it");
    await send(container);
    // The box is empty and editable while the send runs or after it fails.
    expect(textOf(container)).toBe("");
    expect((container.querySelector("textarea") as HTMLTextAreaElement).disabled).toBe(false);
    await waitFor(() => action("Retry") !== undefined);
    expect(bubbleText()).toContain("ship it");
    expect(bubbleText()).toContain("Not sent");

    await act(async () => action("Retry")?.click());
    await waitFor(() => createdTasks.length === 2);
    // useMutationState notifies on a later tick: let the retried bubble replace the first.
    await act(async () => new Promise((r) => setTimeout(r, 20)));
    expect(action("Retry")).toBeDefined();
    // One key per bubble: the retry can only ever give back the first task.
    expect(createOpts[0]?.idempotencyKey).toBeString();
    expect(createOpts[1]?.idempotencyKey).toBe(createOpts[0]?.idempotencyKey as string);

    await act(async () => action("Edit")?.click());
    // useMutationState notifies on the next tick.
    await waitFor(() => bubbleText() === null);
    expect(bubbleText()).toBeNull();
    expect(textOf(container)).toBe("ship it");
    await unmount();
  });

  describe("a viewer switch while a follow-up sends", () => {
    let rerender: () => void = () => {};
    // A session view whose chain is the current viewer's cached session detail.
    function ViewerSession() {
      const [, setTick] = useState(0);
      rerender = () => setTick((tick) => tick + 1);
      const chain = useQueryClient().getQueryData<{ chain: AgentTask[] }>(
        sessionDetailKey("root-1", viewerId),
      )?.chain;
      const items = usePendingFollowUps("root-1", chain);
      return (
        <>
          <PendingFollowUps rootTaskId="root-1" items={items} draftKey="session:root-1" />
          <TaskComposer
            rootTaskId="root-1"
            targetTask={null}
            canSteer={false}
            draftKey="session:root-1"
          />
        </>
      );
    }
    async function sendAsAliceThenSwitchToBob() {
      holdCreates = true;
      const mounted = await mount(<ViewerSession />);
      for (const viewer of ["alice", "bob"]) {
        mounted.queryClient.setQueryData(sessionDetailKey("root-1", viewer), { chain: [] });
      }
      viewerId = "alice";
      await act(async () => rerender());
      await type(mounted.container, "alice only");
      await send(mounted.container);
      await waitFor(() => heldCreates.length === 1);
      await waitFor(() => bubbles(mounted.container).length > 0);
      expect(bubbles(mounted.container)).toEqual(["alice only"]);
      viewerId = "bob";
      await act(async () => rerender());
      return mounted;
    }
    const bubbles = (container: HTMLElement) =>
      [...container.querySelectorAll('section[aria-label="Your message"]')].map(
        (bubble) => bubble.querySelector("div")?.textContent ?? "",
      );
    const settle = async (error?: Error) => {
      await act(async () => heldCreates.shift()?.settle(error));
      await act(async () => new Promise((r) => setTimeout(r, 20)));
    };
    const chainIds = (queryClient: InstanceType<typeof QueryClient>, viewer: string) =>
      queryClient
        .getQueryData<{ chain: AgentTask[] }>(sessionDetailKey("root-1", viewer))
        ?.chain.map((task) => task.id);

    test("the created task lands in the sender's session cache, never the new viewer's", async () => {
      const { container, queryClient, unmount } = await sendAsAliceThenSwitchToBob();
      // Bob never sees Alice's sending bubble.
      expect(bubbles(container)).toEqual([]);

      await settle();
      expect(chainIds(queryClient, "alice")).toEqual(["follow-up"]);
      expect(chainIds(queryClient, "bob")).toEqual([]);
      expect(bubbles(container)).toEqual([]);

      // Back to Alice: the chain holds the task, so no bubble is left over.
      viewerId = "alice";
      await act(async () => rerender());
      await act(async () => new Promise((r) => setTimeout(r, 20)));
      expect(bubbles(container)).toEqual([]);
      await unmount();
    });

    test("a send failing after the switch stays the sender's: Retry and Edit show only to them", async () => {
      const { container, queryClient, unmount } = await sendAsAliceThenSwitchToBob();
      await settle(new Error("network error"));
      // Bob gets no "Not sent" bubble, so no Retry or Edit on Alice's text.
      expect(bubbles(container)).toEqual([]);
      expect(container.textContent).not.toContain("Not sent");

      viewerId = "alice";
      await act(async () => rerender());
      await act(async () => new Promise((r) => setTimeout(r, 20)));
      expect(bubbles(container)).toEqual(["alice only"]);
      const retry = [...container.querySelectorAll("button")].find(
        (button) => button.textContent === "Retry",
      );
      await act(async () => retry?.click());
      await waitFor(() => heldCreates.length === 1);
      expect(createOpts[1]?.idempotencyKey).toBe(createOpts[0]?.idempotencyKey as string);
      await settle();
      expect(chainIds(queryClient, "alice")).toEqual(["follow-up"]);
      expect(chainIds(queryClient, "bob")).toEqual([]);
      await unmount();
    });
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

describe("TaskComposer on Sessions, while files upload", () => {
  test("the draft joins the session and the box clears before the uploads finish", async () => {
    let release = () => {};
    uploadGate = new Promise((resolve) => {
      release = resolve;
    });
    const { container, queryClient, unmount } = await mount(
      <TaskComposer
        rootTaskId="root-1"
        targetTask={completedWorkerTask}
        canSteer={false}
        renderActions={(add) => (
          <button type="button" aria-label="Add test file" onClick={() => add(screenshot)} />
        )}
      />,
    );
    const detailKey = ["session", "root-1", "u1"];
    queryClient.setQueryData(detailKey, { root: { id: "root-1" }, chain: [{ id: "root-1" }] });
    await attachAndSend(container);

    // Uploads are still held: the turn shows and the box is empty already.
    const chain = () =>
      (queryClient.getQueryData(detailKey) as { chain: Array<{ id: string; draft?: boolean }> })
        .chain;
    expect(chain().map((task) => task.id)).toEqual(["root-1", "follow-up"]);
    expect(chain()[1]).toMatchObject({ draft: true });
    expect(promoteCalls).toEqual([]);
    expect(textOf(container)).toBe("");
    expect(fileInBox(container)).toBe(false);
    expect(container.textContent).toContain("Creating task…");

    release();
    await waitFor(() => promoted.length === 1);
    expect(promoted).toEqual(["follow-up"]);
    await unmount();
  });

  const steerBox = (container: HTMLElement) =>
    container.querySelector('[data-testid="steer-composer"]') !== null;
  const boxLocked = (container: HTMLElement) =>
    (container.querySelector("textarea") as HTMLTextAreaElement | null)?.disabled === true;

  test("a clip sent to a running lead keeps the locked dock until the upload settles, even when the task ends", async () => {
    let release = () => {};
    uploadGate = new Promise((resolve) => {
      release = resolve;
    });
    const composer = (task: never, canSteer: boolean) => (
      <TaskComposer
        rootTaskId="root-1"
        targetTask={task}
        canSteer={canSteer}
        renderActions={(add) => (
          <button type="button" aria-label="Add test file" onClick={() => add(clip)} />
        )}
      />
    );
    const { container, rerender, unmount } = await mount(composer(runningLeadTask, true));
    await attachAndSend(container);

    // The box is empty, but the send is not done: no steer box to type into.
    expect(promoteCalls).toEqual([]);
    expect(steerBox(container)).toBe(false);
    expect(boxLocked(container)).toBe(true);
    // The task ends and starts again meanwhile: still the locked dock.
    await rerender(composer(completedWorkerTask, false));
    expect(boxLocked(container)).toBe(true);
    await rerender(composer(runningLeadTask, true));
    expect(steerBox(container)).toBe(false);
    expect(boxLocked(container)).toBe(true);

    release();
    await waitFor(() => promoted.length === 1);
    await act(async () => {});
    // Sent: steering is back for the running task.
    expect(steerBox(container)).toBe(true);
    await unmount();
  });

  test("a failed clip send to a running lead puts its text and clip back in the dock", async () => {
    let release = () => {};
    uploadGate = new Promise((resolve) => {
      release = resolve;
    });
    rejectUploads = true;
    const { container, unmount } = await mount(
      <TaskComposer
        rootTaskId="root-1"
        targetTask={runningLeadTask}
        canSteer
        renderActions={(add) => (
          <button type="button" aria-label="Add test file" onClick={() => add(clip)} />
        )}
      />,
    );
    await attachAndSend(container);
    expect(steerBox(container)).toBe(false);
    expect(boxLocked(container)).toBe(true);

    release();
    await waitFor(() => container.textContent?.includes("nothing was sent") ?? false);
    await waitFor(() => !boxLocked(container));
    expect(steerBox(container)).toBe(false);
    expect(textOf(container)).toBe("see the screenshot");
    expect(fileInBox(container)).toBe(true);
    await unmount();
  });

  test("a box that mounts on the same draft mid-send stays locked until the send settles", async () => {
    let release = () => {};
    uploadGate = new Promise((resolve) => {
      release = resolve;
    });
    // The task page: the steer box sends, the task ends, the follow-up box
    // under the outcome replaces it on the same draft.
    const steerSlot = (
      <TaskComposer
        key="steer"
        targetTask={runningLeadTask}
        canSteer
        draftKey="task:b1-swap"
        renderActions={(add) => (
          <button type="button" aria-label="Add test file" onClick={() => add(clip)} />
        )}
      />
    );
    const outcomeSlot = (
      <TaskComposer
        key="outcome"
        targetTask={completedWorkerTask}
        canSteer={false}
        draftKey="task:b1-swap"
      />
    );
    const { container, rerender, unmount } = await mount(steerSlot);
    await attachAndSend(container);
    await rerender(outcomeSlot);
    expect(boxLocked(container)).toBe(true);
    expect(container.textContent).toContain("Uploading files…");

    release();
    await waitFor(() => promoted.length === 1);
    await waitFor(() => !boxLocked(container));
    expect(textOf(container)).toBe("");
    await unmount();
  });

  test("a failed file send keeps the cited passage, quoted in the text, for the retry", async () => {
    rejectUploads = true;
    function Cited() {
      const [quotes, setQuotes] = useState(["quoted passage"]);
      return (
        <TaskComposer
          targetTask={completedWorkerTask}
          canSteer={false}
          citations={{ quotes, remove: () => {}, clear: () => setQuotes([]) }}
          renderActions={(add) => (
            <button type="button" aria-label="Add test file" onClick={() => add(screenshot)} />
          )}
        />
      );
    }
    const { container, unmount } = await mount(<Cited />);
    await attachAndSend(container);
    await waitFor(() => container.textContent?.includes("nothing was sent") ?? false);
    expect(textOf(container)).toContain("> quoted passage");
    expect(fileInBox(container)).toBe(true);
    await unmount();
  });
});

describe("TaskComposer focus across a mode swap", () => {
  const composer = (task: never, canSteer: boolean) => (
    <TaskComposer
      rootTaskId="root-1"
      targetTask={task}
      canSteer={canSteer}
      renderActions={() => <button type="button" aria-label="In the box" />}
    />
  );
  const inTheBox = (container: HTMLElement) =>
    container.querySelector('button[aria-label="In the box"]') as HTMLButtonElement;

  test("a task that ends while the person types in the steer box keeps the focus in the box", async () => {
    const { container, rerender, unmount } = await mount(composer(runningLeadTask, true));
    await act(async () => inTheBox(container).focus());
    expect(container.querySelector('[data-testid="steer-composer"]')).not.toBeNull();

    // The poll brings the lead task back completed: the dock replaces the steer box.
    await rerender(composer(completedWorkerTask, false));
    expect(container.querySelector('[data-testid="steer-composer"]')).toBeNull();
    expect(document.activeElement).toBe(container.querySelector("textarea"));
    await unmount();
  });

  test("a swap does not pull focus into the box when it was elsewhere", async () => {
    const outside = document.createElement("button");
    document.body.appendChild(outside);
    const { rerender, unmount } = await mount(composer(runningLeadTask, true));
    await act(async () => outside.focus());

    await rerender(composer(completedWorkerTask, false));
    expect(document.activeElement).toBe(outside);
    await unmount();
    outside.remove();
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

  test("a voice clip switches a steer box to Follow up, and removing it switches back", async () => {
    const { container, unmount } = await mount(
      <TaskComposer
        targetTask={runningLeadTask}
        canSteer
        renderActions={(add) => (
          <button type="button" aria-label="Add test file" onClick={() => add(clip)} />
        )}
      />,
    );
    expect(sendLabelOf(container)).toBe("Steer");
    const add = container.querySelector('button[aria-label="Add test file"]') as HTMLButtonElement;
    await act(async () => add.click());
    expect(sendLabelOf(container)).toBe("Follow up");
    const remove = container.querySelector(
      'button[aria-label="Remove clip.webm"]',
    ) as HTMLButtonElement;
    await act(async () => remove.click());
    expect(sendLabelOf(container)).toBe("Steer");
    await unmount();
  });

  test("a screenshot stays on the steer box, which takes it with the message", async () => {
    const { container, unmount } = await mount(
      <TaskComposer
        targetTask={runningLeadTask}
        canSteer
        renderActions={(add) => (
          <button type="button" aria-label="Add test file" onClick={() => add(screenshot)} />
        )}
      />,
    );
    const steer = () =>
      container.querySelector('[data-testid="steer-composer"]') as HTMLElement | null;
    expect(steer()?.dataset.files).toBe("");
    const add = container.querySelector('button[aria-label="Add test file"]') as HTMLButtonElement;
    await act(async () => add.click());
    expect(sendLabelOf(container)).toBe("Steer");
    expect(steer()?.dataset.files).toBe("screenshot-x.png");
    expect(createdTasks).toEqual([]);
    await unmount();
  });

  test("an app page's steer box takes no files: a file sends its follow-up", async () => {
    const { container, unmount } = await mount(
      <TaskComposer
        targetTask={runningLeadTask}
        canSteer
        onFollowUp={async () => {}}
        followUpAttachments={{ accept: [".png"], maxBytes: 1024 }}
      />,
    );
    const steer = container.querySelector('[data-testid="steer-composer"]') as HTMLElement;
    expect(steer.dataset.files).toBeUndefined();
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
  test("custom limits: extensions and MIME types, the size cap and the count per message", async () => {
    const { partitionAttachmentFiles } = await import("../sessions/composer-dock");
    const limits = { accept: [".PDF", "image/*"], maxBytes: 20 * 1024 * 1024, maxFiles: 2 };
    const photo = new File([new Uint8Array([1])], "photo.heic", { type: "image/heic" });
    const spec = new File([new Uint8Array([1])], "spec.pdf");
    const notes = new File([new Uint8Array([1])], "notes.md", { type: "text/markdown" });
    expect(partitionAttachmentFiles([photo, spec], limits)).toEqual({
      valid: [photo, spec],
      error: null,
    });
    expect(partitionAttachmentFiles([notes, spec], limits)).toEqual({
      valid: [spec],
      error: '"notes.md" isn\'t an allowed file type (.PDF, image/*).',
    });
    const big = new File([new Uint8Array(20 * 1024 * 1024 + 1)], "flow.pdf");
    expect(partitionAttachmentFiles([big], limits).error).toBe(
      '"flow.pdf" exceeds the 20 MB attachment limit.',
    );
    expect(partitionAttachmentFiles([photo, spec], limits, 1)).toEqual({
      valid: [photo],
      error: "Attach up to 2 files per message.",
    });
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
    expect(createdTasks[0]).toMatchObject({ task: "typed instead", source: "ui" });
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

describe("TaskComposer with a caller follow-up (an app page)", () => {
  test("a follow-up goes to the caller, not POST /api/tasks, and clears the draft", async () => {
    const sent: Array<[string, string | undefined]> = [];
    const { container, unmount } = await mount(
      <TaskComposer
        rootTaskId="root-1"
        targetTask={completedWorkerTask}
        canSteer={false}
        onFollowUp={async (text, parentTaskId) => {
          sent.push([text, parentTaskId]);
        }}
      />,
    );
    await type(container, "next step");
    await act(async () => sendButton(container).click());
    await waitFor(() => sent.length > 0);
    await act(async () => {});
    expect(sent).toEqual([["next step", "done-1"]]);
    expect(createdTasks).toEqual([]);
    expect(textOf(container)).toBe("");
    await unmount();
  });

  test("a rejected caller follow-up keeps the draft and shows its message", async () => {
    const { container, unmount } = await mount(
      <TaskComposer
        rootTaskId="root-1"
        targetTask={null}
        canSteer={false}
        onFollowUp={async () => {
          throw new Error("Conversation not found");
        }}
      />,
    );
    await type(container, "hello");
    await act(async () => sendButton(container).click());
    await waitFor(() => container.textContent?.includes("Conversation not found") ?? false);
    expect(container.textContent).toContain("Conversation not found");
    expect(textOf(container)).toBe("hello");
    await unmount();
  });

  test("the caller's text-only send offers no attachments, mic or extra actions", async () => {
    const { container, unmount } = await mount(
      <TaskComposer
        rootTaskId="root-1"
        targetTask={null}
        canSteer={false}
        onFollowUp={async () => {}}
        renderActions={() => <button type="button" aria-label="Add test file" />}
      />,
    );
    expect(container.querySelector('button[aria-label="Attach files"]')).toBeNull();
    expect(container.querySelector('button[aria-label="Add test file"]')).toBeNull();
    expect(container.querySelector('button[aria-label^="Record audio"]')).toBeNull();
    await unmount();
  });

  test("with followUpAttachments the box takes files within its limits and hands them over", async () => {
    const sent: Array<[string, string | undefined, string[]]> = [];
    const { container, unmount } = await mount(
      <TaskComposer
        rootTaskId="root-1"
        targetTask={completedWorkerTask}
        canSteer={false}
        onFollowUp={async (text, parentTaskId, files) => {
          sent.push([text, parentTaskId, files.map((file) => file.name)]);
        }}
        followUpAttachments={{ accept: [".png", ".pdf"], maxBytes: 10, maxFiles: 2 }}
      />,
    );
    expect(container.querySelector('button[aria-label="Attach files"]')).not.toBeNull();
    expect(container.querySelector('input[type="file"]')?.getAttribute("accept")).toBe(".png,.pdf");
    expect(container.querySelector('button[aria-label^="Record audio"]')).toBeNull();
    await pick(container, [new File(["x"], "photo.heic")]);
    expect(container.textContent).toContain(
      '"photo.heic" isn\'t an allowed file type (.png, .pdf).',
    );
    await pick(container, [new File(["x".repeat(11)], "big.pdf")]);
    expect(container.textContent).toContain('"big.pdf" exceeds the 10 B attachment limit.');
    await pick(container, [screenshot, new File(["%PDF"], "flow.pdf"), new File(["x"], "c.png")]);
    expect(container.textContent).toContain("Attach up to 2 files per message.");
    expect(fileInBox(container)).toBe(true);
    await type(container, "use these");
    await act(async () => sendButton(container).click());
    await waitFor(() => sent.length > 0);
    await act(async () => {});
    expect(sent).toEqual([["use these", "done-1", ["screenshot-x.png", "flow.pdf"]]]);
    expect(createdTasks).toEqual([]);
    expect(textOf(container)).toBe("");
    expect(fileInBox(container)).toBe(false);
    await unmount();
  });

  test("a rejected caller follow-up with files keeps the text and every file", async () => {
    const { container, unmount } = await mount(
      <TaskComposer
        rootTaskId="root-1"
        targetTask={completedWorkerTask}
        canSteer={false}
        onFollowUp={async () => {
          throw new Error("flow.pdf failed to upload (403), so nothing was sent.");
        }}
        followUpAttachments={{ accept: [".png"], maxBytes: 100 }}
      />,
    );
    await pick(container, [screenshot]);
    await type(container, "hello");
    await act(async () => sendButton(container).click());
    await waitFor(() => container.textContent?.includes("nothing was sent") ?? false);
    expect(textOf(container)).toBe("hello");
    expect(fileInBox(container)).toBe(true);
    await unmount();
  });

  test("files never steer: a box holding a file stays a follow-up when a task starts", async () => {
    const limits = { accept: [".png"], maxBytes: 100 };
    const { container, rerender, unmount } = await mount(
      <TaskComposer
        targetTask={completedWorkerTask}
        canSteer={false}
        onFollowUp={async () => {}}
        followUpAttachments={limits}
      />,
    );
    await pick(container, [screenshot]);
    await rerender(
      <TaskComposer
        targetTask={runningLeadTask}
        canSteer
        onFollowUp={async () => {}}
        followUpAttachments={limits}
      />,
    );
    expect(container.querySelector('[data-testid="steer-composer"]')).toBeNull();
    expect(sendLabelOf(container)).toBe("Follow up");
    expect(fileInBox(container)).toBe(true);
    await unmount();
  });

  test("steerSource reaches the steer composer; omitted, it stays unset", async () => {
    const withSource = await mount(
      <TaskComposer targetTask={runningLeadTask} canSteer steerSource="app-page" />,
    );
    const steer = withSource.container.querySelector('[data-testid="steer-composer"]');
    expect((steer as HTMLElement).dataset.source).toBe("app-page");
    await withSource.unmount();
    const without = await mount(<TaskComposer targetTask={runningLeadTask} canSteer />);
    const plain = without.container.querySelector('[data-testid="steer-composer"]');
    expect((plain as HTMLElement).dataset.source).toBeUndefined();
    await without.unmount();
  });
});
