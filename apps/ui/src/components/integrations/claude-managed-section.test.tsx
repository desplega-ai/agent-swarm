import { afterAll, describe, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { SwarmConfig } from "@/api/types";

GlobalRegistrator.register();
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
afterAll(async () => {
  await GlobalRegistrator.unregister();
});

type TestResult = { ok: boolean; agentName?: string | null; error?: string };
let nextResult: () => Promise<TestResult> = async () => ({ ok: true });

mock.module("@/api/hooks/use-integrations-meta", () => ({
  useTestClaudeManagedConnection: () => ({
    isPending: false,
    mutateAsync: () => nextResult(),
  }),
}));
mock.module("@/lib/utils", () => require("../../lib/utils"));
mock.module("@/lib/integrations-catalog", () => require("../../lib/integrations-catalog"));
mock.module("@/lib/integrations-status", () => require("../../lib/integrations-status"));
mock.module("@/hooks/use-copy-to-clipboard", () => require("../../hooks/use-copy-to-clipboard"));
mock.module("@/components/shared/oauth-section", () => require("../shared/oauth-section"));
mock.module("@/components/ui/alert", () => require("../ui/alert"));
mock.module("@/components/ui/badge", () => require("../ui/badge"));
mock.module("@/components/ui/button", () => require("../ui/button"));

const { ClaudeManagedSection } = await import("./claude-managed-section");
const { INTEGRATIONS, getIntegrationFields } = await import("../../lib/integrations-catalog");

const def = INTEGRATIONS.find((d) => d.id === "claude-managed");
if (!def) throw new Error("claude-managed def missing from catalog");
const requiredKeys = getIntegrationFields(def)
  .filter((f) => f.required)
  .map((f) => f.key);
const allEnv = Object.fromEntries(requiredKeys.map((k) => [k, true]));

function row(key: string, lastUpdatedAt: string): SwarmConfig {
  return { id: key, scope: "global", key, value: "x", lastUpdatedAt } as SwarmConfig;
}

interface Snapshot {
  configs: SwarmConfig[];
  envPresence: Record<string, boolean>;
  envPresenceRevision: number;
}

async function mount(initial: Snapshot) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const render = (s: Snapshot) =>
    act(async () => {
      root.render(<ClaudeManagedSection def={def!} {...s} />);
    });
  await render(initial);
  return {
    host,
    render,
    clickTest: () =>
      act(async () => {
        Array.from(host.querySelectorAll("button"))
          .find((b) => b.textContent?.includes("Test connection"))
          ?.click();
      }),
    badges: () =>
      Array.from(host.querySelectorAll('[data-slot="badge"]')).map((b) => b.textContent),
    cleanup: async () => {
      await act(async () => root.unmount());
      host.remove();
    },
  };
}

describe("ClaudeManagedSection test-result freshness", () => {
  test.each([
    [true, "Connected"],
    [false, "Test failed"],
  ])("ok=%p: an env-presence refetch with equal booleans and the same object retires %p", async (ok, label) => {
    nextResult = async () => (ok ? { ok, agentName: "a" } : { ok, error: "boom" });
    // React Query's structural sharing hands back the same object for an equal
    // payload, so only the query revision tells a fresh response apart.
    const snap = { configs: [], envPresence: allEnv, envPresenceRevision: 1 };
    const view = await mount(snap);
    await view.clickTest();
    expect(view.badges()).toContain(label);

    await view.render({ ...snap });
    expect(view.badges()).toContain(label);

    await view.render({ ...snap, envPresenceRevision: 2 });
    expect(view.badges()).not.toContain(label);
    expect(view.host.textContent).toContain("Last test");
    await view.cleanup();
  });

  test("a new env-presence object with equal booleans retires the result", async () => {
    nextResult = async () => ({ ok: true, agentName: "a" });
    const view = await mount({ configs: [], envPresence: allEnv, envPresenceRevision: 1 });
    await view.clickTest();
    expect(view.badges()).toContain("Connected");
    await view.render({ configs: [], envPresence: { ...allEnv }, envPresenceRevision: 1 });
    expect(view.badges()).not.toContain("Connected");
    await view.cleanup();
  });

  test.each([
    "managed_agent_id",
    "anthropic_api_key",
    "managed_environment_id",
  ])("a CLI-written lowercase %p update retires the result", async (key) => {
    nextResult = async () => ({ ok: true, agentName: "a" });
    const env = { ...allEnv, [key.toUpperCase()]: false };
    const view = await mount({
      configs: [row(key, "one")],
      envPresence: env,
      envPresenceRevision: 1,
    });
    await view.clickTest();
    expect(view.badges()).toContain("Connected");
    await view.render({ configs: [row(key, "two")], envPresence: env, envPresenceRevision: 1 });
    expect(view.badges()).not.toContain("Connected");
    await view.cleanup();
  });

  test("a row-backed result survives an env-presence refetch", async () => {
    nextResult = async () => ({ ok: true, agentName: "a" });
    const configs = requiredKeys.map((k) => row(k, "one"));
    const view = await mount({ configs, envPresence: {}, envPresenceRevision: 1 });
    await view.clickTest();
    await view.render({ configs, envPresence: {}, envPresenceRevision: 2 });
    expect(view.badges()).toContain("Connected");
    await view.render({
      configs: configs.map((c) => (c.key === "MANAGED_AGENT_ID" ? row(c.key, "two") : c)),
      envPresence: {},
      envPresenceRevision: 2,
    });
    expect(view.badges()).not.toContain("Connected");
    await view.cleanup();
  });

  test("a config edit while the test is in flight makes the result stale on arrival", async () => {
    let resolve: (r: TestResult) => void = () => {};
    nextResult = () =>
      new Promise<TestResult>((r) => {
        resolve = r;
      });
    const env = { ...allEnv, MANAGED_AGENT_ID: false };
    const view = await mount({
      configs: [row("managed_agent_id", "one")],
      envPresence: env,
      envPresenceRevision: 1,
    });
    await view.clickTest();
    await view.render({
      configs: [row("managed_agent_id", "two")],
      envPresence: env,
      envPresenceRevision: 1,
    });
    await act(async () => resolve({ ok: true, agentName: "a" }));
    expect(view.badges()).not.toContain("Connected");
    expect(view.host.textContent).toContain("Last test");
    await view.cleanup();
  });
});
