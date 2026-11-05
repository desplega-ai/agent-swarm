import { afterAll, beforeEach, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import type { AgentTask } from "@/api/types";

GlobalRegistrator.register();
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const { createRoot } = await import("react-dom/client");
const { StateProvider, ActionProvider } = await import("@json-render/react");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");

// The session hook is stubbed: each test sets the chain the component sees.
let sessionChain: AgentTask[] | undefined;

/** The props the thread handed the shared conversation, on its latest render. */
type ConversationProps = {
  rootTaskId: string;
  timeline?: string;
  steerTarget?: string;
  steerSource?: string;
  requestText?: (task: AgentTask) => string | null;
  value?: string;
  onValueChange?: (next: string) => void;
  onFollowUp?: (text: string, parentTaskId: string | undefined) => Promise<void>;
  placeholder?: string;
};
let conversation: ConversationProps | undefined;

mock.module("@/api/hooks/use-feature-gate", () => ({
  useFeatureGate: () => ({ supported: true, requiredVersion: "1.76.0", currentVersion: "9.9.9" }),
}));
mock.module("@/api/hooks/use-sessions", () => ({
  useSession: (rootTaskId: string | undefined) => ({
    data: rootTaskId && sessionChain ? { chain: sessionChain } : undefined,
    isError: false,
  }),
}));
// The shared conversation has its own tests; the stub records what the
// thread hands it and shows the controlled draft.
mock.module("@/components/sessions/session-conversation", () => ({
  SessionConversation: (props: ConversationProps) => {
    conversation = props;
    return <div data-testid="conversation">{props.value}</div>;
  },
}));
mock.module("@/components/sessions/composer-dock", () => ({
  ComposerDock: (props: {
    value: string;
    onChange: (next: string) => void;
    onSubmit: () => void;
    isPending: boolean;
    isError?: boolean;
    errorMessage?: string;
    disabled?: boolean;
    sendLabel?: string;
  }) => (
    <form>
      <textarea value={props.value} onChange={(event) => props.onChange(event.target.value)} />
      <button
        type="button"
        aria-label={props.sendLabel}
        disabled={props.disabled || props.isPending}
        onClick={props.onSubmit}
      />
      {props.isError ? <p data-testid="dock-error">{props.errorMessage}</p> : null}
    </form>
  ),
}));
mock.module("@/components/ui/button", () => ({
  Button: ({ children, ...rest }: Record<string, unknown> & { children?: React.ReactNode }) => (
    <button {...(rest as object)}>{children}</button>
  ),
}));
mock.module("@/contexts/current-user-context", () => ({
  useCurrentUser: () => ({ userId: "u1" }),
}));
mock.module("@/lib/utils", () => require("../../lib/utils"));

const { SessionThreadComponent } = await import("./session-thread");
type ThreadProps = Parameters<typeof SessionThreadComponent>[0]["props"];

function task(overrides: Partial<AgentTask>): AgentTask {
  return {
    id: "t",
    task: "do it",
    status: "completed",
    source: "api",
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
  conversation = undefined;
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
  const render = (next: Partial<ThreadProps>) =>
    act(async () =>
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
                    ...next,
                  } as ThreadProps
                }
              />
            </ActionProvider>
          </StateProvider>
        </QueryClientProvider>,
      ),
    );
  await render(props);
  return {
    host,
    calls,
    rerender: render,
    unmount: () => act(async () => root.unmount()),
  };
}

const textarea = (host: HTMLElement) => host.querySelector("textarea") as HTMLTextAreaElement;
const startButton = (host: HTMLElement) =>
  host.querySelector('button[aria-label="Start session"]') as HTMLButtonElement;

async function typeMessage(host: HTMLElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(
      textarea(host),
      value,
    );
    textarea(host).dispatchEvent(new Event("input", { bubbles: true }));
  });
}

test("a first message dispatches a root task (no parentTaskId) and clears the draft", async () => {
  const { host, calls, unmount } = await mount({}, () => ({ status: "running", taskId: "new" }));
  await typeMessage(host, "hello");
  await act(async () => startButton(host).click());
  expect(calls).toEqual([
    { action: "app.action", params: { name: "ask", input: { message: "hello" }, followUp: false } },
  ]);
  expect(textarea(host).value).toBe("");
  // No onRootCreated: nothing will bind the root, so the send does not wait.
  expect(startButton(host).disabled).toBe(false);
  await unmount();
});

test("a first message with onRootCreated adopts the new task and waits until it is bound", async () => {
  const { host, calls, rerender, unmount } = await mount(
    {
      onRootCreated: [
        { action: "app.mutate", params: { rootTaskId: { $chain: "newTaskId" } } },
      ] as never,
    },
    () => ({ status: "running", taskId: "new" }),
  );
  await typeMessage(host, "hello");
  await act(async () => startButton(host).click());
  expect(calls.map((call) => call.action)).toEqual(["app.action", "app.mutate"]);
  expect(calls[1]?.params).toEqual({ rootTaskId: "new" });
  expect(startButton(host).disabled).toBe(true);
  // The page binds the new root: the shared conversation takes over.
  sessionChain = [task({ id: "new", status: "in_progress" })];
  await rerender({ rootTaskId: "new" });
  expect(conversation?.rootTaskId).toBe("new");
  await unmount();
});

