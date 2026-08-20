import { describe, expect, mock, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { RuntimeInstance } from "../../../api/types";

// The root-level test run cannot resolve ui's `@/` alias (same pattern as client.test.tsx).
mock.module("@/lib/utils", () => import("../../../lib/utils"));
mock.module("@/lib/relative-time", () => import("../../../lib/relative-time"));
mock.module("@/lib/runtime-instances", () => import("../../../lib/runtime-instances"));
mock.module("@/components/ui/tooltip", () => import("../../../components/ui/tooltip"));
mock.module("@/components/ui/badge", () => import("../../../components/ui/badge"));
mock.module("@/components/ui/button", () => import("../../../components/ui/button"));
mock.module("@/components/ui/card", () => import("../../../components/ui/card"));
mock.module("@/components/ui/info-row", () => import("../../../components/ui/info-row"));
mock.module("@/components/ui/info-tip", () => import("../../../components/ui/info-tip"));
mock.module("@/components/ui/input", () => import("../../../components/ui/input"));
mock.module("@/components/ui/skeleton", () => import("../../../components/ui/skeleton"));
mock.module("@/components/ui/alert-callout", () => import("../../../components/ui/alert-callout"));
mock.module("@/hooks/use-copy-to-clipboard", () => import("../../../hooks/use-copy-to-clipboard"));
mock.module("@/api/hooks/use-agents", () => ({
  useAgentRuntimeInstances: () => ({ data: undefined, isLoading: false, isError: false }),
  useUpdateAgentMaxTasks: () => ({ mutate: () => {}, isPending: false }),
}));

const { TooltipProvider } = await import("../../../components/ui/tooltip");
const { RuntimeInstanceRow, RuntimeInstancesPanel } = await import("./runtime-instances-section");
type RuntimeInstancesPanelProps = Parameters<typeof RuntimeInstancesPanel>[0];

function instance(overrides: Partial<RuntimeInstance> = {}): RuntimeInstance {
  const now = new Date().toISOString();
  return {
    id: "a93f0000-1111-2222-3333-44445555ffff",
    agentId: "agent-1",
    status: "active",
    reportedSlots: 1,
    credentialReady: null,
    lastSeenAt: now,
    createdAt: now,
    updatedAt: now,
    isLive: true,
    ...overrides,
  };
}

function renderPanel(overrides: Partial<RuntimeInstancesPanelProps> = {}): string {
  return renderToStaticMarkup(
    <TooltipProvider>
      <RuntimeInstancesPanel
        maxTasks={4}
        instances={[]}
        staleThresholdMinutes={5}
        isLoading={false}
        isError={false}
        onSaveMaxTasks={() => {}}
        savingMaxTasks={false}
        {...overrides}
      />
    </TooltipProvider>,
  );
}

function renderRow(rt: RuntimeInstance): string {
  return renderToStaticMarkup(
    <TooltipProvider>
      <RuntimeInstanceRow instance={rt} staleThresholdMinutes={5} />
    </TooltipProvider>,
  );
}

describe("RuntimeInstancesPanel", () => {
  test("loading state renders a skeleton, not the empty copy", () => {
    const html = renderPanel({ isLoading: true });
    expect(html).toContain("animate-pulse");
    expect(html).not.toContain("No runtime instances");
  });

  test("empty state explains the default configuration instead of looking like a failure", () => {
    const html = renderPanel();
    expect(html).toContain("No runtime instances are currently registered for this agent.");
    expect(html).toContain("MULTI_RUNTIME_ENABLED");
    expect(html).not.toContain("Failed to load");
  });

  test("error state is distinct from the empty state", () => {
    const html = renderPanel({ isError: true });
    expect(html).toContain("Failed to load runtime instances.");
    expect(html).not.toContain("No runtime instances");
  });

  test("shows the logical task limit with an edit affordance", () => {
    const html = renderPanel();
    expect(html).toContain("Logical task limit");
    expect(html).toContain(">4<");
    expect(html).toContain("concurrent tasks across all runtimes");
    expect(html).toContain('aria-label="Edit logical task limit"');
  });

  test("every runtime renders as its own row", () => {
    const html = renderPanel({
      instances: [
        instance({ id: "aaaa1111-0000-0000-0000-000000000000", reportedSlots: 1 }),
        instance({ id: "bbbb2222-0000-0000-0000-000000000000", reportedSlots: 2 }),
        instance({ id: "cccc3333-0000-0000-0000-000000000000", reportedSlots: 1 }),
      ],
    });
    expect(html).toContain("aaaa1111…");
    expect(html).toContain("bbbb2222…");
    expect(html).toContain("cccc3333…");
  });

  test("summary counts only live runtimes and labels slots as reported capacity", () => {
    const html = renderPanel({
      instances: [
        instance({ id: "aaaa1111-0000-0000-0000-000000000000", reportedSlots: 2 }),
        instance({ id: "bbbb2222-0000-0000-0000-000000000000", reportedSlots: 1 }),
        instance({
          id: "cccc3333-0000-0000-0000-000000000000",
          reportedSlots: 4,
          isLive: false,
        }),
      ],
    });
    expect(html).toContain("2 live");
    expect(html).toContain("3 slots reported");
  });
});

describe("RuntimeInstanceRow", () => {
  test("a live runtime shows Live, its slots, and its short id", () => {
    const html = renderRow(instance({ reportedSlots: 2, credentialReady: true }));
    expect(html).toContain("Live");
    expect(html).toContain("2 slots");
    expect(html).toContain("a93f0000…");
    expect(html).toContain("seen ");
  });

  test("a stale active row is labelled Stale, not Live", () => {
    const html = renderRow(instance({ status: "active", isLive: false }));
    expect(html).toContain("Stale");
    expect(html).not.toContain(">Live<");
  });

  test("a closed runtime is labelled Offline", () => {
    const html = renderRow(instance({ status: "offline", isLive: false }));
    expect(html).toContain("Offline");
  });

  test("credential readiness renders the tri-state labels", () => {
    expect(renderRow(instance({ credentialReady: true }))).toContain("Ready");
    expect(renderRow(instance({ credentialReady: false }))).toContain("Waiting");
    expect(renderRow(instance({ credentialReady: null }))).toContain("Unreported");
  });

  test("the full runtime id stays reachable through an accessible copy control", () => {
    const html = renderRow(instance());
    expect(html).toContain('aria-label="Copy runtime id a93f0000-1111-2222-3333-44445555ffff"');
  });
});
