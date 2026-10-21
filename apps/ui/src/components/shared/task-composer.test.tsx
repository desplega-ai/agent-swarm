import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
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
mock.module("@/lib/enter-submit", () => require("../../lib/enter-submit"));
mock.module("@/hooks/use-object-url", () => require("../../hooks/use-object-url"));
mock.module("@/components/ui/button", () => require("../ui/button"));
mock.module("@/components/ui/textarea", () => require("../ui/textarea"));
mock.module("@/components/ui/tooltip", () => require("../ui/tooltip"));
mock.module("@/components/sessions/composer-dock", () => require("../sessions/composer-dock"));
mock.module("@/components/sessions/compose-attachment-upload", () =>
  require("../sessions/compose-attachment-upload"),
);

const createdTasks: Array<Record<string, unknown>> = [];
const uploads: Array<{ taskId: string; file: File }> = [];
// Promotions the server committed, and every promotion request sent.
const promoted: string[] = [];
const promoteCalls: string[] = [];
// "reject": every request fails before the server commits it.
// "lose-first-response": the first request commits, then its response is lost.
let promoteMode: "ok" | "reject" | "lose-first-response" = "ok";
let rejectUploads = false;
mock.module("@/api/client", () => ({
  api: {
    createTask: async (input: Record<string, unknown>) => {
      createdTasks.push(input);
      return { id: "follow-up", ...input };
    },
    promoteDraftTask: async (id: string) => {
      promoteCalls.push(id);
      if (promoteMode === "reject") throw new Error("promotion failed");
      if (!promoted.includes(id)) promoted.push(id);
      if (promoteMode === "lose-first-response" && promoteCalls.length === 1) {
        throw new Error("network error");
      }
      return { id };
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
// Steering is its own surface; the stub shows which composer is up and
// renders the extra actions it was handed.
mock.module("@/components/steering/steer-composer", () => ({
  SteerComposer: ({ extraActions }: { extraActions?: React.ReactNode }) => (
    <div data-testid="steer-composer">{extraActions}</div>
  ),
}));

const { createRoot } = await import("react-dom/client");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { TooltipProvider } = await import("../ui/tooltip");
const { TaskComposer } = await import("./task-composer");

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
  const button = container.querySelector('button[aria-label="Send"]') as HTMLButtonElement;
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
  container.querySelector('button[aria-label="Send"]') as HTMLButtonElement;

beforeEach(() => {
  createdTasks.length = 0;
  uploads.length = 0;
  promoted.length = 0;
  promoteCalls.length = 0;
  promoteMode = "ok";
  rejectUploads = false;
});

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
      <TaskComposer
        rootTaskId="root-1"
        targetTask={null}
        canSteer={false}
        placeholder="Continue the session…"
      />,
    );
    expect(container.querySelector('[data-testid="steer-composer"]')).toBeNull();
    const textarea = container.querySelector("textarea") as HTMLTextAreaElement;
    expect(textarea.placeholder).toBe("Continue the session…");

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

  test("a failed upload still promotes the task", async () => {
    rejectUploads = true;
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
    await type(container, "see the screenshot");
    await send(container);
    await waitFor(() => promoted.length === 1);

    expect(uploads).toEqual([]);
    expect(promoted).toEqual(["follow-up"]);
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
    expect(textarea.placeholder).toBe("Follow up on this task…");
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
