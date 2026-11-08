import { expect, mock, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";

// Every widget is a stub that prints its name and the order class it gets.
function stub(name: string) {
  return ({ className }: { className?: string }) => (
    <div data-widget={name} className={className} />
  );
}

let supported = true;
mock.module("@/api/hooks/use-feature-gate", () => ({
  useFeatureGate: () => ({ supported, currentVersion: "9.9.9", isError: false, error: null }),
}));
mock.module("@/hooks/use-config", () => ({
  useConfig: () => ({ config: { apiUrl: "http://api" }, pendingConnection: null }),
}));
mock.module("@/components/dashboard/dashboard-nudges", () => ({ DashboardNudges: stub("nudges") }));
mock.module("@/components/home/needs-you", () => ({ NeedsYou: stub("needs-you") }));
mock.module("@/components/home/favorites", () => ({ Favorites: stub("favorites") }));
mock.module("@/components/home/home-metrics", () => ({ HomeMetrics: stub("metrics") }));
mock.module("@/components/home/activity-density", () => ({ ActivityDensity: stub("density") }));
mock.module("@/components/ui/segmented-control", () => ({ SegmentedControl: () => null }));
mock.module("@/components/checklist/post-onboarding-checklist-card", () => ({
  PostOnboardingChecklistCard: stub("checklist"),
  useSetupComplete: () => false,
}));
mock.module("@/components/dashboard/agent-activity-timeline", () => ({
  AgentActivityTimeline: stub("timeline"),
}));
mock.module("@/components/shared/local-network-help", () => ({ LocalNetworkHelp: stub("help") }));
mock.module("@/components/ui/alert-callout", () => ({
  AlertCallout: ({ children }: { children?: unknown }) => (
    <div data-widget="alert">{children as string}</div>
  ),
}));
mock.module("@/components/ui/skeleton", () => ({ Skeleton: stub("skeleton") }));

const { UnifiedHome } = await import("./unified-home");

function render() {
  return renderToStaticMarkup(
    <MemoryRouter>
      <UnifiedHome />
    </MemoryRouter>,
  );
}

function widgets(html: string): string[] {
  return [...html.matchAll(/data-widget="([^"]+)"/g)].map((m) => m[1]);
}

test("nudges and metrics on top; main column: Needs you, activity; side: Favorites, Getting started", () => {
  const html = render();
  expect(widgets(html)).toEqual([
    "nudges",
    "metrics",
    "needs-you",
    "density",
    "favorites",
    "checklist",
  ]);
  expect(html).toContain("@5xl/home:grid-cols-[minmax(0,1fr)_minmax(320px,380px)]");
});

test("an older API gets the notice in the timeline slot, the widgets stay", () => {
  supported = false;
  const html = render();
  supported = true;
  expect(html).toContain("requires Agent Swarm API 1.76+");
  expect(widgets(html)).toContain("needs-you");
  expect(widgets(html)).not.toContain("density");
});
