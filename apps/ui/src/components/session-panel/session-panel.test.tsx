import { afterAll, describe, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, useLayoutEffect } from "react";
import type { Root } from "react-dom/client";

// A DOM for the panel; removed after this file so other files keep their
// server-render environment.
GlobalRegistrator.register();
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
// Radix picks a no-op layout effect when it first loads with no document.
mock.module("@radix-ui/react-use-layout-effect", () => ({ useLayoutEffect }));
afterAll(async () => {
  await GlobalRegistrator.unregister();
});

// The test runner cannot resolve ui's `@/` alias. UI primitives, the shared
// composer dock and the new-session hook map to their real files; the API
// client, session hooks and the shared conversation are stubbed so the test
// sees exactly which task the panel creates and which components it renders.
mock.module("@/lib/utils", () => require("../../lib/utils"));
mock.module("@/lib/enter-submit", () => require("../../lib/enter-submit"));
mock.module("@/components/ui/button", () => require("../ui/button"));
mock.module("@/components/ui/input", () => require("../ui/input"));
mock.module("@/components/ui/popover", () => require("../ui/popover"));
mock.module("@/hooks/use-debounced-value", () => require("../../hooks/use-debounced-value"));
mock.module("@/components/ui/textarea", () => require("../ui/textarea"));
mock.module("@/components/ui/tooltip", () => require("../ui/tooltip"));
mock.module("@/components/sessions/composer-dock", () => require("../sessions/composer-dock"));
mock.module("@/components/sessions/use-start-session", () =>
  require("../sessions/use-start-session"),
);

type CreateTaskInput = Record<string, unknown>;
const createdTasks: CreateTaskInput[] = [];
const listCalls: Array<Record<string, unknown>> = [];
let sessions: Array<{ root: Record<string, unknown>; lastActivityAt: string }> = [];
let currentUserId: string | null = "u1";

mock.module("@/api/client", () => ({
  api: {
    createTask: async (input: CreateTaskInput) => {
      createdTasks.push(input);
      return { id: "new-root", ...input };
    },
    promoteDraftTask: async () => ({}),
  },
}));
mock.module("@/api/fs", () => ({ uploadTaskAttachment: async () => ({}) }));
mock.module("@/contexts/current-user-context", () => ({
  useCurrentUser: () => ({ userId: currentUserId }),
}));
mock.module("@/api/hooks/use-sessions", () => ({
  useSessions: (opts: Record<string, unknown>) => {
    listCalls.push(opts);
    return { data: opts.enabled === false ? undefined : sessions, isLoading: false };
  },
  useSession: (id: string | undefined) => ({
    data: id ? { root: { id, task: `session ${id}` }, chain: [] } : undefined,
  }),
}));
mock.module("@/components/sessions/session-conversation", () => ({
  SessionConversation: ({ rootTaskId }: { rootTaskId: string }) => (
    <div data-testid="session-conversation" data-root={rootTaskId} />
  ),
}));
mock.module("@/components/sessions/session-meta", () => ({
  SessionMeta: () => <div data-testid="session-meta" />,
}));

// react-dom must load after the DOM exists, or its input-event plumbing
// never attaches (static imports are hoisted above `register()`).
const { createRoot } = await import("react-dom/client");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { MemoryRouter } = await import("react-router-dom");
const { TooltipProvider } = await import("../ui/tooltip");
const { SessionPanel, NEW_SESSION } = await import("./session-panel");

function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
  };
}

function reset() {
  createdTasks.length = 0;
  listCalls.length = 0;
  sessions = [];
  currentUserId = "u1";
}

function withProviders(ui: React.ReactElement): React.ReactElement {
  const queryClient = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  return (
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <TooltipProvider>{ui}</TooltipProvider>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

async function mount(ui: React.ReactElement): Promise<{ root: Root; container: HTMLElement }> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => root.render(withProviders(ui)));
  await act(async () => {}); // flush the first poll
  return { root, container };
}

async function type(container: HTMLElement, text: string) {
  const textarea = container.querySelector("textarea");
  if (!textarea) throw new Error("no composer");
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
  await act(async () => {
    setter?.call(textarea, text);
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function clickSend(container: HTMLElement) {
  const send = container.querySelector(
    'button[aria-label="Start session"]',
  ) as HTMLButtonElement | null;
  if (!send) throw new Error("no send button");
  await act(async () => send.click());
  await act(async () => {});
}

async function waitFor(check: () => boolean) {
  for (let i = 0; i < 50 && !check(); i++) {
    await act(async () => new Promise((r) => setTimeout(r, 10)));
  }
}

async function openPicker(container: HTMLElement): Promise<HTMLElement> {
  const trigger = container.querySelector(
    'button[aria-label="Sessions for this page"]',
  ) as HTMLButtonElement | null;
  if (!trigger) throw new Error("no picker");
  await act(async () => {
    trigger.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 }));
    trigger.click();
  });
  const list = document.body.querySelector('ul[aria-label="Sessions"]') as HTMLElement | null;
  if (!list) throw new Error("picker did not open");
  return list;
}

