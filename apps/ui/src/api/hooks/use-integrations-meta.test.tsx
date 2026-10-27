import { afterAll, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";

GlobalRegistrator.register();
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const { createRoot } = await import("react-dom/client");
mock.module("@/api/client", () => ({ api: {} }));
mock.module("@/api/hooks/status-query", () => ({ invalidateStatusQuery: async () => {} }));
mock.module("@/lib/config", () => ({
  getConfig: () => ({ apiUrl: "https://swarm.example", apiKey: "" }),
}));
mock.module("@/lib/env-presence-batch", () => require("../../lib/env-presence-batch"));
mock.module("sonner", () => ({ toast: { error: () => {} } }));
const { useEnvPresence } = await import("./use-integrations-meta");

afterAll(() => GlobalRegistrator.unregister());

test("a fresh tab asks the server even when the restored presence is still fresh", async () => {
  const requests: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string) => {
    requests.push(url);
    return new Response(JSON.stringify({ presence: { SWARM_ORG_NAME: false } }));
  }) as typeof fetch;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  // As another tab left it in the persisted cache one second ago, inside the 5 s staleTime.
  client.setQueryData(
    ["config", "env-presence", "SWARM_ORG_NAME"],
    { SWARM_ORG_NAME: false },
    {
      updatedAt: Date.now() - 1000,
    },
  );
  const mountedAt = Date.now();
  let updatedAt = 0;
  function Probe() {
    updatedAt = useEnvPresence(["SWARM_ORG_NAME"]).dataUpdatedAt;
    return null;
  }
  const root = createRoot(document.createElement("div"));
  try {
    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <Probe />
        </QueryClientProvider>,
      );
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(requests).toEqual(["https://swarm.example/api/config/env-presence?keys=SWARM_ORG_NAME"]);
    expect(updatedAt).toBeGreaterThanOrEqual(mountedAt);
  } finally {
    await act(async () => root.unmount());
    client.clear();
    globalThis.fetch = realFetch;
  }
});
