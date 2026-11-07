import { afterAll, afterEach, beforeEach, describe, expect, jest, mock, test } from "bun:test";
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
let teamSize: string | null = null;
// Payloads arrive after the prompt mounts, unless a test says otherwise.
let fetchedAt = () => Date.now() + 60_000;

mock.module("@/api/hooks/use-onboarding", () => ({
  useOnboarding: () => ({
    data: { state: { steps: { first_task: { status: firstTask } } } },
    dataUpdatedAt: fetchedAt(),
    isFetchedAfterMount: true,
  }),
}));
mock.module("@/api/hooks/use-config-api", () => ({
  useConfigs: () => ({
    data: teamSize === null ? [] : [{ key: "SWARM_ORG_TEAM_SIZE", value: teamSize }],
  }),
}));
mock.module("@/lib/company-profile", () => require("../../lib/company-profile"));
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
  InviteDialog: ({
    open,
    intro,
  }: {
    open: boolean;
    intro?: { title: string; description: string };
  }) => (open ? <p data-testid="invite">{intro?.description}</p> : null),
}));

const { FirstTaskInvitePrompt, firstTaskInviteKey, resetFirstTaskInviteWatchForTests } =
  await import("./first-task-invite-prompt");

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
    text: () => container.querySelector('[data-testid="invite"]')?.textContent ?? "",
    unmount: () => act(() => root.unmount()),
  };
}

/** The prompt opens this long after the step turns done. */
const OPEN_DELAY_MS = 2_000;

async function elapse(ms = OPEN_DELAY_MS) {
  await act(async () => {
    jest.advanceTimersByTime(ms);
  });
}

beforeEach(() => {
  firstTask = "todo";
  isAdmin = true;
  supported = true;
  userId = USER_ID;
  teamSize = null;
  fetchedAt = () => Date.now() + 60_000;
  localStorage.clear();
  document.body.innerHTML = "";
  resetFirstTaskInviteWatchForTests();
  jest.useFakeTimers();
});

afterEach(() => {
  jest.useRealTimers();
});

describe("FirstTaskInvitePrompt", () => {
  test("opens once when the first task completes while the tab watches", async () => {
    const view = await mount();
    expect(view.opened()).toBe(false);

    firstTask = "done";
    await view.rerender();
    await elapse();
    expect(view.opened()).toBe(true);
    expect(localStorage.getItem(firstTaskInviteKey(API_URL, USER_ID))).toBe("1");
    await view.unmount();

    // A new page load with the same swarm and user: never again.
    firstTask = "todo";
    const again = await mount();
    firstTask = "done";
    await again.rerender();
    await elapse();
    expect(again.opened()).toBe(false);
  });

  test("opens in the app shell when /setup saw the first task pending", async () => {
    // `/setup` sees the task pending, then sending it opens the session page.
    const setup = await mount();
    await setup.unmount();

    // The shell's prompt mounts on the cache, and the task is done before
    // its first own fetch.
    fetchedAt = () => 0;
    const shell = await mount();
    expect(shell.opened()).toBe(false);
    firstTask = "done";
    fetchedAt = () => Date.now() + 60_000;
    await shell.rerender();
    await elapse();
    expect(shell.opened()).toBe(true);
  });

  test("stays closed when the first task was already done before this tab", async () => {
    firstTask = "done";
    const view = await mount();
    await view.rerender();
    await elapse();
    expect(view.opened()).toBe(false);
  });

  test("ignores a persisted payload from before the mount", async () => {
    fetchedAt = () => 0;
    const view = await mount();
    firstTask = "done";
    fetchedAt = () => Date.now() + 60_000;
    await view.rerender();
    await elapse();
    expect(view.opened()).toBe(false);
  });

  test("stays closed for a user who cannot invite", async () => {
    isAdmin = false;
    const view = await mount();
    firstTask = "done";
    await view.rerender();
    await elapse();
    expect(view.opened()).toBe(false);
  });

  test("stays closed on an API without invites", async () => {
    supported = false;
    const view = await mount();
    firstTask = "done";
    await view.rerender();
    await elapse();
    expect(view.opened()).toBe(false);
  });

  test("opens for Solo too, with the Solo text", async () => {
    teamSize = "1";
    const view = await mount();
    firstTask = "done";
    await view.rerender();
    await elapse();
    expect(view.opened()).toBe(true);
    expect(view.text()).toContain("Do you work with someone?");
  });

  test("a large team gets the team text, and no size gets the teammate text", async () => {
    teamSize = "51+";
    const team = await mount();
    firstTask = "done";
    await team.rerender();
    await elapse();
    expect(team.text()).toContain("Bring your team in");
    await team.unmount();

    localStorage.clear();
    resetFirstTaskInviteWatchForTests();
    teamSize = null;
    firstTask = "todo";
    const unsized = await mount();
    firstTask = "done";
    await unsized.rerender();
    await elapse();
    expect(unsized.text()).toContain("Invite a teammate");
  });

  test("waits until a dashboard user is picked", async () => {
    userId = null;
    const view = await mount();
    firstTask = "done";
    await view.rerender();
    await elapse();
    expect(view.opened()).toBe(false);

    userId = USER_ID;
    await view.rerender();
    await elapse();
    expect(view.opened()).toBe(true);
  });

  test("opens 2 s after the first task is done, so the answer renders first", async () => {
    const view = await mount();
    firstTask = "done";
    await view.rerender();
    await elapse(OPEN_DELAY_MS - 1);
    expect(view.opened()).toBe(false);
    expect(localStorage.getItem(firstTaskInviteKey(API_URL, USER_ID))).toBeNull();

    await elapse(1);
    expect(view.opened()).toBe(true);
    expect(localStorage.getItem(firstTaskInviteKey(API_URL, USER_ID))).toBe("1");
  });

  test("an unmount during the delay cancels the offer", async () => {
    const view = await mount();
    firstTask = "done";
    await view.rerender();
    await elapse(OPEN_DELAY_MS / 2);
    await view.unmount();
    await elapse();
    expect(localStorage.getItem(firstTaskInviteKey(API_URL, USER_ID))).toBeNull();
  });

  test("the delay starts again when a condition stops holding", async () => {
    const view = await mount();
    firstTask = "done";
    await view.rerender();
    await elapse(OPEN_DELAY_MS / 2);
    userId = null;
    await view.rerender();
    await elapse();
    expect(view.opened()).toBe(false);
    expect(localStorage.getItem(firstTaskInviteKey(API_URL, USER_ID))).toBeNull();

    userId = USER_ID;
    await view.rerender();
    await elapse(OPEN_DELAY_MS - 1);
    expect(view.opened()).toBe(false);
    await elapse(1);
    expect(view.opened()).toBe(true);
  });
});
