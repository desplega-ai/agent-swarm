import { describe, expect, test } from "bun:test";
import {
  appSidebarStorageKey,
  createAppSidebarStore,
  parseAppSidebarPreferences,
  visibleSidebarApps,
} from "./app-sidebar-preferences";

const apps = [
  { id: "b", name: "Zebra" },
  { id: "a", name: "Alpha" },
];

describe("app sidebar preferences", () => {
  test("defaults to all apps and rejects malformed stored settings", () => {
    for (const raw of [null, "not json", "null", "[]", '{"mode":"bad"}']) {
      expect(parseAppSidebarPreferences(raw)).toEqual({ mode: "all", selectedIds: [] });
    }
    expect(
      parseAppSidebarPreferences('{"mode":"selected","selectedIds":["b",null,"b",3]}'),
    ).toEqual({ mode: "selected", selectedIds: ["b"] });
  });

  test("all mode includes new apps, selected mode ignores deleted ids, hidden lists none", () => {
    expect(visibleSidebarApps(apps, { mode: "all", selectedIds: [] }).map((a) => a.id)).toEqual([
      "a",
      "b",
    ]);
    expect(visibleSidebarApps(apps, { mode: "selected", selectedIds: ["b", "deleted"] })).toEqual([
      apps[0],
    ]);
    expect(visibleSidebarApps(apps, { mode: "selected", selectedIds: [] })).toEqual([]);
    expect(visibleSidebarApps(apps, { mode: "hidden", selectedIds: ["a"] })).toEqual([]);
    expect(apps[0].id).toBe("b");
  });

  test("isolates deployments and identities, normalizing trailing slashes", () => {
    expect(appSidebarStorageKey("https://a/", "alice")).toBe(
      appSidebarStorageKey("https://a", "alice"),
    );
    expect(appSidebarStorageKey("https://a", "alice")).not.toBe(
      appSidebarStorageKey("https://b", "alice"),
    );
    expect(appSidebarStorageKey("https://a", "alice")).not.toBe(
      appSidebarStorageKey("https://a", "bob"),
    );
    expect(appSidebarStorageKey("https://a", null)).not.toBe(
      appSidebarStorageKey("https://a", "null"),
    );
  });

  test("persists settings and notifies every subscriber with stable snapshots", () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        values.set(key, value);
      },
    };
    const store = createAppSidebarStore("prefs", storage);
    expect(store.getSnapshot()).toBe(store.getSnapshot());
    let calls = 0;
    const unsubscribe = store.subscribe(() => {
      calls++;
    });
    store.set({ mode: "selected", selectedIds: ["a"] });
    expect(calls).toBe(1);
    expect(createAppSidebarStore("prefs", storage).getSnapshot()).toEqual({
      mode: "selected",
      selectedIds: ["a"],
    });
    values.delete("prefs");
    store.receive(null);
    expect(store.getSnapshot().mode).toBe("all");
    expect(calls).toBe(2);
    unsubscribe();
    store.set({ mode: "hidden", selectedIds: [] });
    expect(calls).toBe(2);
  });

  test("blocked browser storage still supports in-memory settings", () => {
    const blocked = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    };
    const store = createAppSidebarStore("blocked", blocked);
    store.set({ mode: "hidden", selectedIds: [] });
    expect(store.getSnapshot().mode).toBe("hidden");
  });

  test("reads changes made while a scope had no active subscribers", () => {
    let value: string | null = null;
    const store = createAppSidebarStore("prefs", {
      getItem: () => value,
      setItem: (_key, raw) => {
        value = raw;
      },
    });
    value = JSON.stringify({ mode: "selected", selectedIds: ["b"] });
    expect(store.getSnapshot()).toEqual({ mode: "selected", selectedIds: ["b"] });
    expect(store.getSnapshot()).toBe(store.getSnapshot());
  });

  test("quota errors retain the in-memory selection even when reads still work", () => {
    const store = createAppSidebarStore("prefs", {
      getItem: () => null,
      setItem: () => {
        throw new Error("quota");
      },
    });
    store.set({ mode: "hidden", selectedIds: [] });
    expect(store.getSnapshot().mode).toBe("hidden");
  });

  test("an inaccessible localStorage getter retains settings in memory", () => {
    const store = createAppSidebarStore("prefs");
    store.set({ mode: "selected", selectedIds: ["b"] });
    expect(store.getSnapshot()).toEqual({ mode: "selected", selectedIds: ["b"] });
  });
});
