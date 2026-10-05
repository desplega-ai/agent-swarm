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
mock.module("@/api/client", () => ({
  api: {
    createTask: async (input: Record<string, unknown>) => {
      createdTasks.push(input);
      return { id: "follow-up", ...input };
    },
  },
}));
mock.module("@/api/fs", () => ({
  uploadTaskAttachment: async (input: { taskId: string; file: File }) => {
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

beforeEach(() => {
  createdTasks.length = 0;
  uploads.length = 0;
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
    });
    // Sessions never pins an agent: the server routes the follow-up to the Lead.
    expect(createdTasks[0]).not.toHaveProperty("agentId");
    expect(createdTasks[0]).not.toHaveProperty("routingReason");
    expect(uploads).toEqual([{ taskId: "follow-up", file: screenshot, intent: "user-upload" }]);
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
