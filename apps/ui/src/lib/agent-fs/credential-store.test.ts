import { describe, expect, test } from "bun:test";
import {
  type AgentFsCredential,
  clearCredential,
  credentialStorageKey,
  readCredential,
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
    writeCredential("https://swarm.a", "https://fs.one", credential, storage);
    expect(readCredential("https://swarm.a", "https://fs.one", storage)).toEqual(credential);
    expect(readCredential("https://swarm.b", "https://fs.one", storage)).toBeNull();
    expect(readCredential("https://swarm.a", "https://fs.two", storage)).toBeNull();
  });

  test("malformed JSON and incomplete values read as null", () => {
    const storage = memoryStorage();
    const key = credentialStorageKey("https://swarm.a", "https://fs.one");
    for (const raw of ["{", "null", "[]", '"af_x"', JSON.stringify({ apiKey: "af_x" })]) {
      storage.map.set(key, raw);
      expect(readCredential("https://swarm.a", "https://fs.one", storage)).toBeNull();
    }
  });

  test("a missing displayName reads as null", () => {
    const storage = memoryStorage();
    const { displayName: _, ...rest } = credential;
    storage.map.set(
      credentialStorageKey("https://swarm.a", "https://fs.one"),
      JSON.stringify(rest),
    );
    expect(readCredential("https://swarm.a", "https://fs.one", storage)?.displayName).toBeNull();
  });

  test("clear removes only its own key", () => {
    const storage = memoryStorage();
    writeCredential("https://swarm.a", "https://fs.one", credential, storage);
    writeCredential("https://swarm.a", "https://fs.two", credential, storage);
    clearCredential("https://swarm.a", "https://fs.one", storage);
    expect(readCredential("https://swarm.a", "https://fs.one", storage)).toBeNull();
    expect(readCredential("https://swarm.a", "https://fs.two", storage)).toEqual(credential);
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
    expect(() => writeCredential("a", "b", credential, broken)).not.toThrow();
    expect(readCredential("a", "b", broken)).toBeNull();
    expect(() => clearCredential("a", "b", broken)).not.toThrow();
  });
});
