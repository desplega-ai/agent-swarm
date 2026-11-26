import { afterAll, afterEach, beforeAll, describe, expect, jest, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { claimKv, closeDb, getKv, initDb } from "../be/db";
import { sha256 } from "../be/db/workflow-idempotency";
import {
  RESULT_OMITTED,
  runIdempotentToolCall,
  TOOL_CALL_IDEMPOTENCY_LEASE_MS,
  TOOL_CALL_IDEMPOTENCY_NAMESPACE,
} from "../be/scripts/tool-call-idempotency";
import { getStorage } from "../be/storage";

const TEST_DB_PATH = `/tmp/tool-call-idempotency-${crypto.randomUUID()}.sqlite`;
const realNow = Date.now;
let offset = 0;

beforeAll(() => {
  closeDb();
  initDb(TEST_DB_PATH);
});

afterEach(() => {
  jest.useRealTimers();
  Date.now = realNow;
  offset = 0;
});

afterAll(async () => {
  closeDb();
  for (const suffix of ["", "-wal", "-shm"]) await unlink(TEST_DB_PATH + suffix).catch(() => {});
});

type Scope = { principal: string; tool: string; key: string };
const recordKeyOf = (s: Scope) => sha256(`${s.principal}\0${s.tool}\0${s.key}`);
const scope = (): Scope => ({ principal: "agent:test", tool: "probe", key: crypto.randomUUID() });
const always = () => true;
/** Moves `Date.now` only, so no lease renewal tick fires: a stalled owner. */
const skewClock = () => {
  Date.now = () => realNow() + offset;
};
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};
/** Waits (bounded) until the claim row carries a write stamped at `at`, i.e. the renewal landed. */
const renewedAt = async (s: Scope, at: number) => {
  for (let i = 0; i < 1000; i++) {
    const row = await getStorage().repos.kv.findEntry(
      TOOL_CALL_IDEMPOTENCY_NAMESPACE,
      recordKeyOf(s),
    );
    if (row?.updated_at === at) return;
    await Promise.resolve();
  }
};

const until = async (done: () => boolean) => {
  for (let i = 0; i < 400 && !done(); i++) await Bun.sleep(5);
  if (!done()) throw new Error("timed out waiting for the call to start");
};

