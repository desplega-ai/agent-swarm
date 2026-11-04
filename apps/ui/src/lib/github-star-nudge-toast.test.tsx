import { afterAll, afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, StrictMode } from "react";
import type { Stats } from "../api/types";

GlobalRegistrator.register();
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
// Query polling, React DOM, and Sonner must detect the browser after the DOM exists.
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { createRoot } = await import("react-dom/client");
const { Toaster, toast } = await import("sonner");

const API = "https://api.example.test";
const USER = "user-1";
let apiUrl = API;
let userId: string | null = USER;
let state: "pending" | "needs-pick" | "ready" = "ready";
let statsResponse: () => Promise<Stats>;
const fetchStats = mock(() => statsResponse());
mock.module("../api/client", () => ({ api: { fetchStats } }));
mock.module("@/api/hooks/use-stats", () => require("../api/hooks/use-stats"));
mock.module("@/contexts/current-user-context", () => ({
  useCurrentUser: () => ({ state, userId }),
}));
mock.module("../hooks/use-config", () => ({ useConfig: () => ({ config: { apiUrl } }) }));
mock.module("@/hooks/use-config", () => require("../hooks/use-config"));
mock.module("@/hooks/use-dismissible-card", () => require("../hooks/use-dismissible-card"));
const { GitHubStarNudge } = await import("./github-star-nudge-toast");

function stats(total: number): Stats {
  return {
    agents: { total: 0, idle: 0, busy: 0, offline: 0 },
    tasks: { total, pending: 0, in_progress: 0, paused: 0, completed: 0, failed: 0 },
  };
}

const doneKey = (swarm = API, user = USER) => `swarm:v1:${swarm}:github-star-nudge:${user}:done`;
const tick = () => act(() => new Promise((resolve) => setTimeout(resolve, 50)));
const starToasts = () =>
  [...document.querySelectorAll<HTMLElement>("[data-sonner-toast]")].filter(
    (el) => el.textContent?.includes("Enjoying agent-swarm?") && el.dataset.removed !== "true",
  );
const close = () =>
  act(async () =>
    starToasts()[0]?.querySelector<HTMLButtonElement>("button[aria-label=Close]")?.click(),
  );

let root: ReturnType<typeof createRoot>;
let host: HTMLDivElement;
let client: InstanceType<typeof QueryClient>;
async function render() {
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <GitHubStarNudge />
        <Toaster />
      </QueryClientProvider>,
    ),
  );
  await tick();
}
async function refreshStats(total: number) {
  statsResponse = async () => stats(total);
  await act(async () => client.refetchQueries({ queryKey: ["stats"] }));
  await tick();
}

beforeEach(() => {
  localStorage.clear();
  apiUrl = API;
  userId = USER;
  state = "ready";
  statsResponse = async () => stats(5);
  fetchStats.mockClear();
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  toast.dismiss();
  client.clear();
  host.remove();
});
afterAll(async () => GlobalRegistrator.unregister());

