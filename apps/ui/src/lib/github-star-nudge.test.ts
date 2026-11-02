import { describe, expect, test } from "bun:test";
import { markStarNudgeDone, recordPromptSent } from "./github-star-nudge";

const API = "https://api.example.test";

type TestStorage = Parameters<typeof recordPromptSent>[1];

function memoryStorage(): TestStorage {
  const map = new Map<string, string>();
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
  };
}

function sends(n: number, storage: TestStorage, apiUrl = API): boolean[] {
  return Array.from({ length: n }, () => recordPromptSent(apiUrl, storage));
}

describe("github star nudge", () => {
  test("shows on the 5th successful send, not before", () => {
    const storage = memoryStorage();
    expect(sends(5, storage)).toEqual([false, false, false, false, true]);
  });

  test("never shows again after the user closes it or clicks the button", () => {
    const storage = memoryStorage();
    expect(sends(5, storage).at(-1)).toBe(true);
    markStarNudgeDone(API, storage);
    expect(sends(10, storage).some(Boolean)).toBe(false);
  });

  test("an ignored notice comes back on the next send until it is closed", () => {
    const storage = memoryStorage();
    expect(sends(7, storage).slice(4)).toEqual([true, true, true]);
  });

  test("counts per API URL", () => {
    const storage = memoryStorage();
    sends(4, storage);
    expect(sends(4, storage, "https://other.example.test").some(Boolean)).toBe(false);
    expect(recordPromptSent(API, storage)).toBe(true);
    markStarNudgeDone(API, storage);
    expect(recordPromptSent("https://other.example.test", storage)).toBe(true);
  });

  test("a corrupt counter restarts from zero", () => {
    const storage = memoryStorage();
    storage.setItem(`swarm:v1:${API}:github-star-nudge:prompts`, "garbage");
    expect(sends(5, storage)).toEqual([false, false, false, false, true]);
  });

  test("broken storage never throws and never shows", () => {
    const broken: TestStorage = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
    };
    expect(sends(6, broken).some(Boolean)).toBe(false);
    expect(() => markStarNudgeDone(API, broken)).not.toThrow();
  });
});
