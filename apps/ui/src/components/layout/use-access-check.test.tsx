import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";

GlobalRegistrator.register();
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const { createRoot } = await import("react-dom/client");
afterAll(async () => {
  await GlobalRegistrator.unregister();
});

const CONFIG = { apiUrl: "https://swarm.acme.com", apiKey: "aswt_abcd1234" }; // gitleaks:allow (fake test key)
let answer: "accepted" | "rejected" | "offline" = "rejected";
let checks = 0;

mock.module("@/hooks/use-config", () => ({ useConfig: () => ({ config: CONFIG }) }));
mock.module("@/api/client", () => ({
  api: {
    checkAccess: async () => {
      checks += 1;
      if (answer === "offline") throw new Error("Failed to fetch");
      return answer;
    },
  },
}));
// The real module: a root `bun test` does not resolve the `@/` alias by itself.
mock.module("@/api/access-rejection", () => require("../../api/access-rejection"));

const { useAccessCheck } = await import("./use-access-check");
const { accessId, noteUnauthorized, setAccessEnded } = await import("../../api/access-rejection");

const ID = accessId(CONFIG);
const BEARER = { Authorization: `Bearer ${CONFIG.apiKey}` };
let state: ReturnType<typeof useAccessCheck> | null = null;
let invalidations = 0;
let root: ReturnType<typeof createRoot> | null = null;

function Probe() {
  state = useAccessCheck();
  return null;
}

async function mount() {
  const client = new QueryClient();
  const invalidate = client.invalidateQueries.bind(client);
  client.invalidateQueries = ((...args: Parameters<typeof invalidate>) => {
    invalidations += 1;
    return invalidate(...args);
  }) as typeof client.invalidateQueries;
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () =>
    root?.render(
      <QueryClientProvider client={client}>
        <Probe />
      </QueryClientProvider>,
    ),
  );
}

/** Report 401s from the API, then let the debounced check run. */
async function rejectBurst(count = 1) {
  for (let i = 0; i < count; i++) {
    noteUnauthorized(`${CONFIG.apiUrl}/api/tasks`, BEARER, CONFIG, "http://localhost:5274");
  }
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 300));
  });
}

beforeEach(() => {
  answer = "rejected";
  checks = 0;
  invalidations = 0;
  setAccessEnded(ID, false);
});

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  state = null;
});

describe("useAccessCheck", () => {
  test("a burst of 401s runs one check, and a rejected check ends access", async () => {
    await mount();
    expect(state?.ended).toBe(false);
    await rejectBurst(5);
    expect(checks).toBe(1);
    expect(state?.ended).toBe(true);
  });

  test("a 401 the check does not confirm leaves the shell alone", async () => {
    answer = "accepted";
    await mount();
    await rejectBurst();
    expect(checks).toBe(1);
    expect(state?.ended).toBe(false);
    expect(invalidations).toBe(0);
  });

  test("a network failure keeps the current state", async () => {
    answer = "offline";
    await mount();
    await rejectBurst();
    expect(state?.ended).toBe(false);
  });

  test("Try again brings the shell back once the key works, and refetches", async () => {
    await mount();
    await rejectBurst();
    expect(state?.ended).toBe(true);
    answer = "accepted";
    await act(async () => {
      state?.retry();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(state?.ended).toBe(false);
    expect(invalidations).toBe(1);
  });

  test("a return to the tab checks again while access is ended", async () => {
    await mount();
    await rejectBurst();
    answer = "accepted";
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(checks).toBe(2);
    expect(state?.ended).toBe(false);
  });

  test("401s of another connection are not this one's", async () => {
    await mount();
    noteUnauthorized(
      "https://other.example/api/tasks",
      { Authorization: "Bearer other-key" },
      { apiUrl: "https://other.example", apiKey: "other-key" },
      "http://localhost:5274",
    );
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 300));
    });
    expect(checks).toBe(0);
  });
});
