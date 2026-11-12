import { describe, expect, test } from "bun:test";
import {
  DISMISSED_MAX,
  dismissedStorageKey,
  readDismissed,
  withDismissed,
  withoutDismissed,
  writeDismissed,
} from "./dismissed";

function memoryStorage() {
  const map = new Map<string, string>();
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
    removeItem: (key: string) => void map.delete(key),
  };
}

describe("dismissed sends", () => {
  test("dismiss adds each id once, newest last; restore removes only the given ids", () => {
    let list = withDismissed([], ["a", "b"]);
    list = withDismissed(list, ["a", "c", "c"]);
    expect(list).toEqual(["b", "a", "c"]);
    expect(withoutDismissed(list, ["a", "x"])).toEqual(["b", "c"]);
  });

  test("keeps at most DISMISSED_MAX ids, dropping the oldest", () => {
    const ids = Array.from({ length: DISMISSED_MAX + 2 }, (_, i) => `id-${i}`);
    const list = withDismissed([], ids);
    expect(list).toHaveLength(DISMISSED_MAX);
    expect(list[0]).toBe("id-2");
    expect(list.at(-1)).toBe(`id-${DISMISSED_MAX + 1}`);
  });

  test("one key per swarm, user, and drive", () => {
    const drive = { orgId: "o", driveId: "d" };
    const key = dismissedStorageKey("https://a", "u1", drive);
    expect(key).not.toBe(dismissedStorageKey("https://b", "u1", drive));
    expect(key).not.toBe(dismissedStorageKey("https://a", "u2", drive));
    expect(key).not.toBe(dismissedStorageKey("https://a", "u1", { orgId: "o", driveId: "e" }));
  });

  test("round-trips through storage; anything unreadable reads as empty", () => {
    const storage = memoryStorage();
    writeDismissed(storage, "k", ["a", "b"]);
    expect(readDismissed(storage, "k")).toEqual(["a", "b"]);
    storage.setItem("k", "{not json");
    expect(readDismissed(storage, "k")).toEqual([]);
    storage.setItem("k", JSON.stringify({ a: 1 }));
    expect(readDismissed(storage, "k")).toEqual([]);
    storage.setItem("k", JSON.stringify(["a", 3, null, "b"]));
    expect(readDismissed(storage, "k")).toEqual(["a", "b"]);
    expect(readDismissed(null, "k")).toEqual([]);
  });
});
