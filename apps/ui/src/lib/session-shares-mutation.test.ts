import { describe, expect, test } from "bun:test";
import { MutationObserver, QueryClient } from "@tanstack/query-core";
import type { SessionShares } from "../api/types";
import { sessionSharesMutationOptions } from "./session-shares-mutation";
import { setPerson } from "./session-sharing";

const ROOT = "root-1";
const KEY = ["session-shares", ROOT];
const at = "2026-10-18T10:00:00.000Z";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function until(check: () => boolean) {
  for (let i = 0; i < 100 && !check(); i++) await Bun.sleep(1);
  expect(check()).toBe(true);
}

function setup() {
  const queryClient = new QueryClient();
  const puts: { next: SessionShares; reply: ReturnType<typeof deferred<SessionShares>> }[] = [];
  const failures: unknown[] = [];
  const options = sessionSharesMutationOptions(
    queryClient,
    ROOT,
    (next) => {
      const reply = deferred<SessionShares>();
      puts.push({ next, reply });
      return reply.promise;
    },
    (error) => failures.push(error),
  );
  const edit = (next: SessionShares) =>
    new MutationObserver(queryClient, options).mutate(next).catch(() => {});
  const cached = () => queryClient.getQueryData<SessionShares>(KEY);
  return { queryClient, puts, failures, edit, cached };
}

const start: SessionShares = {
  everyone: "none",
  users: [
    { userId: "a", access: "read", createdAt: at },
    { userId: "b", access: "read", createdAt: at },
  ],
};

describe("sessionSharesMutationOptions", () => {
  test("an older response does not bring back a person a newer pending edit removed", async () => {
    const { queryClient, puts, edit, cached } = setup();
    queryClient.setQueryData(KEY, start);

    const first = setPerson(start, "a", "write");
    const done1 = edit(first);
    await until(() => puts.length === 1);
    const second = setPerson(cached()!, "b", "remove");
    const done2 = edit(second);
    await until(() => cached()?.users.length === 1);

    // PUT 1 lands while PUT 2 still waits: B must stay removed.
    puts[0]!.reply.resolve(first);
    await done1;
    expect(cached()?.users.map((u) => u.userId)).toEqual(["a"]);

    await until(() => puts.length === 2);
    expect(puts[1]!.next.users.map((u) => u.userId)).toEqual(["a"]);
    const saved: SessionShares = {
      everyone: "none",
      users: [{ userId: "a", access: "write", createdAt: at }],
    };
    puts[1]!.reply.resolve(saved);
    await done2;
    expect(cached()).toEqual(saved);
  });

  test("an older failure does not roll back a newer pending edit; the newest failure undoes and refetches", async () => {
    const { queryClient, puts, failures, edit, cached } = setup();
    queryClient.setQueryData(KEY, start);

    const first = setPerson(start, "a", "write");
    const done1 = edit(first);
    await until(() => puts.length === 1);
    const second = setPerson(cached()!, "b", "remove");
    const done2 = edit(second);
    await until(() => cached()?.users.length === 1);

    puts[0]!.reply.reject(new Error("boom"));
    await done1;
    expect(cached()).toEqual(second);
    expect(queryClient.getQueryState(KEY)?.isInvalidated).toBe(false);
    expect(failures).toHaveLength(1);

    await until(() => puts.length === 2);
    puts[1]!.reply.reject(new Error("boom again"));
    await done2;
    // The newest edit failed: undo it and refetch the server's state.
    expect(cached()).toEqual(first);
    expect(queryClient.getQueryState(KEY)?.isInvalidated).toBe(true);
    expect(failures).toHaveLength(2);
  });
});
