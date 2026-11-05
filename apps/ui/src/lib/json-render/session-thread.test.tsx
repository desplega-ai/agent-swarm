import { afterAll, beforeEach, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import type { AgentTask } from "@/api/types";

GlobalRegistrator.register();
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const { createRoot } = await import("react-dom/client");
const { StateProvider, ActionProvider } = await import("@json-render/react");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");

// The session and steer hooks are stubbed: each test sets the chain the
// component sees and records the steers it sends.
let sessionChain: AgentTask[] | undefined;
const steers: Record<string, unknown>[] = [];

mock.module("@/api/hooks/use-feature-gate", () => ({
  useFeatureGate: () => ({ supported: true, requiredVersion: "1.76.0", currentVersion: "9.9.9" }),
}));
mock.module("@/api/hooks/use-sessions", () => ({
  useSession: (rootTaskId: string | undefined) => ({
    data: rootTaskId && sessionChain ? { chain: sessionChain } : undefined,
    isError: false,
  }),
}));
mock.module("@/api/hooks/use-tasks", () => ({
  useTask: () => ({ data: undefined }),
  useSteerTask: () => ({
    isPending: false,
    isError: false,
    error: null,
    reset: () => {},
    mutate: (input: Record<string, unknown>) => steers.push(input),
  }),
}));
mock.module("@/components/sessions/task-detail-sheet", () => ({ TaskDetailSheet: () => null }));
mock.module("@/components/sessions/task-outcome", () => ({
  TaskOutcome: ({ task }: { task: AgentTask }) => <span>{task.output ?? task.status}</span>,
}));
mock.module("@/components/shared/status-badge", () => ({
  StatusBadge: ({ status }: { status: string }) => <span>{status}</span>,
}));
mock.module("@/components/shared/transcript/transcript-rows", () => ({
  summarizeAgentLog: () => null,
}));
mock.module("@/components/steering/steer-composer", () => ({ describeOutcome: () => "sent" }));
mock.module("@/components/ui/button", () => ({
  Button: ({ children, ...rest }: Record<string, unknown> & { children?: React.ReactNode }) => (
    <button {...(rest as object)}>{children}</button>
  ),
}));
mock.module("@/components/ui/card", () => require("../../components/ui/card"));
mock.module("@/components/ui/textarea", () => require("../../components/ui/textarea"));
mock.module("@/contexts/current-user-context", () => ({
  useCurrentUser: () => ({ userId: "u1" }),
}));
mock.module("@/lib/utils", () => require("../../lib/utils"));
mock.module("sonner", () => ({ toast: { success: () => {}, error: () => {} } }));

const { SessionThreadComponent } = await import("./session-thread");
type ThreadProps = Parameters<typeof SessionThreadComponent>[0]["props"];

function task(overrides: Partial<AgentTask>): AgentTask {
  return {
    id: "t",
    task: "do it",
    status: "completed",
    source: "ui",
    tags: [],
    priority: 50,
    dependsOn: [],
    createdAt: "2026-11-05T00:00:00.000Z",
    lastUpdatedAt: "2026-11-05T00:00:00.000Z",
    ...overrides,
  } as AgentTask;
}

beforeEach(() => {
  document.body.innerHTML = "";
  sessionChain = undefined;
  steers.length = 0;
});

afterAll(async () => {
  await GlobalRegistrator.unregister();
});

type Call = Record<string, unknown>;

/**
 * Mounts the thread with an `app.action` handler that mimics `app-surface`:
 * it writes the slot at `/actions/<name>` before resolving. `slot` decides
 * what the handler writes (a created task, or an error).
 */
async function mount(props: Partial<ThreadProps>, slot: (params: Call) => Call) {
  const calls: { action: string; params: Call }[] = [];
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  let store: { set: (path: string, value: unknown) => void } | undefined;
  const queryClient = new QueryClient();
  const handlers = {
    "app.action": async (params: Call) => {
      calls.push({ action: "app.action", params });
      store?.set(`/actions/${String(params.name)}`, slot(params));
    },
    "app.mutate": async (params: Call) => {
      calls.push({ action: "app.mutate", params });
    },
  };
  const { useStateStore } = await import("@json-render/react");
  function Capture() {
    store = useStateStore();
    return null;
  }
  await act(async () =>
    root.render(
      <QueryClientProvider client={queryClient}>
        <StateProvider initialState={{}}>
          <ActionProvider handlers={handlers}>
            <Capture />
            <SessionThreadComponent
              props={
                {
                  id: "chat",
                  onDispatch: [
                    {
                      action: "app.action",
                      params: {
                        name: "ask",
                        input: { $form: "" },
                        parentTaskId: { $chain: "leafTaskId" },
                      },
                    },
                  ],
                  ...props,
                } as ThreadProps
              }
            />
          </ActionProvider>
        </StateProvider>
      </QueryClientProvider>,
    ),
  );
  return { host, calls, unmount: () => act(async () => root.unmount()) };
}

const textarea = (host: HTMLElement) => host.querySelector("textarea") as HTMLTextAreaElement;
const sendButton = (host: HTMLElement) =>
  host.querySelector('button[aria-label="Send message"]') as HTMLButtonElement;

async function typeMessage(host: HTMLElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(
      textarea(host),
      value,
    );
    textarea(host).dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function send(host: HTMLElement) {
  await act(async () => {
    sendButton(host).click();
  });
}

test("a first message dispatches a root task (no parentTaskId) and clears the draft", async () => {
  const { host, calls, unmount } = await mount({}, () => ({ status: "running", taskId: "new" }));
  await typeMessage(host, "hello");
  await send(host);
  expect(calls).toEqual([
    { action: "app.action", params: { name: "ask", input: { message: "hello" } } },
  ]);
  expect(textarea(host).value).toBe("");
  await unmount();
});

test("a failed dispatch keeps the draft and shows the error", async () => {
  const { host, unmount } = await mount({}, () => ({ status: "error", error: "quota exceeded" }));
  await typeMessage(host, "hello");
  await send(host);
  expect(textarea(host).value).toBe("hello");
  expect(host.querySelector('[role="alert"]')?.textContent).toBe("quota exceeded");
  await unmount();
});

test("a running leaf is steered with source app-page", async () => {
  sessionChain = [task({ id: "root", status: "in_progress" })];
  const { host, calls, unmount } = await mount({ rootTaskId: "root" }, () => ({}));
  expect(host.textContent).toContain("Working…");
  await typeMessage(host, "faster");
  await send(host);
  expect(calls).toEqual([]);
  expect(steers).toEqual([
    expect.objectContaining({ id: "root", message: "faster", mode: "queue", source: "app-page" }),
  ]);
  await unmount();
});

test("a finished leaf chains the next task under it", async () => {
  sessionChain = [
    task({ id: "root", createdAt: "2026-11-05T00:00:00.000Z" }),
    task({ id: "leaf", createdAt: "2026-11-05T01:00:00.000Z" }),
  ];
  const { host, calls, unmount } = await mount({ rootTaskId: "root" }, () => ({
    status: "running",
    taskId: "next",
  }));
  await typeMessage(host, "again");
  await send(host);
  expect(calls[0]?.params.parentTaskId).toBe("leaf");
  // The new task is not in the chain yet, so sending stays blocked.
  await typeMessage(host, "and again");
  expect(sendButton(host).disabled).toBe(true);
  expect(host.textContent).toContain("Waiting for the new task to appear");
  await unmount();
});

test("a bound root whose chain is empty blocks sending", async () => {
  sessionChain = [];
  const { host, calls, unmount } = await mount({ rootTaskId: "gone" }, () => ({}));
  await typeMessage(host, "hello");
  expect(sendButton(host).disabled).toBe(true);
  expect(host.textContent).toContain("Conversation not found");
  await send(host);
  expect(calls).toEqual([]);
  await unmount();
});

test("a paused leaf reads Paused, not Working…", async () => {
  sessionChain = [task({ id: "root", status: "paused" })];
  const { host, unmount } = await mount({ rootTaskId: "root" }, () => ({}));
  expect(host.textContent).toContain("Paused");
  expect(host.textContent).not.toContain("Working…");
  await unmount();
});
