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

// The test runner cannot resolve ui's `@/` alias; the panel only uses UI
// primitives, so each maps to its real file. Markdown rendering is out of scope.
mock.module("@/lib/utils", () => require("../../lib/utils"));
mock.module("@/components/ui/button", () => require("../ui/button"));
mock.module("@/components/ui/select", () => require("../ui/select"));
mock.module("@/components/ui/skeleton", () => require("../ui/skeleton"));
mock.module("@/components/ui/spinner", () => require("../ui/spinner"));
mock.module("@/components/ui/textarea", () => require("../ui/textarea"));
mock.module("streamdown", () => ({
  Streamdown: ({ children }: { children: string }) => <div data-md="">{children}</div>,
}));

// react-dom must load after the DOM exists, or its input-event plumbing
// never attaches (static imports are hoisted above `register()`).
const { createRoot } = await import("react-dom/client");
const { SessionPanel, NEW_SESSION } = await import("./session-panel");
type Client = import("./http-client").SessionPanelClient;
type Detail = import("./model").SessionPanelDetail;

function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
  };
}

function fakeClient(sessions: Record<string, Detail>) {
  const created: Array<{ task: string; contextKey: string; requestedByUserId?: string }> = [];
  const listed: Array<{ contextKeyPrefix: string; requestedByUserId?: string }> = [];
  const followUps: Array<{ task: string; parentTaskId: string }> = [];
  const steered: Array<{ taskId: string; message: string }> = [];
  const client: Client = {
    listSessions: async (q) => {
      listed.push(q);
      return Object.values(sessions).map((d) => ({
        root: d.root,
        lastActivityAt: d.root.createdAt,
        latestStatus: d.root.status,
        chainTaskCount: d.chain.length,
      }));
    },
    getSession: async (id) => {
      const d = sessions[id];
      if (!d) throw new Error("not found");
      return d;
    },
    createSession: async (input) => {
      created.push(input);
      const root = {
        id: "new-root",
        task: input.task,
        status: "pending" as const,
        isLeadTask: true,
        source: "ui",
        createdAt: "2026-09-28 10:10:00",
      };
      sessions[root.id] = { root, chain: [root] };
      return { id: root.id };
    },
    createFollowUp: async (input) => {
      followUps.push(input);
      return { id: "child" };
    },
    steer: async (taskId, input) => {
      steered.push({ taskId, message: input.message });
    },
  };
  return { client, created, listed, followUps, steered };
}

const existing: Detail = (() => {
  const root = {
    id: "s1",
    task: "chart is wrong\n\n---\nPage context (swarm UI)\n- URL: http://x/workflows/w1",
    status: "completed" as const,
    isLeadTask: true,
    source: "ui",
    output: "Fixed the chart.",
    createdAt: "2026-09-28 10:00:00",
  };
  return { root, chain: [root] };
})();

async function mount(ui: React.ReactElement): Promise<{ root: Root; container: HTMLElement }> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => root.render(ui));
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
  const send = container.querySelector('button[aria-label="Send"]') as HTMLButtonElement | null;
  if (!send) throw new Error("no send button");
  await act(async () => send.click());
  await act(async () => {});
}

describe("SessionPanel", () => {
  test("lists only this page's sessions for the viewer and starts a new session with context", async () => {
    const fake = fakeClient({ s1: existing });
    const storage = memoryStorage();
    const { root, container } = await mount(
      <SessionPanel
        client={fake.client}
        pageKey="task:ui:workflow:w1"
        contextLabel="workflow w1"
        contextFooter={"---\nPage context (swarm UI)\n- URL: http://x/workflows/w1"}
        userId="u1"
        storage={storage}
      />,
    );

    expect(fake.listed[0]).toEqual({
      contextKeyPrefix: "task:ui:workflow:w1:",
      requestedByUserId: "u1",
      limit: 20,
    } as never);
    expect(container.textContent).toContain("workflow w1");

    await type(container, "add a legend");
    await clickSend(container);

    const created = fake.created[0];
    expect(created?.requestedByUserId).toBe("u1");
    expect(created?.contextKey.startsWith("task:ui:workflow:w1:")).toBe(true);
    expect(created?.task).toBe(
      "add a legend\n\n---\nPage context (swarm UI)\n- URL: http://x/workflows/w1",
    );
    // The new session is selected in place and remembered for this page.
    expect(storage.data.get("session-panel:last:task:ui:workflow:w1")).toBe("new-root");
    await act(async () => {});
    expect(container.querySelector('[aria-label="Session messages"]')?.textContent).toContain(
      "add a legend",
    );
    // The footer is for the lead, not shown back to the user.
    expect(container.textContent).not.toContain("Page context");

    await act(async () => root.unmount());
    container.remove();
  });

  test("reopens the remembered session and sends follow-ups as child tasks", async () => {
    const fake = fakeClient({ s1: existing });
    const storage = memoryStorage({ "session-panel:last:ns:task:ui:workflow:w1": "s1" });
    const opened: string[] = [];
    const { root, container } = await mount(
      <SessionPanel
        client={fake.client}
        pageKey="task:ui:workflow:w1"
        contextLabel="workflow w1"
        userId="u1"
        storage={storage}
        storageNamespace="ns"
        onOpenSession={(id) => opened.push(id)}
      />,
    );

    const messages = container.querySelector('[aria-label="Session messages"]');
    expect(messages?.textContent).toContain("chart is wrong");
    expect(messages?.textContent).toContain("Fixed the chart.");
    expect(messages?.textContent).not.toContain("Page context");

    await type(container, "thanks, also the axis");
    await clickSend(container);
    expect(fake.followUps).toEqual([
      { task: "thanks, also the axis", parentTaskId: "s1", requestedByUserId: "u1" },
    ] as never);
    expect(fake.steered).toEqual([]);

    await act(async () =>
      (container.querySelector('button[aria-label="Open full view"]') as HTMLButtonElement).click(),
    );
    expect(opened).toEqual(["s1"]);

    await act(async () => root.unmount());
    container.remove();
  });

  test("a different page key starts from New session with its own list", async () => {
    const fake = fakeClient({});
    const storage = memoryStorage({ "session-panel:last:task:ui:workflow:w1": "s1" });
    const { root, container } = await mount(
      <SessionPanel
        client={fake.client}
        pageKey="task:ui:agent:a1"
        contextLabel="agent a1"
        userId="u1"
        storage={storage}
      />,
    );
    expect(fake.listed.at(-1)?.contextKeyPrefix).toBe("task:ui:agent:a1:");
    expect(container.querySelector('[aria-label="Session messages"]')).toBeNull();
    expect(container.textContent).toContain("Ask about this page");
    expect(storage.getItem("session-panel:last:task:ui:agent:a1")).toBeNull();
    expect(NEW_SESSION).toBe("__new__");

    await act(async () => root.unmount());
    container.remove();
  });

  test("without a user it lists nothing and cannot send", async () => {
    const fake = fakeClient({ s1: existing });
    const { root, container } = await mount(
      <SessionPanel
        client={fake.client}
        pageKey="task:ui:workflow:w1"
        contextLabel="workflow w1"
        userId={null}
        storage={null}
      />,
    );
    expect(fake.listed).toEqual([]);
    expect((container.querySelector("textarea") as HTMLTextAreaElement).disabled).toBe(true);
    await act(async () => root.unmount());
    container.remove();
  });
});
