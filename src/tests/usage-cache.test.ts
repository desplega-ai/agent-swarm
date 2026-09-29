import { afterEach, beforeEach, describe, expect, setSystemTime, test } from "bun:test";
import {
  cachedUsageReport,
  clearUsageCache,
  USAGE_CACHE_MAX_STALE_MS,
  USAGE_CACHE_TTL_MS,
} from "../http/usage-cache";

const T0 = new Date("2026-09-29T12:00:00.000Z");

function loader(values: unknown[]) {
  let calls = 0;
  const load = async () => {
    const value = values[Math.min(calls, values.length - 1)];
    calls++;
    return value;
  };
  return { load, calls: () => calls };
}

// The background refresh is a promise chain; let it settle.
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("cachedUsageReport", () => {
  beforeEach(() => {
    clearUsageCache();
    setSystemTime(T0);
  });
  afterEach(() => {
    clearUsageCache();
    setSystemTime();
  });

  test("serves a fresh entry without loading again", async () => {
    const source = loader(["a", "b"]);
    expect(await cachedUsageReport("k", source.load)).toBe("a");
    setSystemTime(new Date(T0.getTime() + USAGE_CACHE_TTL_MS - 1));
    expect(await cachedUsageReport("k", source.load)).toBe("a");
    expect(source.calls()).toBe(1);
  });

  test("keeps keys apart", async () => {
    const source = loader(["a", "b"]);
    expect(await cachedUsageReport("one", source.load)).toBe("a");
    expect(await cachedUsageReport("two", source.load)).toBe("b");
    expect(source.calls()).toBe(2);
  });

  test("past the bucket it answers with the stale value and refreshes once in the background", async () => {
    const source = loader(["old", "new"]);
    await cachedUsageReport("k", source.load);

    setSystemTime(new Date(T0.getTime() + USAGE_CACHE_TTL_MS + 1));
    expect(await cachedUsageReport("k", source.load)).toBe("old");
    expect(await cachedUsageReport("k", source.load)).toBe("old");
    await settle();
    // One refresh served both stale reads.
    expect(source.calls()).toBe(2);
    expect(await cachedUsageReport("k", source.load)).toBe("new");
    expect(source.calls()).toBe(2);
  });

  test("a stale read does not wait for the refresh", async () => {
    let release: (value: string) => void = () => {};
    const slow = new Promise<string>((resolve) => {
      release = resolve;
    });
    await cachedUsageReport("k", async () => "old");

    setSystemTime(new Date(T0.getTime() + USAGE_CACHE_TTL_MS + 1));
    expect(await cachedUsageReport("k", () => slow)).toBe("old");
    release("new");
    await settle();
    expect(await cachedUsageReport("k", async () => "unused")).toBe("new");
  });

  test("blocks on a load once an entry is older than the stale limit", async () => {
    const source = loader(["old", "new"]);
    await cachedUsageReport("k", source.load);

    setSystemTime(new Date(T0.getTime() + USAGE_CACHE_MAX_STALE_MS + 1));
    expect(await cachedUsageReport("k", source.load)).toBe("new");
    expect(source.calls()).toBe(2);
  });

  test("concurrent misses share one load", async () => {
    let calls = 0;
    const load = async () => {
      calls++;
      await settle();
      return "shared";
    };
    const results = await Promise.all([
      cachedUsageReport("k", load),
      cachedUsageReport("k", load),
      cachedUsageReport("k", load),
    ]);
    expect(results).toEqual(["shared", "shared", "shared"]);
    expect(calls).toBe(1);
  });

  test("a failed background refresh keeps the stale value and the next read retries", async () => {
    await cachedUsageReport("k", async () => "old");
    setSystemTime(new Date(T0.getTime() + USAGE_CACHE_TTL_MS + 1));

    const original = console.error;
    console.error = () => {};
    try {
      expect(
        await cachedUsageReport("k", async () => {
          throw new Error("db busy");
        }),
      ).toBe("old");
      await settle();
    } finally {
      console.error = original;
    }

    expect(await cachedUsageReport("k", async () => "retried")).toBe("old");
    await settle();
    expect(await cachedUsageReport("k", async () => "unused")).toBe("retried");
  });

  test("a load with no stale value to fall back on rejects to the caller", async () => {
    await expect(
      cachedUsageReport("k", async () => {
        throw new Error("db busy");
      }),
    ).rejects.toThrow("db busy");
    // The failure is not cached.
    expect(await cachedUsageReport("k", async () => "ok")).toBe("ok");
  });

  test("clearing drops entries, and a load already running cannot write back", async () => {
    let release: (value: string) => void = () => {};
    const inFlight = new Promise<string>((resolve) => {
      release = resolve;
    });
    const pending = cachedUsageReport("k", () => inFlight);

    clearUsageCache();
    release("before-clear");
    expect(await pending).toBe("before-clear");

    // Nothing was stored, so the next read loads again.
    expect(await cachedUsageReport("k", async () => "after-clear")).toBe("after-clear");
  });

  test("evicts the oldest entry past the size cap", async () => {
    for (let i = 0; i < 100; i++) await cachedUsageReport(`k${i}`, async () => `v${i}`);
    await cachedUsageReport("extra", async () => "extra");

    let reloaded = false;
    await cachedUsageReport("k0", async () => {
      reloaded = true;
      return "v0-again";
    });
    expect(reloaded).toBe(true);
    let survivorReloaded = false;
    await cachedUsageReport("k99", async () => {
      survivorReloaded = true;
      return "unused";
    });
    expect(survivorReloaded).toBe(false);
  });
});
