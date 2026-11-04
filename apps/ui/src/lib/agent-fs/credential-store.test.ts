import { describe, expect, test } from "bun:test";
import {
  type AgentFsCredential,
  clearCredential,
  credentialSnapshot,
  credentialStorageKey,
  readCredential,
  subscribeCredential,
  writeCredential,
} from "./credential-store";

function memoryStorage() {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
    removeItem: (key: string) => void map.delete(key),
  };
}

const credential: AgentFsCredential = {
  apiKey: "af_test_0123456789abcdef",
  userId: "user-1",
  email: "human@example.com",
  displayName: "Human",
  connectedAt: "2026-09-30T00:00:00.000Z",
};

describe("credential store", () => {
  test("namespaces by swarm API URL and agent-fs URL", () => {
    expect(credentialStorageKey("https://swarm.a", "https://fs.one")).toBe(
      "swarm:v1:https://swarm.a:comb:agent-fs:https://fs.one",
    );
    const storage = memoryStorage();
    writeCredential("https://swarm.a", "https://fs.one", null, credential, storage);
    expect(readCredential("https://swarm.a", "https://fs.one", null, storage)).toEqual(credential);
    expect(readCredential("https://swarm.b", "https://fs.one", null, storage)).toBeNull();
    expect(readCredential("https://swarm.a", "https://fs.two", null, storage)).toBeNull();
  });

  test("malformed JSON and incomplete values read as null", () => {
    const storage = memoryStorage();
    const key = credentialStorageKey("https://swarm.a", "https://fs.one");
    for (const raw of ["{", "null", "[]", '"af_x"', JSON.stringify({ apiKey: "af_x" })]) {
      storage.map.set(key, raw);
      expect(readCredential("https://swarm.a", "https://fs.one", null, storage)).toBeNull();
    }
  });

  test("a missing displayName reads as null", () => {
    const storage = memoryStorage();
    const { displayName: _, ...rest } = credential;
    storage.map.set(
      credentialStorageKey("https://swarm.a", "https://fs.one"),
      JSON.stringify(rest),
    );
    expect(
      readCredential("https://swarm.a", "https://fs.one", null, storage)?.displayName,
    ).toBeNull();
  });

  test("clear removes only its own key", () => {
    const storage = memoryStorage();
    writeCredential("https://swarm.a", "https://fs.one", null, credential, storage);
    writeCredential("https://swarm.a", "https://fs.two", null, credential, storage);
    clearCredential("https://swarm.a", "https://fs.one", null, storage);
    expect(readCredential("https://swarm.a", "https://fs.one", null, storage)).toBeNull();
    expect(readCredential("https://swarm.a", "https://fs.two", null, storage)).toEqual(credential);
  });

  test("a throwing storage degrades to no credential", () => {
    const broken = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
      removeItem: () => {
        throw new Error("denied");
      },
    };
    expect(() => writeCredential("a", "b", null, credential, broken)).not.toThrow();
    expect(readCredential("a", "b", null, broken)).toBeNull();
    expect(() => clearCredential("a", "b", null, broken)).not.toThrow();
  });

  test("the snapshot keeps one object until the stored string changes", () => {
    const storage = memoryStorage();
    const snapshot = credentialSnapshot("https://swarm.a", "https://fs.one", null, storage);
    expect(snapshot()).toBeNull();
    writeCredential("https://swarm.a", "https://fs.one", null, credential, storage);
    const first = snapshot();
    expect(first).toEqual(credential);
    expect(snapshot()).toBe(first);
    writeCredential(
      "https://swarm.a",
      "https://fs.one",
      null,
      { ...credential, email: "b@x" },
      storage,
    );
    expect(snapshot()?.email).toBe("b@x");
    clearCredential("https://swarm.a", "https://fs.one", null, storage);
    expect(snapshot()).toBeNull();
  });
});

