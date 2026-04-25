import { describe, expect, test } from "bun:test";
import { createAdditiveBuffer } from "../tasks/additive-buffer";

/**
 * Helper: wait for a timer-based flush. We use tight timeouts (10-30ms) so
 * tests stay fast — these operate on Bun's event loop, not real time.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

describe("createAdditiveBuffer", () => {
  test("rejects non-positive timeoutMs", () => {
    expect(() => createAdditiveBuffer({ timeoutMs: 0, onFlush: () => {} })).toThrow(
      /positive number/,
    );
    expect(() => createAdditiveBuffer({ timeoutMs: -1, onFlush: () => {} })).toThrow();
    // biome-ignore lint/suspicious/noExplicitAny: type-guard test
    expect(() => createAdditiveBuffer({ timeoutMs: NaN as any, onFlush: () => {} })).toThrow();
  });

  test("enqueue without existing buffer creates one with timer", () => {
    let flushed: number[] | null = null;
    const buf = createAdditiveBuffer<number>({
      timeoutMs: 10_000,
      onFlush: (items) => {
        flushed = [...items];
      },
    });
    buf.enqueue("k1", 1);
    expect(buf.isBuffered("k1")).toBe(true);
    expect(buf.count("k1")).toBe(1);
    expect(flushed).toBeNull();
    buf.cancel("k1");
  });

  test("three rapid enqueues coalesce into one flush", async () => {
    const flushes: string[][] = [];
    const buf = createAdditiveBuffer<string>({
      timeoutMs: 20,
      onFlush: (items) => {
        flushes.push([...items]);
      },
      label: "test-coalesce",
    });

    buf.enqueue("k", "a");
    await sleep(5);
    buf.enqueue("k", "b");
    await sleep(5);
    buf.enqueue("k", "c");
    expect(buf.count("k")).toBe(3);

    // Wait for debounce to elapse
    await sleep(50);

    expect(flushes.length).toBe(1);
    expect(flushes[0]).toEqual(["a", "b", "c"]);
    expect(buf.isBuffered("k")).toBe(false);
  });

  test("enqueue resets the timer", async () => {
    const flushes: number[][] = [];
    const buf = createAdditiveBuffer<number>({
      timeoutMs: 30,
      onFlush: (items) => {
        flushes.push([...items]);
      },
    });

    buf.enqueue("k", 1);
    await sleep(20); // 20 < 30, timer would have NOT fired
    buf.enqueue("k", 2); // resets
    await sleep(20); // another 20 < 30
    buf.enqueue("k", 3); // resets again

    expect(flushes.length).toBe(0);
    await sleep(60);
    expect(flushes.length).toBe(1);
    expect(flushes[0]).toEqual([1, 2, 3]);
  });

  test("instantFlush fires immediately with reason='manual'", async () => {
    let seenReason: string | null = null;
    const buf = createAdditiveBuffer<number>({
      timeoutMs: 10_000,
      onFlush: (_items, _key, reason) => {
        seenReason = reason;
      },
    });
    buf.enqueue("k", 1);
    await buf.instantFlush("k");
    expect(seenReason).toBe("manual");
    expect(buf.isBuffered("k")).toBe(false);
  });

  test("timer flush reports reason='timer'", async () => {
    let seenReason: string | null = null;
    const buf = createAdditiveBuffer<number>({
      timeoutMs: 10,
      onFlush: (_items, _key, reason) => {
        seenReason = reason;
      },
    });
    buf.enqueue("k", 1);
    await sleep(40);
    expect(seenReason).toBe("timer");
  });

  test("instantFlush on unknown key is a no-op", async () => {
    let called = false;
    const buf = createAdditiveBuffer<number>({
      timeoutMs: 10_000,
      onFlush: () => {
        called = true;
      },
    });
    await buf.instantFlush("nope");
    expect(called).toBe(false);
  });

  test("cancel drops the buffer without flushing", async () => {
    let called = false;
    const buf = createAdditiveBuffer<number>({
      timeoutMs: 20,
      onFlush: () => {
        called = true;
      },
    });
    buf.enqueue("k", 1);
    expect(buf.cancel("k")).toBe(true);
    expect(buf.isBuffered("k")).toBe(false);
    await sleep(50);
    expect(called).toBe(false);
  });

  test("cancel on unknown key returns false", () => {
    const buf = createAdditiveBuffer<number>({ timeoutMs: 10_000, onFlush: () => {} });
    expect(buf.cancel("nope")).toBe(false);
  });

  test("enqueue rejects empty contextKey", () => {
    const buf = createAdditiveBuffer<number>({ timeoutMs: 10_000, onFlush: () => {} });
    expect(() => buf.enqueue("", 1)).toThrow(/contextKey/);
  });

  test("onFlush errors are swallowed (logged, buffer still clears)", async () => {
    const buf = createAdditiveBuffer<number>({
      timeoutMs: 10,
      onFlush: () => {
        throw new Error("boom");
      },
    });
    buf.enqueue("k", 1);
    await sleep(40);
    expect(buf.isBuffered("k")).toBe(false);
  });

  test("buffers are independent across keys", async () => {
    const flushes: Record<string, number[][]> = {};
    const buf = createAdditiveBuffer<number>({
      timeoutMs: 20,
      onFlush: (items, key) => {
        const arr = flushes[key] ?? [];
        arr.push([...items]);
        flushes[key] = arr;
      },
    });
    buf.enqueue("a", 1);
    buf.enqueue("b", 10);
    buf.enqueue("a", 2);
    await sleep(50);
    expect(flushes.a).toEqual([[1, 2]]);
    expect(flushes.b).toEqual([[10]]);
  });

  test("keys() returns active buffer keys", () => {
    const buf = createAdditiveBuffer<number>({ timeoutMs: 10_000, onFlush: () => {} });
    buf.enqueue("a", 1);
    buf.enqueue("b", 2);
    expect(new Set(buf.keys())).toEqual(new Set(["a", "b"]));
    buf.cancel("a");
    expect(buf.keys()).toEqual(["b"]);
    buf.cancel("b");
  });
});
