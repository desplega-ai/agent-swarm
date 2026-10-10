import { describe, expect, mock, test } from "bun:test";
import { MutationObserver, QueryClient, QueryObserver } from "@tanstack/react-query";

// Each test supplies its own held-open request, so the client is never called.
mock.module("../client", () => ({ api: {} }));
mock.module("sonner", () => ({ toast: { error: () => {} } }));

const { favoriteToggleOptions } = await import("./use-favorites");

type Workflow = { id: string; favorite: boolean };
type Variables = { itemId: string; favorite: boolean };

const LIST_KEY = ["workflows", "list"];

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/**
 * Real toggle callbacks over a seeded workflow list, with each request held
 * open until the test settles it. `refetches` counts list refetches.
 */
function setup(rows: Workflow[]) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  let server = rows.map((row) => ({ ...row }));
  let refetches = 0;
  queryClient.setQueryData(LIST_KEY, { workflows: rows });
  // Keep the list observed, as the page does, so invalidation refetches it.
  const unwatch = new QueryObserver(queryClient, {
    queryKey: LIST_KEY,
    queryFn: () => {
      refetches += 1;
      return { workflows: server.map((row) => ({ ...row })) };
    },
    staleTime: Number.POSITIVE_INFINITY,
  }).subscribe(() => {});
  const requests = new Map<string, ReturnType<typeof deferred>>();
  const toggle = (variables: Variables) => {
    const request = deferred();
    requests.set(variables.itemId, request);
    const observer = new MutationObserver(queryClient, {
      ...favoriteToggleOptions(queryClient, "workflow"),
      mutationFn: () => request.promise,
    });
    return observer.mutate(variables).then(
      () => {},
      () => {},
    );
  };
  const flags = () =>
    Object.fromEntries(
      (queryClient.getQueryData<{ workflows: Workflow[] }>(LIST_KEY)?.workflows ?? []).map(
        (row) => [row.id, row.favorite],
      ),
    );
  return {
    queryClient,
    toggle,
    flags,
    requests,
    refetchCount: () => refetches,
    setServer: (next: Workflow[]) => {
      server = next;
    },
    cleanup: unwatch,
  };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("favoriteToggleOptions", () => {
  test("two failed toggles roll back only their own item", async () => {
    const t = setup([
      { id: "a", favorite: false },
      { id: "b", favorite: false },
    ]);
    const doneA = t.toggle({ itemId: "a", favorite: true });
    const doneB = t.toggle({ itemId: "b", favorite: true });
    await tick();
    expect(t.flags()).toEqual({ a: true, b: true });

    t.requests.get("a")?.reject(new Error("500"));
    await doneA;
    // A's rollback must not erase B's pending flip.
    expect(t.flags()).toEqual({ a: false, b: true });

    t.requests.get("b")?.reject(new Error("500"));
    await doneB;
    // B's rollback must not resurrect A.
    expect(t.flags()).toEqual({ a: false, b: false });
    t.cleanup();
  });

  test("a toggle that settles does not refetch over another still pending", async () => {
    const t = setup([
      { id: "a", favorite: false },
      { id: "b", favorite: false },
    ]);
    const doneA = t.toggle({ itemId: "a", favorite: true });
    const doneB = t.toggle({ itemId: "b", favorite: true });
    await tick();

    // The server has A's write but not B's yet.
    t.setServer([
      { id: "a", favorite: true },
      { id: "b", favorite: false },
    ]);
    t.requests.get("a")?.resolve();
    await doneA;
    await tick();
    expect(t.refetchCount()).toBe(0);
    expect(t.flags()).toEqual({ a: true, b: true });

    t.setServer([
      { id: "a", favorite: true },
      { id: "b", favorite: true },
    ]);
    t.requests.get("b")?.resolve();
    await doneB;
    await tick();
    // The last toggle to settle reconciles with the server once.
    expect(t.refetchCount()).toBe(1);
    expect(t.flags()).toEqual({ a: true, b: true });
    t.cleanup();
  });
});
