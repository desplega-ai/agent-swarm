import { afterEach, describe, expect, mock, test } from "bun:test";

// The root `bun test` runner maps `@/*` to the API server's `src/*`, so every
// runtime `@/…` import reachable from use-config.ts has to be mocked here or
// the file fails to resolve outside Vite.
mock.module("@/lib/deployment-config", () => ({
  uiDeploymentConfig: { apiUrl: null, apiKey: null, userId: null, demoMode: false },
  isDemoMode: false,
}));

mock.module("@/lib/config", () => ({
  addConnection: () => {
    throw new Error("not used in this test");
  },
  getActiveConnection: () => null,
  getConnections: () => [],
  getDefaultConfig: () => ({ apiUrl: "http://localhost:3013", apiKey: "" }),
  isUserTokenApiKey: () => false,
  removeConnection: () => false,
  resetConfig: () => {},
  saveConfig: () => {},
  setActiveConnection: () => false,
  setEmbedConnection: () => {},
  updateConnection: () => null,
}));

const { extractUrlParams } = await import("./use-config");

const originalWindow = globalThis.window;

afterEach(() => {
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: originalWindow,
  });
});

describe("extractUrlParams", () => {
  test("keeps an apiUrl-only deep link as a welcome-form hint", () => {
    const replaceState = mock(() => {});
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        history: { replaceState },
        location: {
          href: "https://app.agent-swarm.dev/?apiUrl=https%3A%2F%2Fswarm.example.test%2F",
          search: "?apiUrl=https%3A%2F%2Fswarm.example.test%2F",
        },
      },
    });

    const result = extractUrlParams([], () => {});

    expect(result.pendingApiUrl).toBe("https://swarm.example.test");
    expect(result.pendingConnection).toBeNull();
    expect(replaceState).toHaveBeenCalledWith({}, "", "https://app.agent-swarm.dev/");
  });
});