describe("credential owner (dashboard user)", () => {
  const API = "https://swarm.a";
  const FS = "https://fs.one";
  const alice = { userId: "u-alice", email: "Human@Example.com" };
  const bob = { userId: "u-bob", email: "bob@example.com" };

  test("each dashboard user has their own key", () => {
    expect(credentialStorageKey(API, FS, alice)).toBe(
      "swarm:v1:https://swarm.a:comb:agent-fs:https://fs.one:user:u-alice",
    );
    const storage = memoryStorage();
    writeCredential(API, FS, alice, credential, storage);
    expect(readCredential(API, FS, alice, storage)).toEqual(credential);
    expect(readCredential(API, FS, bob, storage)).toBeNull();
  });

  test("a legacy credential keeps working for its owner only (email match)", () => {
    const storage = memoryStorage();
    writeCredential(API, FS, null, credential, storage);
    expect(readCredential(API, FS, alice, storage)).toEqual(credential);
    expect(readCredential(API, FS, bob, storage)).toBeNull();
    expect(readCredential(API, FS, { userId: "u-x", email: null }, storage)).toBeNull();
  });

  test("an owned legacy credential moves to the owner's key on first read", () => {
    const storage = memoryStorage();
    writeCredential(API, FS, null, credential, storage);
    expect(readCredential(API, FS, alice, storage)).toEqual(credential);
    expect(storage.map.has(credentialStorageKey(API, FS))).toBe(false);
    expect(storage.map.has(credentialStorageKey(API, FS, alice))).toBe(true);
    expect(readCredential(API, FS, alice, storage)).toEqual(credential);
  });

  test("the owner's own key wins over the legacy one", () => {
    const storage = memoryStorage();
    storage.map.set(credentialStorageKey(API, FS), JSON.stringify(credential));
    const fresh = { ...credential, apiKey: "af_fresh_0123456789" };
    storage.map.set(credentialStorageKey(API, FS, alice), JSON.stringify(fresh));
    expect(readCredential(API, FS, alice, storage)?.apiKey).toBe("af_fresh_0123456789");
  });

  test("a write or clear by the owner removes the owned legacy key, never another user's", () => {
    const storage = memoryStorage();
    writeCredential(API, FS, null, credential, storage);
    writeCredential(API, FS, bob, { ...credential, email: "bob@example.com" }, storage);
    expect(storage.map.has(credentialStorageKey(API, FS))).toBe(true);

    clearCredential(API, FS, alice, storage);
    expect(storage.map.has(credentialStorageKey(API, FS))).toBe(false);
    expect(readCredential(API, FS, alice, storage)).toBeNull();

    writeCredential(API, FS, null, credential, storage);
    writeCredential(API, FS, alice, credential, storage);
    expect(storage.map.has(credentialStorageKey(API, FS))).toBe(false);
    expect(readCredential(API, FS, alice, storage)).toEqual(credential);
  });

  test("the owner subscription also follows the legacy key", () => {
    const target = new EventTarget();
    let calls = 0;
    const stop = subscribeCredential(API, FS, alice, () => calls++, target);
    target.dispatchEvent(
      Object.assign(new Event("storage"), { key: credentialStorageKey(API, FS) }),
    );
    target.dispatchEvent(
      Object.assign(new Event("storage"), { key: credentialStorageKey(API, FS, alice) }),
    );
    target.dispatchEvent(
      Object.assign(new Event("storage"), { key: credentialStorageKey(API, FS, bob) }),
    );
    expect(calls).toBe(2);
    stop();
  });
});

describe("subscribeCredential", () => {
  const ownKey = credentialStorageKey("https://swarm.a", "https://fs.one");

  function storageEvent(key: string | null): Event {
    return Object.assign(new Event("storage"), { key });
  }

  test("other tabs: own key fires, a foreign key is ignored, clear() fires", () => {
    const target = new EventTarget();
    let calls = 0;
    const stop = subscribeCredential(
      "https://swarm.a",
      "https://fs.one",
      null,
      () => calls++,
      target,
    );

    target.dispatchEvent(storageEvent(ownKey));
    expect(calls).toBe(1);
    target.dispatchEvent(storageEvent(credentialStorageKey("https://swarm.a", "https://fs.two")));
    target.dispatchEvent(storageEvent("agent-swarm-query-cache-v1"));
    expect(calls).toBe(1);
    // `localStorage.clear()` in another tab sends `key: null`.
    target.dispatchEvent(storageEvent(null));
    expect(calls).toBe(2);

    stop();
    target.dispatchEvent(storageEvent(ownKey));
    expect(calls).toBe(2);
  });

  test("this tab: writes and clears of its own key fire", () => {
    const storage = memoryStorage();
    let calls = 0;
    const stop = subscribeCredential(
      "https://swarm.a",
      "https://fs.one",
      null,
      () => calls++,
      null,
    );

    writeCredential("https://swarm.a", "https://fs.one", null, credential, storage);
    expect(calls).toBe(1);
    writeCredential("https://swarm.a", "https://fs.two", null, credential, storage);
    expect(calls).toBe(1);
    clearCredential("https://swarm.a", "https://fs.one", null, storage);
    expect(calls).toBe(2);

    stop();
    writeCredential("https://swarm.a", "https://fs.one", null, credential, storage);
    expect(calls).toBe(2);
  });
});
