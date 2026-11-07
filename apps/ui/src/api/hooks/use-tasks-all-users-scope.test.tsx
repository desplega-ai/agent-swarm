import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
  keepPreviousData,
  QueryClient,
  QueryClientProvider,
  QueryObserver,
} from "@tanstack/react-query";
import { act } from "react";
import {
  allUsersScopeEnabled,
  allUsersScopeKey,
  bindAllUsersScopeCache,
  setAllUsersScope,
  withinAllUsersScope,
} from "../../lib/all-users-scope";

GlobalRegistrator.register();
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
afterAll(async () => {
  await GlobalRegistrator.unregister();
});

const admin = { apiUrl: "https://api.example.test", apiKey: "aswt_admin-scope-test" };

type Page = { tasks: { id: string }[]; total: number };

// The server: page 0 answers at once, every later page waits for `answer()`.
// What it returns depends on the scope the request carried.
let pending: Array<() => void> = [];
function serve(offset: number): Promise<Page> {
  const scoped = allUsersScopeEnabled(admin);
  const page: Page = {
    tasks: [{ id: `${scoped ? "other-user" : "own"}-task-${offset}` }],
    total: 100,
  };
  if (offset === 0) return Promise.resolve(page);
  return new Promise((resolve) => pending.push(() => resolve(page)));
}
const answer = () => {
  const waiting = pending;
  pending = [];
  for (const resolve of waiting) resolve();
};

mock.module("../client", () => ({
  api: { fetchTasks: async (filters?: { offset?: number }) => serve(filters?.offset ?? 0) },
}));

// react-dom must load after the DOM exists.
const { createRoot } = await import("react-dom/client");
const { useTasks } = await import("./use-tasks");

// Another tab writes storage; the browser then fires `storage` in this tab.
const otherTab = (on: boolean) => {
  const key = allUsersScopeKey(admin);
  const oldValue = localStorage.getItem(key);
  if (on) localStorage.setItem(key, "1");
  else localStorage.removeItem(key);
  window.dispatchEvent(new StorageEvent("storage", { key, oldValue, newValue: on ? "1" : null }));
};

beforeEach(() => {
  localStorage.clear();
  pending = [];
});

const tick = () => new Promise((r) => setTimeout(r, 20));

const optOuts = {
  "in this tab": () => setAllUsersScope(admin, false),
  "in another tab": () => otherTab(false),
};

describe("a kept page never outlives an all-users opt-out", () => {
  for (const [where, optOut] of Object.entries(optOuts)) {
    test(`useTasks with keepPreviousData drops page 1's all-users rows on an opt-out ${where}`, async () => {
      const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      const unbind = bindAllUsersScopeCache(client);
      let shown: { tasks: { id: string }[] } | undefined;
      function Probe({ page }: { page: number }) {
        shown = useTasks({ limit: 1, offset: page }, { keepPreviousData: true }).data;
        return null;
      }
      const host = document.createElement("div");
      document.body.append(host);
      const root = createRoot(host);
      // A query result lands on the render after the act that fetched it.
      const settle = async (step: () => void) => {
        await act(async () => {
          step();
          await tick();
        });
        await act(tick);
      };
      const render = (page: number) =>
        settle(() =>
          root.render(
            <QueryClientProvider client={client}>
              <Probe page={page} />
            </QueryClientProvider>,
          ),
        );
      try {
        setAllUsersScope(admin, true);
        await render(0);
        expect(shown?.tasks.map((t) => t.id)).toEqual(["other-user-task-0"]);

        // Page 2 is on its way: page 1 stays on screen meanwhile.
        await render(1);
        expect(shown?.tasks.map((t) => t.id)).toEqual(["other-user-task-0"]);

        await settle(optOut);
        expect(allUsersScopeEnabled(admin)).toBe(false);
        expect(shown).toBeUndefined();

        await settle(answer);
        expect(shown?.tasks.map((t) => t.id)).toEqual(["own-task-1"]);
      } finally {
        await act(async () => root.unmount());
        host.remove();
        unbind();
      }
    });
  }

  test("a QueryObserver keeps a memoized placeholder after resetQueries; withinAllUsersScope drops it", async () => {
    setAllUsersScope(admin, true);
    // A placeholder needs data fetched strictly after the last scope change,
    // and page 0 answers at once: let the clock move past the opt-in first.
    await tick();
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const unbind = bindAllUsersScopeCache(client);
    const options = (offset: number, placeholderData: typeof keepPreviousData) => ({
      queryKey: ["tasks", offset],
      queryFn: () => serve(offset),
      placeholderData,
    });
    const plain = new QueryObserver<Page>(client, options(0, keepPreviousData));
    const scoped = new QueryObserver<Page>(
      client,
      options(0, withinAllUsersScope(keepPreviousData)),
    );
    const stopPlain = plain.subscribe(() => {});
    const stopScoped = scoped.subscribe(() => {});
    try {
      await client.refetchQueries({ queryKey: ["tasks", 0] });
      plain.setOptions(options(1, keepPreviousData));
      scoped.setOptions(options(1, withinAllUsersScope(keepPreviousData)));
      expect(scoped.getCurrentResult().data?.tasks[0]?.id).toBe("other-user-task-0");

      setAllUsersScope(admin, false);
      await Promise.resolve();
      // A render passes the options again, as useQuery does on every render.
      plain.setOptions(options(1, keepPreviousData));
      scoped.setOptions(options(1, withinAllUsersScope(keepPreviousData)));
      // Control: the plain observer still shows the old scope's page 1.
      expect(plain.getCurrentResult().data?.tasks[0]?.id).toBe("other-user-task-0");
      expect(scoped.getCurrentResult().data).toBeUndefined();
    } finally {
      stopPlain();
      stopScoped();
      unbind();
    }
  });
});
