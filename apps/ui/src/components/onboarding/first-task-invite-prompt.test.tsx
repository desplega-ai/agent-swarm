import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";

// A DOM: the prompt opens from an effect. Removed after this file.
GlobalRegistrator.register();
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const { createRoot } = await import("react-dom/client");
afterAll(async () => {
  await GlobalRegistrator.unregister();
});

const API_URL = "http://swarm.test";
const USER_ID = "user-1";

type StepStatus = "todo" | "done";
let firstTask: StepStatus = "todo";
let isAdmin = true;
let supported = true;
let userId: string | null = USER_ID;
// Payloads arrive after the prompt mounts, unless a test says otherwise.
let fetchedAt = () => Date.now() + 60_000;

mock.module("@/api/hooks/use-onboarding", () => ({
  useOnboarding: () => ({
    data: { state: { steps: { first_task: { status: firstTask } } } },
    dataUpdatedAt: fetchedAt(),
    isFetchedAfterMount: true,
  }),
}));
mock.module("@/api/hooks/use-invites-support", () => ({ useInvitesSupport: () => supported }));
mock.module("@/lib/use-can", () => ({
  ...require("../../lib/use-can"),
  useIsAdmin: () => isAdmin,
}));
mock.module("@/contexts/current-user-context", () => ({
  useCurrentUser: () => ({ userId }),
}));
mock.module("@/hooks/use-config", () => ({
  useConfig: () => ({ config: { apiUrl: API_URL } }),
}));
// The real modules: a root `bun test` does not resolve the `@/` alias by itself.
mock.module("@/hooks/use-dismissible-card-key", () =>
  require("../../hooks/use-dismissible-card-key"),
);
mock.module("@/hooks/use-other-dialog-open", () => require("../../hooks/use-other-dialog-open"));
// The dialog itself is the People page's: here only whether it opens matters.
mock.module("@/pages/people/invite-dialog", () => ({
  InviteDialog: ({ open, intro }: { open: boolean; intro?: { title: string } }) =>
    open ? <p data-testid="invite">{intro?.title}</p> : null,
}));

const { FirstTaskInvitePrompt, firstTaskInviteKey } = await import("./first-task-invite-prompt");

async function mount() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const render = async () => {
    await act(async () => {
      root.render(<FirstTaskInvitePrompt />);
    });
  };
  await render();
  return {
    rerender: render,
    opened: () => container.querySelector('[data-testid="invite"]') !== null,
    unmount: () => act(() => root.unmount()),
  };
}

beforeEach(() => {
  firstTask = "todo";
  isAdmin = true;
  supported = true;
  userId = USER_ID;
  fetchedAt = () => Date.now() + 60_000;
  localStorage.clear();
  document.body.innerHTML = "";
});

describe("FirstTaskInvitePrompt", () => {
  test("opens once when the first task completes while the tab watches", async () => {
    const view = await mount();
    expect(view.opened()).toBe(false);

    firstTask = "done";
    await view.rerender();
    expect(view.opened()).toBe(true);
    expect(localStorage.getItem(firstTaskInviteKey(API_URL, USER_ID))).toBe("1");
    await view.unmount();

    // A new page load with the same swarm and user: never again.
    firstTask = "todo";
    const again = await mount();
    firstTask = "done";
    await again.rerender();
    expect(again.opened()).toBe(false);
  });

  test("stays closed when the first task was already done before this tab", async () => {
    firstTask = "done";
    const view = await mount();
    await view.rerender();
    expect(view.opened()).toBe(false);
  });

  test("ignores a persisted payload from before the mount", async () => {
    fetchedAt = () => 0;
    const view = await mount();
    firstTask = "done";
    fetchedAt = () => Date.now() + 60_000;
    await view.rerender();
    expect(view.opened()).toBe(false);
  });

  test("stays closed for a user who cannot invite", async () => {
    isAdmin = false;
    const view = await mount();
    firstTask = "done";
    await view.rerender();
    expect(view.opened()).toBe(false);
  });

  test("stays closed on an API without invites", async () => {
    supported = false;
    const view = await mount();
    firstTask = "done";
    await view.rerender();
    expect(view.opened()).toBe(false);
  });

  test("waits until a dashboard user is picked", async () => {
    userId = null;
    const view = await mount();
    firstTask = "done";
    await view.rerender();
    expect(view.opened()).toBe(false);

    userId = USER_ID;
    await view.rerender();
    expect(view.opened()).toBe(true);
  });
});
