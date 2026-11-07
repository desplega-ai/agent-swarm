import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { deriveStorageKey } from "../../hooks/use-dismissible-card-key";
import { CURRENT_USER_CARD_KEY } from "../dashboard-user";
import { paletteIdentity, paletteSearchKey } from "./identity";
import { pushRecent, readRecents } from "./recents";

GlobalRegistrator.register();
beforeEach(() => localStorage.clear());
afterAll(async () => {
  await GlobalRegistrator.unregister();
});

// Placeholder keys built at runtime, so secret scanners see no literal.
const fakeKey = (tail: string) => "k".repeat(12) + tail;
const swarm = { apiUrl: "http://swarm.test", apiKey: fakeKey("1234") };

/** Picks the dashboard user the way the identity picker stores it. */
function pick(userId: string) {
  localStorage.setItem(deriveStorageKey(swarm.apiUrl, CURRENT_USER_CARD_KEY), userId);
}

describe("palette identity", () => {
  test("recents are per user on the same swarm", () => {
    pick("user-a");
    pushRecent(swarm, { kind: "tasks", title: "Private task", href: "/tasks/a" });
    expect(readRecents(swarm).map((item) => item.href)).toEqual(["/tasks/a"]);
    pick("user-b");
    expect(readRecents(swarm)).toEqual([]);
  });

  test("recents are per swarm and per key", () => {
    pushRecent(swarm, { kind: "tasks", title: "Task", href: "/tasks/a" });
    expect(readRecents({ ...swarm, apiUrl: "http://other.test" })).toEqual([]);
    expect(readRecents({ ...swarm, apiKey: fakeKey("9876") })).toEqual([]);
  });

  test("search cache keys differ per user, swarm and key", () => {
    pick("user-a");
    const keyA = paletteSearchKey(swarm, "tasks", "deploy", 8);
    pick("user-b");
    const keyB = paletteSearchKey(swarm, "tasks", "deploy", 8);
    expect(keyA).not.toEqual(keyB);
    expect(
      paletteSearchKey({ ...swarm, apiUrl: "http://other.test" }, "tasks", "deploy", 8),
    ).not.toEqual(keyB);
    expect(
      paletteSearchKey({ ...swarm, apiKey: fakeKey("9876") }, "tasks", "deploy", 8),
    ).not.toEqual(keyB);
    // The raw key never lands in the cache key.
    expect(JSON.stringify(keyA)).not.toContain(swarm.apiKey);
  });

  test("keys sharing a swarm and last four characters stay apart", () => {
    // User-bound tokens carry no dashboard user, so only the key tells them apart.
    const first = { apiUrl: swarm.apiUrl, apiKey: `aswt_${"a".repeat(20)}9999` };
    const second = { apiUrl: swarm.apiUrl, apiKey: `aswt_${"b".repeat(20)}9999` };
    expect(paletteIdentity(first)).not.toEqual(paletteIdentity(second));
    expect(paletteSearchKey(first, "tasks", "deploy", 8)).not.toEqual(
      paletteSearchKey(second, "tasks", "deploy", 8),
    );
    pushRecent(first, { kind: "tasks", title: "Private task", href: "/tasks/a" });
    expect(readRecents(second)).toEqual([]);
    // Neither the key nor its tail lands in an identity or a storage key name.
    expect(paletteIdentity(first)).not.toContain(first.apiKey.slice(-4));
    expect(Object.keys(localStorage).join("\n")).not.toContain(first.apiKey.slice(-4));
  });
});
