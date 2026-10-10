import { describe, expect, test } from "bun:test";
import { patchFavoriteFlag, readFavoriteFlag } from "./favorite-flag";

describe("patchFavoriteFlag", () => {
  test("flips the flag on a detail object", () => {
    expect(patchFavoriteFlag({ id: "w1", favorite: false, name: "a" }, "w1", true)).toEqual({
      id: "w1",
      favorite: true,
      name: "a",
    });
  });

  test("flips only the matching row of a list envelope", () => {
    const data = {
      workflows: [
        { id: "w1", favorite: false },
        { id: "w2", favorite: true },
      ],
      total: 2,
    };
    expect(patchFavoriteFlag(data, "w2", false)).toEqual({
      workflows: [
        { id: "w1", favorite: false },
        { id: "w2", favorite: false },
      ],
      total: 2,
    });
    // The snapshot taken for rollback stays untouched.
    expect(data.workflows[1]?.favorite).toBe(true);
  });

  test("flips a row in a bare array", () => {
    expect(patchFavoriteFlag([{ id: "p1", favorite: false }], "p1", true)).toEqual([
      { id: "p1", favorite: true },
    ]);
  });

  test("returns the same reference when nothing matches", () => {
    const data = { pages: [{ id: "p1", favorite: false }] };
    expect(patchFavoriteFlag(data, "other", true)).toBe(data);
    expect(patchFavoriteFlag(undefined, "p1", true)).toBeUndefined();
  });
});

describe("readFavoriteFlag", () => {
  test("reads the flag from a detail object, a row array, and a list envelope", () => {
    expect(readFavoriteFlag({ id: "w1", favorite: true }, "w1")).toBe(true);
    expect(readFavoriteFlag([{ id: "w1", favorite: false }], "w1")).toBe(false);
    expect(readFavoriteFlag({ pages: [{ id: "p1", favorite: true }], total: 1 }, "p1")).toBe(true);
    expect(readFavoriteFlag({ pages: [{ id: "p1", favorite: true }] }, "other")).toBeUndefined();
    expect(readFavoriteFlag(undefined, "p1")).toBeUndefined();
  });
});
