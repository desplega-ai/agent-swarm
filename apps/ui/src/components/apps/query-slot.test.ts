import { describe, expect, test } from "bun:test";
import { QueryClient, QueryObserver } from "@tanstack/react-query";
import type { AppRow } from "@/api/types";
import { buildQuerySlot, type QuerySlot, sameQuerySlot } from "./query-slot";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const row = (id: string): AppRow => ({ id }) as AppRow;

describe("buildQuerySlot against a real query client", () => {
  test("a background refetch over loaded rows sets fetching but not loading", async () => {
    const client = new QueryClient();
    const fetches: ReturnType<typeof deferred<{ rows: AppRow[] }>>[] = [];
    const observer = new QueryObserver(client, {
      queryKey: ["app", "q"],
      queryFn: () => {
        const gate = deferred<{ rows: AppRow[] }>();
        fetches.push(gate);
        return gate.promise;
      },
    });
    const unsubscribe = observer.subscribe(() => {});

    // First load: nothing in hand yet.
    let slot = buildQuerySlot([], observer.getCurrentResult(), undefined);
    expect(slot).toMatchObject({ loading: true, fetching: true, data: [] });
    fetches[0]!.resolve({ rows: [row("a")] });
    await new Promise((r) => setTimeout(r, 0));
    const loaded = buildQuerySlot([], observer.getCurrentResult(), slot);
    expect(loaded).toMatchObject({ loading: false, fetching: false });
    expect(loaded.data).toHaveLength(1);

    // The poll / app.refresh: rows are showing, a fetch is in flight.
    const pending = observer.refetch();
    slot = buildQuerySlot([], observer.getCurrentResult(), loaded);
    expect(observer.getCurrentResult().isLoading).toBe(false); // what the old binding read
    expect(slot).toMatchObject({ loading: false, fetching: true });
    expect(slot.data).toBe(loaded.data);

    fetches[1]!.resolve({ rows: [row("a"), row("b")] });
    await pending;
    slot = buildQuerySlot([], observer.getCurrentResult(), slot);
    expect(slot).toMatchObject({ loading: false, fetching: false });
    expect(slot.data).toHaveLength(2);

    unsubscribe();
    client.clear();
  });

  test("a failed fetch with nothing loaded reports the error and keeps fetching true while retrying", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const gate = deferred<{ rows: AppRow[] }>();
    let fail = true;
    const observer = new QueryObserver(client, {
      queryKey: ["app", "err"],
      queryFn: async () => {
        if (fail) throw new Error("boom");
        return gate.promise;
      },
    });
    const unsubscribe = observer.subscribe(() => {});
    await new Promise((r) => setTimeout(r, 0));
    expect(buildQuerySlot([], observer.getCurrentResult(), undefined)).toMatchObject({
      error: "boom",
      loading: false,
      fetching: false,
    });

    fail = false;
    const pending = observer.refetch();
    const retrying = buildQuerySlot([], observer.getCurrentResult(), undefined);
    expect(retrying.fetching).toBe(true);
    gate.resolve({ rows: [] });
    await pending;
    unsubscribe();
    client.clear();
  });
});

describe("buildQuerySlot without a result", () => {
  test("a query that has not answered yet is loading and fetching, and keeps the warm rows", () => {
    const warm: QuerySlot = {
      data: [row("a")],
      loading: false,
      fetching: false,
      error: null,
    };
    expect(buildQuerySlot([], undefined, warm)).toEqual({
      data: warm.data,
      loading: true,
      fetching: true,
      error: null,
    });
  });

  test("a parked query reports its missing params and is not fetching", () => {
    expect(buildQuerySlot(["id"], undefined, undefined)).toEqual({
      data: [],
      loading: false,
      fetching: false,
      error: "missing route param(s): id",
    });
  });
});

test("sameQuerySlot sees a change in fetching alone", () => {
  const data: AppRow[] = [];
  const a: QuerySlot = { data, loading: false, fetching: false, error: null };
  expect(sameQuerySlot(a, { ...a })).toBe(true);
  expect(sameQuerySlot(a, { ...a, fetching: true })).toBe(false);
});