describe("runIdempotentToolCall claim ownership", () => {
  test("a call that outlives its lease still records, and the repeat replays", async () => {
    skewClock();
    const s = scope();
    let invocations = 0;
    const first = await runIdempotentToolCall(
      s,
      async () => {
        offset = TOOL_CALL_IDEMPOTENCY_LEASE_MS + 1;
        return { value: ++invocations };
      },
      always,
    );
    const repeat = await runIdempotentToolCall(s, async () => ({ value: ++invocations }), always);
    expect(invocations).toBe(1);
    expect(first).toEqual({ result: { value: 1 }, replayed: false });
    expect(repeat).toEqual({ result: { value: 1 }, replayed: true });
  });

  test("a live owner renews its lease, so a duplicate past the lease cannot take over", async () => {
    jest.useFakeTimers();
    const s = scope();
    let invocations = 0;
    let takeoverWon: boolean | undefined;
    const first = await runIdempotentToolCall(
      s,
      async () => {
        invocations++;
        // Two leases of wall clock, one renewal tick at a time.
        for (let tick = 0; tick < 8; tick++) {
          jest.advanceTimersByTime(TOOL_CALL_IDEMPOTENCY_LEASE_MS / 4);
          await renewedAt(s, Date.now());
        }
        // The duplicate's claim: insert-or-replace an expired entry.
        takeoverWon = await claimKv({
          namespace: TOOL_CALL_IDEMPOTENCY_NAMESPACE,
          key: recordKeyOf(s),
          value: { state: "pending", token: "duplicate" },
          valueType: "json",
          expiresAt: Date.now() + TOOL_CALL_IDEMPOTENCY_LEASE_MS,
        });
        return { value: invocations };
      },
      always,
    );
    jest.useRealTimers();
    expect(takeoverWon).toBe(false);
    const repeat = await runIdempotentToolCall(s, async () => ({ value: ++invocations }), always);
    expect(invocations).toBe(1);
    expect(first.replayed).toBe(false);
    expect(repeat).toEqual({ result: { value: 1 }, replayed: true });
  });

  test("concurrent duplicates run the tool once", async () => {
    const s = scope();
    let invocations = 0;
    const results = await Promise.all(
      Array.from({ length: 16 }, () =>
        runIdempotentToolCall(
          s,
          async () => {
            invocations++;
            await Bun.sleep(20);
            return { value: invocations };
          },
          always,
        ),
      ),
    );
    expect(invocations).toBe(1);
    expect(results.filter((r) => r.replayed)).toHaveLength(15);
  });

  for (const outcome of ["success", "error"] as const) {
    test(`a stale owner's ${outcome} leaves the takeover's claim and record alone`, async () => {
      skewClock();
      const s = scope();
      const started = { stale: false, takeover: false };
      const stale = deferred<{ value: string }>();
      const staleCall = runIdempotentToolCall(
        s,
        () => {
          started.stale = true;
          return stale.promise;
        },
        always,
      );
      await until(() => started.stale);
      offset = TOOL_CALL_IDEMPOTENCY_LEASE_MS + 1; // the stale owner stalled a whole lease
      const takeover = deferred<{ value: string }>();
      const takeoverCall = runIdempotentToolCall(
        s,
        () => {
          started.takeover = true;
          return takeover.promise;
        },
        always,
      );
      await until(() => started.takeover);

      if (outcome === "success") stale.resolve({ value: "stale" });
      else stale.reject(new Error("stale failed"));
      await (outcome === "success" ? staleCall : staleCall.catch(() => undefined));
      // The takeover still holds its claim: neither overwritten nor released.
      const held = await getKv(TOOL_CALL_IDEMPOTENCY_NAMESPACE, recordKeyOf(s));
      expect(held?.value).toMatchObject({ state: "pending" });

      takeover.resolve({ value: "takeover" });
      await takeoverCall;
      const repeat = await runIdempotentToolCall(s, async () => ({ value: "again" }), always);
      expect(repeat).toEqual({ result: { value: "takeover" }, replayed: true });
    });
  }
});

describe("runIdempotentToolCall recorded result", () => {
  test("is sealed at rest, so a raw kv_entries read does not reveal it, and still replays", async () => {
    const s = scope();
    const marker = `private-note-${crypto.randomUUID()}`;
    const first = await runIdempotentToolCall(s, async () => ({ text: marker }), always);
    const row = await getStorage().repos.kv.findEntry(
      TOOL_CALL_IDEMPOTENCY_NAMESPACE,
      recordKeyOf(s),
    );
    expect(row?.value).toBeDefined();
    expect(String(row?.value)).not.toContain(marker);
    const repeat = await runIdempotentToolCall(s, async () => ({ text: "ran again" }), always);
    expect(first).toEqual({ result: { text: marker }, replayed: false });
    expect(repeat).toEqual({ result: { text: marker }, replayed: true });
  });

  test("a record that no longer opens replays as omitted and does not run again", async () => {
    const s = scope();
    await claimKv({
      namespace: TOOL_CALL_IDEMPOTENCY_NAMESPACE,
      key: recordKeyOf(s),
      value: { state: "done", sealed: "sealed:v1:not-a-valid-payload" },
      valueType: "json",
      expiresAt: Date.now() + 60_000,
    });
    let invocations = 0;
    const repeat = await runIdempotentToolCall(s, async () => ++invocations, always);
    expect(invocations).toBe(0);
    expect(repeat).toEqual({ result: RESULT_OMITTED, replayed: true });
  });
});
