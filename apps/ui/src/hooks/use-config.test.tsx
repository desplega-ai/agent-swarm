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

const { extractUrlParams, inspectPendingApiUrl, pendingApiUrlSubmissionError } = await import(
  "./use-config"
);

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

describe("inspectPendingApiUrl", () => {
  test("requires HTTPS for an arbitrary deep-link prefill", () => {
    expect(inspectPendingApiUrl("http://attacker.example/collect")).toEqual({
      origin: "http://attacker.example",
      allowed: false,
    });
    expect(inspectPendingApiUrl("https://swarm.example.test/api")).toEqual({
      origin: "https://swarm.example.test",
      allowed: true,
    });
  });

  test("allows HTTP only for loopback and private development addresses", () => {
    expect(inspectPendingApiUrl("http://localhost:3013").allowed).toBe(true);
    expect(inspectPendingApiUrl("http://127.0.0.1:3013").allowed).toBe(true);
    expect(inspectPendingApiUrl("http://10.0.0.5:3013").allowed).toBe(true);
    expect(inspectPendingApiUrl("http://172.31.0.5:3013").allowed).toBe(true);
    expect(inspectPendingApiUrl("http://192.168.1.5:3013").allowed).toBe(true);
    expect(inspectPendingApiUrl("http://8.8.8.8:3013").allowed).toBe(false);
  });

  test("blocks credential submission until an allowed deep-link origin is confirmed", () => {
    expect(pendingApiUrlSubmissionError("https://swarm.example.test", false)).toBe(
      "Confirm the destination before sending your API key.",
    );
    expect(pendingApiUrlSubmissionError("https://swarm.example.test", true)).toBeNull();
    expect(pendingApiUrlSubmissionError("http://attacker.example", true)).toBe(
      "Deep-linked API URLs must use HTTPS, except for private or loopback addresses.",
    );
  });
});
