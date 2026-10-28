import { describe, expect, test } from "bun:test";
import { createListTotalCache } from "../http/list-total-cache";

function counter(values: number[]) {
  let calls = 0;
  return {
    compute: async () => values[Math.min(calls++, values.length - 1)]!,
    calls: () => calls,
  };
}

describe("list total cache", () => {
  test("page 1 always counts; later pages reuse its count", async () => {
    const cache = createListTotalCache();
    const count = counter([10, 11, 12]);

    expect(await cache.get({ q: "a" }, 0, count.compute)).toBe(10);
    expect(await cache.get({ q: "a" }, 25, count.compute)).toBe(10);
    expect(await cache.get({ q: "a" }, 50, count.compute)).toBe(10);
    expect(count.calls()).toBe(1);

    expect(await cache.get({ q: "a" }, undefined, count.compute)).toBe(11);
    expect(await cache.get({ q: "a" }, 25, count.compute)).toBe(11);
    expect(count.calls()).toBe(2);
  });

  test("a cold later page counts, so total is always set", async () => {
    const cache = createListTotalCache();
    const count = counter([7]);
    expect(await cache.get({ q: "b" }, 25, count.compute)).toBe(7);
    expect(await cache.get({ q: "b" }, 50, count.compute)).toBe(7);
    expect(count.calls()).toBe(1);
  });

  test("filter sets are keyed independently of key order", async () => {
    const cache = createListTotalCache();
    const count = counter([1, 2]);
    await cache.get({ status: "open", viewer: { userId: "u", scope: "all" } }, 0, count.compute);
    expect(
      await cache.get({ viewer: { scope: "all", userId: "u" }, status: "open" }, 25, count.compute),
    ).toBe(1);
    expect(await cache.get({ status: "done" }, 25, count.compute)).toBe(2);
    expect(count.calls()).toBe(2);
  });

  test("an entry expires after the TTL", async () => {
    const cache = createListTotalCache(1);
    const count = counter([1, 2]);
    await cache.get({}, 0, count.compute);
    await Bun.sleep(5);
    expect(await cache.get({}, 25, count.compute)).toBe(2);
  });

  test("a failed count is not cached", async () => {
    const cache = createListTotalCache();
    await expect(
      cache.get({}, 0, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(await cache.get({}, 25, async () => 3)).toBe(3);
  });
});
