import { spyOn } from "bun:test";
import { getDbClient } from "../be/db";

export type WriteGate = {
  /** Resolves once the first matching statement is held. */
  held: Promise<void>;
  release: () => void;
  restore: () => void;
};

/**
 * Holds the first statement that matches `sql` until `release()`, so a test can run a second
 * request after the first has read and decided but before it writes. A caller that decides
 * against a snapshot taken outside a transaction is stale by then; a caller that decides inside
 * the write transaction keeps the write lock while it is held, so the second request queues.
 */
export function holdFirstWrite(sql: RegExp): WriteGate {
  const client = getDbClient();
  const original = client.get.bind(client);
  let release = () => {};
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  let markHeld = () => {};
  const held = new Promise<void>((resolve) => {
    markHeld = resolve;
  });
  let armed = true;

  const spy = spyOn(client, "get").mockImplementation((async (
    statement: string,
    params?: Parameters<typeof original>[1],
  ) => {
    if (armed && sql.test(statement)) {
      armed = false;
      markHeld();
      await released;
    }
    return original(statement, params);
  }) as typeof client.get);

  return { held, release, restore: () => spy.mockRestore() };
}

/** Lets a request that is not blocked finish; one queued behind a transaction stays queued. */
export const settleUnblockedWork = (): Promise<void> => new Promise((r) => setTimeout(r, 50));

/**
 * Starts `first`, holds its write, runs `second` meanwhile, then lets `first` write. Returns both
 * results. `first` is the request whose decision can go stale; `second` is the concurrent edit.
 */
export async function interleave<A, B>(
  sql: RegExp,
  first: () => Promise<A>,
  second: () => Promise<B>,
): Promise<{ first: A; second: B }> {
  const gate = holdFirstWrite(sql);
  try {
    const firstResult = first();
    await gate.held;
    const secondResult = second();
    await settleUnblockedWork();
    gate.release();
    return { first: await firstResult, second: await secondResult };
  } finally {
    gate.restore();
  }
}
