import { describe, expect, test } from "bun:test";
import {
  DISMISSED_BUILD_ID_STORAGE_KEY,
  isChunkLoadError,
  parseBuildId,
  readDismissedBuildId,
  shouldPromptForVersion,
  writeDismissedBuildId,
} from "./app-version";

function memoryStorage() {
  const data = new Map<string, string>();
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => {
      data.set(key, value);
    },
  };
}

const throwingStorage = {
  getItem: (): string | null => {
    throw new Error("SecurityError");
  },
  setItem: () => {
    throw new Error("QuotaExceededError");
  },
};

describe("parseBuildId", () => {
  test("reads a non-empty buildId string", () => {
    expect(parseBuildId({ buildId: "abc123" })).toBe("abc123");
    expect(parseBuildId({ buildId: "  abc123 " })).toBe("abc123");
  });

  test("rejects anything else", () => {
    expect(parseBuildId(null)).toBeNull();
    expect(parseBuildId("abc123")).toBeNull();
    expect(parseBuildId({})).toBeNull();
    expect(parseBuildId({ buildId: "" })).toBeNull();
    expect(parseBuildId({ buildId: 42 })).toBeNull();
  });
});

describe("shouldPromptForVersion", () => {
  test("prompts when the deployed build differs from the running one", () => {
    expect(shouldPromptForVersion({ running: "a", deployed: "b", dismissed: null })).toBe(true);
  });

  test("stays quiet when the builds match", () => {
    expect(shouldPromptForVersion({ running: "a", deployed: "a", dismissed: null })).toBe(false);
  });

  test("a dismissal silences that deployed build only", () => {
    expect(shouldPromptForVersion({ running: "a", deployed: "b", dismissed: "b" })).toBe(false);
    expect(shouldPromptForVersion({ running: "a", deployed: "c", dismissed: "b" })).toBe(true);
  });

  test("never prompts without both ids (dev server, failed fetch)", () => {
    expect(shouldPromptForVersion({ running: null, deployed: "b", dismissed: null })).toBe(false);
    expect(shouldPromptForVersion({ running: "a", deployed: null, dismissed: null })).toBe(false);
  });
});

describe("dismissed build id storage", () => {
  test("round-trips through storage under a stable key", () => {
    const storage = memoryStorage();
    expect(readDismissedBuildId(storage)).toBeNull();
    writeDismissedBuildId(storage, "b");
    expect(readDismissedBuildId(storage)).toBe("b");
    expect(storage.getItem(DISMISSED_BUILD_ID_STORAGE_KEY)).toBe("b");
  });

  test("dismissing once keeps the same deployed build quiet on every later check", () => {
    const storage = memoryStorage();
    writeDismissedBuildId(storage, "b");
    for (let poll = 0; poll < 5; poll++) {
      expect(
        shouldPromptForVersion({
          running: "a",
          deployed: "b",
          dismissed: readDismissedBuildId(storage),
        }),
      ).toBe(false);
    }
  });

  test("tolerates storage that throws or is missing", () => {
    expect(readDismissedBuildId(throwingStorage)).toBeNull();
    expect(() => writeDismissedBuildId(throwingStorage, "b")).not.toThrow();
    expect(readDismissedBuildId(undefined)).toBeNull();
  });
});

describe("isChunkLoadError", () => {
  test("matches the MIME-type error from a missing chunk served as index.html", () => {
    const error = new TypeError(
      "'text/html' is not a valid JavaScript MIME type for module script 'https://app.agent-swarm.dev/assets/usage-content-BlbcrqtL.js'",
    );
    expect(isChunkLoadError(error)).toBe(true);
  });

  test("matches each browser's failed dynamic import message", () => {
    for (const message of [
      "Failed to fetch dynamically imported module: https://app.agent-swarm.dev/assets/page-x.js",
      "error loading dynamically imported module: https://app.agent-swarm.dev/assets/page-x.js",
      "Importing a module script failed.",
      "Failed to load module script: Expected a JavaScript module script",
      "Unable to preload CSS for /assets/page-x.css",
      "Loading chunk 42 failed.",
      "Loading CSS chunk 7 failed.",
    ]) {
      expect(isChunkLoadError(new Error(message))).toBe(true);
    }
  });

  test("matches a ChunkLoadError by name", () => {
    const error = new Error("whatever");
    error.name = "ChunkLoadError";
    expect(isChunkLoadError(error)).toBe(true);
  });

  test("ignores ordinary render errors and non-errors", () => {
    expect(isChunkLoadError(new TypeError("Cannot read properties of undefined"))).toBe(false);
    expect(isChunkLoadError(new Error("Failed to fetch"))).toBe(false);
    expect(isChunkLoadError("Failed to fetch dynamically imported module")).toBe(false);
    expect(isChunkLoadError(null)).toBe(false);
  });
});
