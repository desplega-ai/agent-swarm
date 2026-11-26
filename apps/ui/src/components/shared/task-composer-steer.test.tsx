import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, useLayoutEffect } from "react";

// `TaskComposer` with the real `SteerComposer`: a steer with files, and the
// task changing under it while the files upload. task-composer.test.tsx stubs
// the steer box; this file covers who owns its send.
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
mock.module("@/components/shared/transcript/message-text", () => ({
  MessageText: ({ text }: { text: string }) => text,
}));
mock.module("@/components/sessions/pending-follow-ups", () =>
  require("../sessions/pending-follow-ups"),
);

const createdTasks: unknown[] = [];
const steers: Array<Record<string, unknown>> = [];
const uploads: string[] = [];
let rejectUploads = false;
// Set: every upload waits for it, so a test can act while files upload.
let uploadGate: Promise<void> | null = null;
let holdCreates: Promise<void> | null = null;
mock.module("@/api/client", () => ({
  api: {
    createTask: async (input: Record<string, unknown>) => {
      createdTasks.push(input);
      if (holdCreates) await holdCreates;
      return { id: `follow-up-${createdTasks.length}`, ...input };
    },
    promoteDraftTask: async (id: string) => ({ id, status: "pending" }),
  },
}));
mock.module("@/api/fs", () => ({
  uploadTaskAttachment: async ({ taskId, file }: { taskId: string; file: File }) => {
    if (uploadGate) await uploadGate;
    if (rejectUploads) throw new Error("upload failed");
    uploads.push(`${taskId}/${file.name}`);
    return { id: `att-${file.name}`, taskId, name: file.name };
  },
  deleteTaskAttachment: async () => {},
}));
mock.module("@/contexts/current-user-context", () => ({
  useCurrentUser: () => ({ userId: "u1" }),
}));
mock.module("@/components/steering/steer-composer", () => require("../steering/steer-composer"));
mock.module("../steering/steer-mode-toggle", () => ({ SteerModeToggle: () => null }));

const { QueryClient, QueryClientProvider, useMutation } = await import("@tanstack/react-query");
// The steer call as the server sees it; no query cache work.
mock.module("@/api/hooks/use-tasks", () => ({
  useSteerTask: () =>
    useMutation({
      mutationFn: async (input: Record<string, unknown>) => {
        steers.push(input);
        return { outcome: "queued" };
      },
    }),
}));
const { MemoryRouter } = await import("react-router-dom");
const { createRoot } = await import("react-dom/client");
const { TooltipProvider } = await import("../ui/tooltip");
const { TaskComposer } = await import("./task-composer");

const runningTask = {
  id: "run-1",
  status: "in_progress",
  isLeadTask: true,
  supportedSteerModes: ["queue"],
} as never;
const endedTask = { id: "done-1", agentId: "w-7", status: "completed" } as never;
const screenshot = new File([new Uint8Array([1, 2, 3])], "shot.png", { type: "image/png" });

beforeEach(() => {
  createdTasks.length = 0;
  steers.length = 0;
  uploads.length = 0;
  rejectUploads = false;
  uploadGate = null;
  holdCreates = null;
});