describe("automatic GitHub star nudge", () => {
  test("stays hidden below five tasks and opens when polling crosses five", async () => {
    statsResponse = async () => stats(4);
    await render();
    expect(starToasts()).toHaveLength(0);
    await refreshStats(5);
    expect(starToasts()).toHaveLength(1);
    await refreshStats(6);
    expect(starToasts()).toHaveLength(1);
  });

  test("opens on load for existing tasks despite a filtered, paginated list", async () => {
    // This page's list has no matching rows. Stats still counts the whole swarm.
    client.setQueryData(["tasks", { status: "failed", search: "missing", limit: 1, offset: 100 }], {
      tasks: [],
      total: 0,
    });
    statsResponse = async () => stats(50);
    await render();
    expect(fetchStats).toHaveBeenCalledTimes(1);
    expect(starToasts()).toHaveLength(1);
  });

  test("polling opens the toast without another prompt or a page render", async () => {
    client.setQueryDefaults(["stats"], {
      refetchInterval: 20,
      refetchIntervalInBackground: true,
    });
    statsResponse = async () => stats(4);
    await render();
    expect(starToasts()).toHaveLength(0);
    statsResponse = async () => stats(5);
    await tick();
    await tick();
    expect(starToasts()).toHaveLength(1);
  });

  test("Strict Mode cleanup neither dismisses the offer nor removes its replacement", async () => {
    client.setQueryData(["stats"], stats(5));
    await act(async () =>
      root.render(
        <StrictMode>
          <QueryClientProvider client={client}>
            <Toaster />
            <GitHubStarNudge />
          </QueryClientProvider>
        </StrictMode>,
      ),
    );
    await tick();
    expect(starToasts()).toHaveLength(1);
    expect(localStorage.getItem(doneKey())).toBeNull();
  });

  test("waits for asynchronous stats without another user action", async () => {
    const pending = Promise.withResolvers<Stats>();
    statsResponse = () => pending.promise;
    await render();
    expect(starToasts()).toHaveLength(0);
    await act(async () => pending.resolve(stats(5)));
    await tick();
    expect(starToasts()).toHaveLength(1);
  });

  test("waits for resolved identity and skips anonymous tabs", async () => {
    state = "pending";
    await render();
    expect(starToasts()).toHaveLength(0);
    expect(fetchStats).not.toHaveBeenCalled();
    state = "needs-pick";
    userId = null;
    await render();
    expect(starToasts()).toHaveLength(0);
    expect(localStorage.length).toBe(0);
    state = "ready";
    userId = USER;
    await render();
    expect(starToasts()).toHaveLength(1);
  });

  test("failed stats do not prompt, and a later successful response does", async () => {
    statsResponse = async () => {
      throw new Error("Unavailable");
    };
    await render();
    expect(starToasts()).toHaveLength(0);
    await refreshStats(5);
    expect(starToasts()).toHaveLength(1);
  });

  test("Close persists only for this user and swarm, including after a remount", async () => {
    await render();
    await close();
    await tick();
    expect(localStorage.getItem(doneKey())).toBe("1");
    await refreshStats(10);
    expect(starToasts()).toHaveLength(0);
    await act(async () => root.unmount());
    root = createRoot(host);
    await render();
    expect(starToasts()).toHaveLength(0);

    userId = "user-2";
    await render();
    expect(starToasts()).toHaveLength(1);
    expect(localStorage.getItem(doneKey(API, "user-2"))).toBeNull();
    await close();
    userId = USER;
    await render();
    expect(starToasts()).toHaveLength(0);
    apiUrl = "https://other.example.test";
    await render();
    expect(starToasts()).toHaveLength(1);
    expect(localStorage.getItem(doneKey(apiUrl))).toBeNull();
  });

  test("ignores the old shared dismissal and action counter", async () => {
    localStorage.setItem(`swarm:v1:${API}:github-star-nudge:done`, "1");
    localStorage.setItem(`swarm:v1:${API}:github-star-nudge:prompts`, "999");
    statsResponse = async () => stats(4);
    await render();
    expect(starToasts()).toHaveLength(0);
    await refreshStats(5);
    expect(starToasts()).toHaveLength(1);
  });

  test("a user switch removes the old toast without storing a dismissal", async () => {
    await render();
    state = "pending";
    await render();
    expect(starToasts()).toHaveLength(0);
    expect(localStorage.getItem(doneKey())).toBeNull();
    state = "ready";
    userId = "user-2";
    localStorage.setItem(doneKey(API, "user-2"), "1");
    await render();
    expect(starToasts()).toHaveLength(0);
    userId = USER;
    await render();
    expect(starToasts()).toHaveLength(1);
  });

  test("a dismissal from another tab closes the toast", async () => {
    await render();
    localStorage.setItem(doneKey(), "1");
    await act(async () =>
      window.dispatchEvent(
        new StorageEvent("storage", {
          key: doneKey(),
          newValue: "1",
        }),
      ),
    );
    await tick();
    expect(starToasts()).toHaveLength(0);
  });

  test("unavailable storage still permits dismissal for the mounted user", async () => {
    const get = spyOn(localStorage, "getItem").mockImplementation(() => {
      throw new Error("Storage denied");
    });
    const set = spyOn(localStorage, "setItem").mockImplementation(() => {
      throw new Error("Storage denied");
    });
    try {
      await render();
      expect(starToasts()).toHaveLength(1);
      await close();
      await refreshStats(10);
      expect(starToasts()).toHaveLength(0);
    } finally {
      get.mockRestore();
      set.mockRestore();
    }
  });

  test("keeps its contents hidden when a newer toast collapses it", async () => {
    await render();
    await act(async () => void toast.error("Attachment upload failed", { duration: Infinity }));
    await tick();
    const star = starToasts()[0];
    expect(star).toBeDefined();
    expect(star?.dataset.styled).toBe("false");
    expect(star?.matches("[data-expanded=false][data-front=false]")).toBe(true);
    expect(star?.className.split(" ")).toContain(
      "[&[data-expanded=false][data-front=false]>*]:opacity-0",
    );
    expect(star?.className.split(" ")).toContain(
      "[&[data-expanded=false][data-front=false]>*]:pointer-events-none",
    );
  });

  test("Star on GitHub opens the repo and persists dismissal", async () => {
    const opened: unknown[][] = [];
    const realOpen = window.open;
    window.open = ((...args: unknown[]) => {
      opened.push(args);
      return null;
    }) as typeof window.open;
    try {
      await render();
      await act(async () =>
        starToasts()[0]?.querySelector<HTMLButtonElement>("[data-slot=button]")?.click(),
      );
      await tick();
      expect(opened).toEqual([
        ["https://github.com/desplega-ai/agent-swarm", "_blank", "noopener,noreferrer"],
      ]);
      expect(localStorage.getItem(doneKey())).toBe("1");
      await refreshStats(10);
      expect(starToasts()).toHaveLength(0);
    } finally {
      window.open = realOpen;
    }
  });
});
