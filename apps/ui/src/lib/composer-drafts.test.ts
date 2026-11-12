import { describe, expect, test } from "bun:test";
import { DRAFT_MAX_AGE_MS } from "./comb/drafts";
import { createDraftStore } from "./composer-drafts";

function memoryStorage() {
  const items = new Map<string, string>();
  return {
    items,
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => void items.set(key, value),
    removeItem: (key: string) => void items.delete(key),
  };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("composer drafts store", () => {
  test("saves after the debounce, not on each keystroke", async () => {
    const storage = memoryStorage();
    const store = createDraftStore(storage, { saveDelayMs: 20 });
    store.set("k", "h");
    store.set("k", "hi");
    expect(store.get("k")).toBe("hi");
    expect(storage.items.has("k")).toBe(false);
    await sleep(40);
    expect(JSON.parse(storage.items.get("k") ?? "{}").text).toBe("hi");
  });

  test("a new store (a reload) reads the saved text", async () => {
    const storage = memoryStorage();
    createDraftStore(storage, { saveDelayMs: 1 }).set("k", "kept");
    await sleep(10);
    expect(createDraftStore(storage).get("k")).toBe("kept");
  });

  test("flush writes pending saves at once (the page hides)", () => {
    const storage = memoryStorage();
    const store = createDraftStore(storage, { saveDelayMs: 10_000 });
    store.set("k", "typed");
    store.flush();
    expect(JSON.parse(storage.items.get("k") ?? "{}").text).toBe("typed");
  });

  test("an emptied box and clear() drop the saved draft at once", async () => {
    const storage = memoryStorage();
    const store = createDraftStore(storage, { saveDelayMs: 1 });
    store.set("k", "sent soon");
    await sleep(10);
    store.set("k", "");
    expect(storage.items.has("k")).toBe(false);
    store.set("k", "again");
    store.clear("k");
    await sleep(10);
    expect(storage.items.has("k")).toBe(false);
    expect(store.get("k")).toBe("");
  });

  test("drops a draft older than 7 days", () => {
    const storage = memoryStorage();
    storage.setItem("k", JSON.stringify({ text: "old", savedAt: 0 }));
    const store = createDraftStore(storage, { now: () => DRAFT_MAX_AGE_MS + 1 });
    expect(store.get("k")).toBe("");
    expect(storage.items.has("k")).toBe(false);
  });

  test("another tab's write reaches subscribers, unless this tab has a pending save", () => {
    const storage = memoryStorage();
    const store = createDraftStore(storage, { saveDelayMs: 10_000 });
    let calls = 0;
    store.subscribe("k", () => calls++);
    expect(store.get("k")).toBe("");
    storage.setItem("k", JSON.stringify({ text: "from tab 2", savedAt: Date.now() }));
    store.external("k");
    expect(store.get("k")).toBe("from tab 2");
    expect(calls).toBe(1);
    // This tab typed after: its pending save wins (last write wins).
    store.set("k", "mine");
    storage.setItem("k", JSON.stringify({ text: "tab 2 again", savedAt: Date.now() }));
    store.external("k");
    expect(store.get("k")).toBe("mine");
  });

  test("a key nobody reads ignores other tabs", () => {
    const store = createDraftStore(memoryStorage());
    let calls = 0;
    store.subscribe("other", () => calls++);
    store.external("other");
    expect(calls).toBe(0);
  });
});