/** A promise and the call that settles it. */
function gate() {
  let open = () => {};
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

async function mount(node: React.ReactNode) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const queryClient = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  const render = (next: React.ReactNode) =>
    act(async () =>
      root.render(
        <QueryClientProvider client={queryClient}>
          <MemoryRouter>
            <TooltipProvider>{next}</TooltipProvider>
          </MemoryRouter>
        </QueryClientProvider>,
      ),
    );
  await render(node);
  return {
    container,
    rerender: render,
    unmount: async () => {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

const composer = (task: never, canSteer: boolean, draftKey?: string) => (
  <TaskComposer
    targetTask={task}
    canSteer={canSteer}
    draftKey={draftKey}
    renderActions={(add) => (
      <button type="button" aria-label="Add test file" onClick={() => add(screenshot)} />
    )}
  />
);

const textarea = (container: HTMLElement) =>
  container.querySelector("textarea") as HTMLTextAreaElement;
const sendLabel = (container: HTMLElement) =>
  container.querySelector('button[type="submit"]')?.getAttribute("aria-label");
const fileInBox = (container: HTMLElement) =>
  container.querySelector('button[aria-label="Remove shot.png"]') !== null;

async function type(container: HTMLElement, text: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
  await act(async () => {
    setter?.call(textarea(container), text);
    textarea(container).dispatchEvent(new Event("input", { bubbles: true }));
  });
}

const click = (container: HTMLElement, selector: string) =>
  act(async () => (container.querySelector(selector) as HTMLButtonElement).click());

/** Adds the screenshot, types a message and clicks send. */
async function steerWithScreenshot(container: HTMLElement, text: string) {
  await click(container, 'button[aria-label="Add test file"]');
  await type(container, text);
  expect(sendLabel(container)).toBe("Steer");
  await click(container, 'button[type="submit"]');
}

async function settle() {
  for (let i = 0; i < 20; i++) await act(async () => new Promise((r) => setTimeout(r, 5)));
}

describe("TaskComposer steer with a screenshot", () => {
  test("the task ends mid-upload: the steer box stays locked, no follow-up goes out, success clears it", async () => {
    const upload = gate();
    uploadGate = upload.promise;
    const { container, rerender, unmount } = await mount(composer(runningTask, true));
    await steerWithScreenshot(container, "see the screenshot");

    await rerender(composer(endedTask, false));
    expect(sendLabel(container)).toBe("Steer");
    expect(textarea(container).disabled).toBe(true);
    await click(container, 'button[type="submit"]');
    expect(createdTasks).toEqual([]);

    upload.open();
    await settle();
    expect(steers).toEqual([
      expect.objectContaining({
        id: "run-1",
        message: "see the screenshot",
        attachmentIds: ["att-shot.png"],
      }),
    ]);
    expect(createdTasks).toEqual([]);
    // Settled: the ended task's follow-up dock, empty.
    expect(sendLabel(container)).toBe("Follow up");
    expect(textarea(container).value).toBe("");
    expect(fileInBox(container)).toBe(false);
    await unmount();
  });

  test("a failed upload after the task ended puts the exact text and file back, unlocked", async () => {
    const upload = gate();
    uploadGate = upload.promise;
    rejectUploads = true;
    const { container, rerender, unmount } = await mount(composer(runningTask, true));
    await steerWithScreenshot(container, "exact text");
    await rerender(composer(endedTask, false));

    upload.open();
    await settle();
    expect(steers).toEqual([]);
    expect(createdTasks).toEqual([]);
    expect(sendLabel(container)).toBe("Follow up");
    expect(textarea(container).disabled).toBe(false);
    expect(textarea(container).value).toBe("exact text");
    expect(fileInBox(container)).toBe(true);
    expect(container.textContent).toContain("shot.png failed to upload, so nothing was sent.");
    await unmount();
  });

  test("a box that replaces the steering box on the same draft stays locked until the steer settles", async () => {
    const upload = gate();
    uploadGate = upload.promise;
    const draftKey = "task:steer-swap";
    // The task page: the steer box and the follow-up box are separate composers.
    const page = (ended: boolean) =>
      ended ? (
        <div key="follow-up">{composer(endedTask, false, draftKey)}</div>
      ) : (
        <div key="steer">{composer(runningTask, true, draftKey)}</div>
      );
    const { container, rerender, unmount } = await mount(page(false));
    await steerWithScreenshot(container, "swap me");

    await rerender(page(true));
    expect(textarea(container).disabled).toBe(true);
    await click(container, 'button[type="submit"]');
    expect(createdTasks).toEqual([]);

    upload.open();
    await settle();
    expect(steers).toHaveLength(1);
    expect(textarea(container).disabled).toBe(false);
    // The unmounted steer box's send still cleared the shared draft.
    expect(textarea(container).value).toBe("");
    await unmount();
  });

  test("a follow-up in flight when the task starts keeps the locked dock: no steer goes out", async () => {
    const create = gate();
    holdCreates = create.promise;
    const { container, rerender, unmount } = await mount(composer(endedTask, false));
    await type(container, "one message");
    await click(container, 'button[type="submit"]');
    expect(createdTasks).toHaveLength(1);

    await rerender(composer(runningTask, true));
    expect(sendLabel(container)).toBe("Follow up");
    expect(textarea(container).disabled).toBe(true);

    create.open();
    await settle();
    expect(steers).toEqual([]);
    expect(createdTasks).toHaveLength(1);
    expect(sendLabel(container)).toBe("Steer");
    await unmount();
  });
});