describe("SessionPanel", () => {
  test("the picker shows sessions in the API's order, newest first, and searches server-side", async () => {
    reset();
    // The endpoint orders by last activity, newest first; the panel keeps that order.
    sessions = [
      { root: { id: "newest", task: "legend is wrong" }, lastActivityAt: "2026-09-28T12:00:00Z" },
      { root: { id: "middle", task: "axis labels" }, lastActivityAt: "2026-09-27T12:00:00Z" },
      { root: { id: "oldest", task: "colors" }, lastActivityAt: "2026-09-20T12:00:00Z" },
    ];
    const { root, container } = await mount(
      <SessionPanel pageKey="task:ui:workflow:w1" contextLabel="workflow w1" storage={null} />,
    );

    const list = await openPicker(container);
    const ids = [...list.querySelectorAll("li[data-session-id]")].map((li) =>
      li.getAttribute("data-session-id"),
    );
    expect(ids).toEqual(["newest", "middle", "oldest"]);
    expect(list.textContent).toContain("New session");

    const search = document.body.querySelector(
      'input[aria-label="Search sessions"]',
    ) as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    await act(async () => {
      setter?.call(search, "legend");
      search.dispatchEvent(new Event("input", { bubbles: true }));
    });
    // Debounced: the keystroke alone does not refetch.
    expect(listCalls.at(-1)?.q).toBeUndefined();
    await waitFor(() => listCalls.at(-1)?.q === "legend");
    expect(listCalls.at(-1)).toMatchObject({
      q: "legend",
      contextKeyPrefix: "task:ui:workflow:w1:",
    });

    await act(async () => root.unmount());
    container.remove();
  });

  test("lists this page's ui sessions for the viewer", async () => {
    reset();
    sessions = [
      {
        root: { id: "s1", task: "chart is wrong", title: "" },
        lastActivityAt: "2026-09-28 10:00:00",
      },
    ];
    const { root, container } = await mount(
      <SessionPanel pageKey="task:ui:workflow:w1" contextLabel="workflow w1" storage={null} />,
    );
    expect(listCalls.at(-1)).toMatchObject({
      source: ["ui"],
      contextKeyPrefix: "task:ui:workflow:w1:",
      requestedByUserId: "u1",
      enabled: true,
    });
    expect(container.textContent).toContain("workflow w1");
    await act(async () => root.unmount());
    container.remove();
  });

  test("a new session is a source ui root task with no agentId, so the API assigns the Lead", async () => {
    reset();
    const storage = memoryStorage();
    const { root, container } = await mount(
      <SessionPanel
        pageKey="task:ui:workflow:w1"
        contextLabel="workflow w1"
        contextFooter={"---\nPage context (swarm UI)\n- URL: http://x/workflows/w1"}
        storage={storage}
      />,
    );

    await type(container, "add a legend");
    await clickSend(container);
    await waitFor(() => createdTasks.length > 0);

    const created = createdTasks[0];
    // Same create path as the Sessions page's new-session view.
    expect(created?.source).toBe("ui");
    expect(created?.agentId).toBeUndefined();
    expect(created?.parentTaskId).toBeUndefined();
    expect(created?.requestedByUserId).toBe("u1");
    expect(String(created?.contextKey).startsWith("task:ui:workflow:w1:")).toBe(true);
    expect(created?.task).toBe(
      "add a legend\n\n---\nPage context (swarm UI)\n- URL: http://x/workflows/w1",
    );

    // The new session opens in place, in the Sessions page's conversation.
    await waitFor(() => !!container.querySelector('[data-testid="session-conversation"]'));
    expect(
      container.querySelector('[data-testid="session-conversation"]')?.getAttribute("data-root"),
    ).toBe("new-root");
    expect(storage.data.get("session-panel:last:task:ui:workflow:w1")).toBe("new-root");

    await act(async () => root.unmount());
    container.remove();
  });

  test("a remembered session renders the shared conversation and links to its task and Sessions view", async () => {
    reset();
    const storage = memoryStorage({ "session-panel:last:ns:task:ui:workflow:w1": "s1" });
    const { root, container } = await mount(
      <SessionPanel
        pageKey="task:ui:workflow:w1"
        contextLabel="workflow w1"
        storage={storage}
        storageNamespace="ns"
      />,
    );

    expect(
      container.querySelector('[data-testid="session-conversation"]')?.getAttribute("data-root"),
    ).toBe("s1");
    expect(container.querySelector('[data-testid="session-meta"]')).not.toBeNull();
    expect(container.querySelector('a[aria-label="Open root task"]')?.getAttribute("href")).toBe(
      "/tasks/s1",
    );
    expect(container.querySelector('a[aria-label="Open in Sessions"]')?.getAttribute("href")).toBe(
      "/sessions/s1",
    );

    await act(async () => root.unmount());
    container.remove();
  });

  test("a different page key starts from New session", async () => {
    reset();
    const storage = memoryStorage({ "session-panel:last:task:ui:workflow:w1": "s1" });
    const { root, container } = await mount(
      <SessionPanel pageKey="task:ui:agent:a1" contextLabel="agent a1" storage={storage} />,
    );
    expect(listCalls.at(-1)?.contextKeyPrefix).toBe("task:ui:agent:a1:");
    expect(container.querySelector('[data-testid="session-conversation"]')).toBeNull();
    expect(container.textContent).toContain("Ask about this page");
    expect(NEW_SESSION).toBe("__new__");

    await act(async () => root.unmount());
    container.remove();
  });

  test("without a user it lists nothing and cannot send", async () => {
    reset();
    currentUserId = null;
    const { root, container } = await mount(
      <SessionPanel pageKey="task:ui:workflow:w1" contextLabel="workflow w1" storage={null} />,
    );
    expect(listCalls.at(-1)?.enabled).toBe(false);
    expect((container.querySelector("textarea") as HTMLTextAreaElement).disabled).toBe(true);
    await act(async () => root.unmount());
    container.remove();
  });
});
