import { afterAll, describe, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, useLayoutEffect } from "react";

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
const { SessionComposer } = await import("./session-composer");

const runningLeadTask = {
  id: "lead-1",
  status: "in_progress",
  isLeadTask: true,
  supportedSteerModes: ["queue"],
} as never;

const screenshot = new File([new Uint8Array([1, 2, 3])], "screenshot-x.png", {
  type: "image/png",
});

describe("SessionComposer extra actions", () => {
  test("a file added while steering is up switches to a follow-up task that carries it", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    const queryClient = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
    await act(async () =>
      root.render(
        <QueryClientProvider client={queryClient}>
          <TooltipProvider>
            <SessionComposer
              rootTaskId="root-1"
              latestLeafTask={runningLeadTask}
              steeringSupported
              renderActions={(add) => (
                <button type="button" aria-label="Add test file" onClick={() => add(screenshot)} />
              )}
            />
          </TooltipProvider>
        </QueryClientProvider>,
      ),
    );

    // Running lead task: the steering composer is up, with the extra action.
    expect(container.querySelector('[data-testid="steer-composer"]')).not.toBeNull();
    const add = container.querySelector('button[aria-label="Add test file"]') as HTMLButtonElement;
    await act(async () => add.click());

    // The attachment moves the composer to the follow-up path, with a preview.
    expect(container.querySelector('[data-testid="steer-composer"]')).toBeNull();
    expect(container.querySelector('button[aria-label="Remove screenshot-x.png"]')).not.toBeNull();

    const textarea = container.querySelector("textarea") as HTMLTextAreaElement;
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
    await act(async () => {
      setter?.call(textarea, "see the screenshot");
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const send = container.querySelector('button[aria-label="Send"]') as HTMLButtonElement;
    await act(async () => send.click());
    for (let i = 0; i < 50 && uploads.length === 0; i++) {
      await act(async () => new Promise((r) => setTimeout(r, 10)));
    }

    expect(createdTasks[0]).toMatchObject({
      task: "see the screenshot",
      parentTaskId: "lead-1",
      source: "ui",
    });
    expect(uploads).toEqual([{ taskId: "follow-up", file: screenshot, intent: "user-upload" }]);
    // Sent: the attachment clears and steering is back for the running task.
    await act(async () => {});
    expect(container.querySelector('[data-testid="steer-composer"]')).not.toBeNull();

    await act(async () => root.unmount());
    container.remove();
  });
});
