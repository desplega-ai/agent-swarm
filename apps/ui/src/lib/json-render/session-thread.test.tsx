import { afterAll, beforeEach, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import type { AgentTask } from "@/api/types";

GlobalRegistrator.register();
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const { createRoot } = await import("react-dom/client");
const { StateProvider, ActionProvider } = await import("@json-render/react");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");

// The session hooks are stubbed: each test sets the viewer's listed roots,
// the chain each root has, and the picked identity.
let roots: AgentTask[] = [];
let chains: Record<string, AgentTask[]> = {};
let currentUserId: string | null = "u1";
const lookups: Record<string, unknown>[] = [];

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
  SESSION_LIST_KEY: ["sessions", "list"],
  useSessions: (options: Record<string, unknown>) => {
    lookups.push(options);
    return { data: options.enabled ? { sessions: roots.map((root) => ({ root })) } : undefined };
  },
  useSession: (rootTaskId: string | undefined) => ({
    data: rootTaskId && chains[rootTaskId] ? { chain: chains[rootTaskId] } : undefined,
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
  useCurrentUser: () => ({ userId: currentUserId }),
}));
mock.module("@/lib/utils", () => require("../../lib/utils"));

const { SessionThreadComponent } = await import("./session-thread");
const { AppScopeProvider } = await import("./app-scope");
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
  roots = [];
  chains = {};
  currentUserId = "u1";
  lookups.length = 0;
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
          <AppScopeProvider value="app-1">
            <StateProvider initialState={{}}>
              <ActionProvider handlers={handlers}>
                <Capture />
                <SessionThreadComponent
                  props={
                    {
                      id: "chat",
                      sessionKey: "item-1",
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
          </AppScopeProvider>
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

const KEY = "task:app:app-1:item-1:user:u1";
const SESSION = { key: "item-1", scope: "user" };

test("the thread looks up the viewer's sessions by the exact app, key and user", async () => {
  const { unmount } = await mount({}, () => ({}));
  expect(lookups.at(-1)).toMatchObject({
    contextKeyPrefix: KEY,
    requestedByUserId: "u1",
    enabled: true,
  });
  await unmount();
});

test("with no identity picked the composer is disabled and nothing is looked up", async () => {
  currentUserId = null;
  const { host, unmount } = await mount({}, () => ({}));
  expect(host.textContent).toContain("Pick an identity to chat");
  expect(host.querySelector("button")?.disabled).toBe(true);
  expect(lookups.at(-1)?.enabled).toBe(false);
  await unmount();
});

test("a first message starts the session: no parentTaskId, the session and no Lead review", async () => {
  const { host, calls, rerender, unmount } = await mount({}, () => ({
    status: "running",
    taskId: "new",
  }));
  await typeMessage(host, "hello");
  await act(async () => startButton(host).click());
  expect(calls).toEqual([
    {
      action: "app.action",
      params: { name: "ask", input: { message: "hello" }, session: SESSION, followUp: false },
    },
  ]);
  expect(textarea(host).value).toBe("");
  // Busy until the lookup lists the new root.
  expect(startButton(host).disabled).toBe(true);
  roots = [task({ id: "new", status: "in_progress", contextKey: KEY })];
  chains = { new: roots };
  await rerender({});
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

test("the viewer's newest session renders the shared conversation with the app's send contract", async () => {
  roots = [
    task({ id: "old", contextKey: KEY, createdAt: "2026-11-05T00:00:00.000Z" }),
    task({ id: "root", contextKey: KEY, createdAt: "2026-11-05T01:00:00.000Z" }),
  ];
  chains = { root: [task({ id: "root", status: "in_progress" })] };
  const { host, unmount } = await mount({ placeholder: "Ask…" }, () => ({}));
  expect(host.querySelector("textarea")).toBeNull();
  expect(conversation).toMatchObject({
    rootTaskId: "root",
    timeline: "turns",
    steerTarget: "any",
    steerSource: "app-page",
    placeholder: "Ask…",
    value: "",
  });
  const prompt = 'Do it.\n[App action] app=a action=ask input={"message":"make it blue"}';
  expect(conversation?.requestText?.(task({ task: prompt }))).toBe("make it blue");
  await act(async () => conversation?.onValueChange?.("typed"));
  expect(conversation?.value).toBe("typed");
  await unmount();
});

test("a follow-up chains the next task under the leaf and stays pending until it shows up", async () => {
  roots = [task({ id: "root", contextKey: KEY })];
  chains = {
    root: [
      task({ id: "root", createdAt: "2026-11-05T00:00:00.000Z" }),
      task({ id: "leaf", createdAt: "2026-11-05T01:00:00.000Z" }),
    ],
  };
  const { calls, rerender, unmount } = await mount({}, () => ({
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
      params: {
        name: "ask",
        input: { message: "again" },
        parentTaskId: "leaf",
        session: SESSION,
        followUp: false,
      },
    },
  ]);
  expect(settled).toBe(false);
  chains = {
    root: [...(chains.root ?? []), task({ id: "next", createdAt: "2026-11-05T02:00:00.000Z" })],
  };
  await rerender({});
  expect(settled).toBe(true);
  await unmount();
});

test("a session root whose chain is still loading shows a disabled loading state", async () => {
  roots = [task({ id: "root", contextKey: KEY })];
  const { host, unmount } = await mount({}, () => ({}));
  expect(conversation).toBeUndefined();
  expect(host.textContent).toContain("Loading the conversation");
  expect((host.querySelector("form button") as HTMLButtonElement).disabled).toBe(true);
  await unmount();
});

test("a session whose loaded chain is empty says so and blocks sending", async () => {
  roots = [task({ id: "gone", contextKey: KEY })];
  chains = { gone: [] };
  const { host, calls, unmount } = await mount({}, () => ({}));
  expect(host.textContent).toContain("Conversation not found");
  expect((host.querySelector("form button") as HTMLButtonElement).disabled).toBe(true);
  expect(calls).toEqual([]);
  await unmount();
});

test("New session hides the current session until a newer root exists", async () => {
  roots = [task({ id: "root", contextKey: KEY, createdAt: "2026-11-05T01:00:00.000Z" })];
  chains = { root: roots };
  const { host, rerender, unmount } = await mount({}, () => ({}));
  expect(conversation?.rootTaskId).toBe("root");
  const fresh = host.querySelector('button[aria-label="New session"]') as HTMLButtonElement;
  await act(async () => fresh.click());
  expect(host.textContent).toContain("No session yet");
  expect(startButton(host)).not.toBeNull();
  roots = [...roots, task({ id: "next", contextKey: KEY, createdAt: "2026-11-05T02:00:00.000Z" })];
  chains = { ...chains, next: [task({ id: "next" })] };
  conversation = undefined;
  await rerender({});
  expect(conversation?.rootTaskId).toBe("next");
  await unmount();
});

test("New session on one key does not hide another key's or viewer's older session", async () => {
  roots = [
    task({ id: "a", contextKey: KEY, createdAt: "2026-11-05T01:00:00.000Z" }),
    task({
      id: "b",
      contextKey: "task:app:app-1:item-2:user:u1",
      createdAt: "2026-11-05T00:30:00.000Z",
    }),
    task({
      id: "c",
      contextKey: "task:app:app-1:item-1:user:u2",
      createdAt: "2026-11-05T00:20:00.000Z",
    }),
  ];
  chains = { a: [roots[0]], b: [roots[1]], c: [roots[2]] };
  const { host, rerender, unmount } = await mount({}, () => ({}));
  expect(conversation?.rootTaskId).toBe("a");
  const fresh = host.querySelector('button[aria-label="New session"]') as HTMLButtonElement;
  await act(async () => fresh.click());
  expect(host.textContent).toContain("No session yet");
  await rerender({ sessionKey: "item-2" });
  expect(conversation?.rootTaskId).toBe("b");
  currentUserId = "u2";
  await rerender({});
  expect(conversation?.rootTaskId).toBe("c");
  // Back on the first key and viewer, its own New session still holds.
  currentUserId = "u1";
  await rerender({});
  expect(host.textContent).toContain("No session yet");
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
  // A phone stacks the fill parent: the thread keeps a usable height there.
  expect(fillBox?.className).toContain("max-md:min-h-[420px]");
  await filled.unmount();
});
