import { afterAll, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";

GlobalRegistrator.register();
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
afterAll(async () => {
  await GlobalRegistrator.unregister();
});

let apiUrl = "http://sidebar-identity.test";
let identity: { userId: string | null; state: "pending" | "needs-pick" | "ready" } = {
  userId: null,
  state: "pending",
};
mock.module("./use-config", () => ({ useConfig: () => ({ config: { apiUrl } }) }));
mock.module("@/contexts/current-user-context", () => ({ useCurrentUser: () => identity }));
mock.module("@/lib/app-sidebar-preferences", () => require("../lib/app-sidebar-preferences"));

const { createRoot } = await import("react-dom/client");
const { useAppSidebarPreferences } = await import("./use-app-sidebar-preferences");
const { appSidebarStorageKey } = await import("../lib/app-sidebar-preferences");
let latest: ReturnType<typeof useAppSidebarPreferences>;
function Probe() {
  latest = useAppSidebarPreferences();
  return (
    <button type="button" disabled={!latest.isReady}>
      {latest.preferences.mode}
    </button>
  );
}

test("pending identity and swarm switches cannot write anonymous preferences", async () => {
  const host = document.createElement("div");
  const root = createRoot(host);
  const render = () =>
    act(async () => {
      root.render(<Probe />);
    });
  const write = () =>
    act(async () => {
      latest.setPreferences({ mode: "hidden", selectedIds: [] });
    });
  try {
    await render();
    expect(host.querySelector("button")?.disabled).toBe(true);
    await write();
    expect(localStorage.getItem(appSidebarStorageKey(apiUrl, null))).toBeNull();
    identity = { userId: "alice", state: "ready" };
    await render();
    expect(host.querySelector("button")?.disabled).toBe(false);
    await write();
    expect(latest.preferences.mode).toBe("hidden");

    apiUrl = "http://second-sidebar-swarm.test";
    identity = { userId: null, state: "pending" };
    await render();
    await write();
    expect(localStorage.getItem(appSidebarStorageKey(apiUrl, null))).toBeNull();
    identity = { userId: "bob", state: "ready" };
    await render();
    expect(latest.preferences.mode).toBe("all");
    await write();
    expect(
      JSON.parse(localStorage.getItem(appSidebarStorageKey(apiUrl, "bob")) ?? "null").mode,
    ).toBe("hidden");
  } finally {
    await act(async () => root.unmount());
    localStorage.clear();
  }
});