test("a failed dispatch keeps the draft and shows the error", async () => {
  const { host, unmount } = await mount({}, () => ({ status: "error", error: "quota exceeded" }));
  await typeMessage(host, "hello");
  await act(async () => startButton(host).click());
  expect(textarea(host).value).toBe("hello");
  expect(host.querySelector('[data-testid="dock-error"]')?.textContent).toBe("quota exceeded");
  await unmount();
});

test("a bound root renders the shared Sessions v2 conversation with the app's send contract", async () => {
  sessionChain = [task({ id: "root", status: "in_progress" })];
  const { host, unmount } = await mount({ rootTaskId: "root", placeholder: "Ask…" }, () => ({}));
  expect(host.querySelector("textarea")).toBeNull();
  expect(conversation).toMatchObject({
    rootTaskId: "root",
    timeline: "turns",
    steerTarget: "any",
    steerSource: "app-page",
    placeholder: "Ask…",
    value: "",
  });
  // Person bubbles show the app action's message, not the agent prompt.
  const prompt = 'Do it.\n[App action] app=a action=ask input={"message":"make it blue"}';
  expect(conversation?.requestText?.(task({ task: prompt }))).toBe("make it blue");
  // The draft is the page's `/ui/<id>/value`.
  await act(async () => conversation?.onValueChange?.("typed"));
  expect(conversation?.value).toBe("typed");
  expect(host.textContent).toContain("typed");
  await unmount();
});

test("a follow-up chains the next task under the leaf and stays pending until it shows up", async () => {
  sessionChain = [
    task({ id: "root", createdAt: "2026-11-05T00:00:00.000Z" }),
    task({ id: "leaf", createdAt: "2026-11-05T01:00:00.000Z" }),
  ];
  const { calls, rerender, unmount } = await mount({ rootTaskId: "root" }, () => ({
    status: "running",
    taskId: "next",
  }));
  let settled = false;
  await act(async () => {
    void conversation?.onFollowUp?.("again", "leaf").then(() => {
      settled = true;
    });
  });
  expect(calls).toEqual([
    {
      action: "app.action",
      params: { name: "ask", input: { message: "again" }, parentTaskId: "leaf", followUp: false },
    },
  ]);
  // The new task is not in the chain yet, so the send is still pending.
  expect(settled).toBe(false);
  sessionChain = [...sessionChain, task({ id: "next", createdAt: "2026-11-05T02:00:00.000Z" })];
  await rerender({ rootTaskId: "root" });
  expect(settled).toBe(true);
  await unmount();
});

test("a bound root shows a disabled loading state until its chain loads", async () => {
  const { host, unmount } = await mount({ rootTaskId: "root" }, () => ({}));
  expect(conversation).toBeUndefined();
  expect(host.textContent).toContain("Loading the conversation");
  expect(host.querySelector("button")?.disabled).toBe(true);
  await unmount();
});

test("a bound root whose loaded chain is empty says so and blocks sending", async () => {
  sessionChain = [];
  const { host, calls, unmount } = await mount({ rootTaskId: "gone" }, () => ({}));
  expect(conversation).toBeUndefined();
  expect(host.textContent).toContain("Conversation not found");
  expect(host.textContent).not.toContain("No session yet");
  expect(host.querySelector("button")?.disabled).toBe(true);
  expect(calls).toEqual([]);
  await unmount();
});

test("Reset runs the onReset chain", async () => {
  sessionChain = [task({ id: "root" })];
  const { host, calls, unmount } = await mount(
    {
      rootTaskId: "root",
      onReset: [{ action: "app.mutate", params: { rootTaskId: "" } }] as never,
    },
    () => ({}),
  );
  const reset = host.querySelector('button[aria-label="Reset session"]') as HTMLButtonElement;
  await act(async () => reset.click());
  expect(calls).toEqual([{ action: "app.mutate", params: { rootTaskId: "" } }]);
  await unmount();
});

test("the thread has a fixed height, or fills a fill-aware parent", async () => {
  const fixed = await mount({}, () => ({}));
  const box = fixed.host.querySelector('[data-testid="json-render-session-thread"]');
  expect(box?.className).toContain("h-[420px]");
  expect(fixed.host.textContent).toContain("No session yet");
  await fixed.unmount();
  const filled = await mount({ fill: true }, () => ({}));
  const fillBox = filled.host.querySelector('[data-testid="json-render-session-thread"]');
  expect(fillBox?.className).toContain("h-full");
  await filled.unmount();
});
