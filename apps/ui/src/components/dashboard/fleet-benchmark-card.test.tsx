import { afterAll, beforeEach, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, type ReactNode } from "react";
import type { FleetBenchmarkResponse, InboxItemState } from "@/api/types";

GlobalRegistrator.register();
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const { createRoot } = await import("react-dom/client");

let benchmark: FleetBenchmarkResponse | undefined;
/** The benchmark query's last fetch failed (react-query keeps the old data). */
let benchmarkError = false;
let refetches = 0;
let apiUrl = "https://fleet.example";
let statusLoaded = true;
let inbox: InboxItemState[] = [];
let workflowRunsCompleted = 0;
let telemetryEnabled = true;
let role: string | undefined = "admin";
let tracked: Array<{ event: string; properties: unknown }> = [];
let inviteCalls: string[] = [];
let enabled: string[] = [];

const Box = ({ children }: { children?: ReactNode }) => <div>{children}</div>;

// The root runner maps "@/" to the API's src/, so point the aliases at the real files.
const fleetLib = await import("../../lib/fleet-benchmark");
mock.module("@/lib/fleet-benchmark", () => fleetLib);
mock.module("@/lib/telemetry-banner", () => require("../../lib/telemetry-banner"));
mock.module("@/lib/user-role", () => require("../../lib/user-role"));
mock.module("@/lib/utils", () => require("../../lib/utils"));
mock.module("@/hooks/use-dismissible-card-key", () =>
  require("../../hooks/use-dismissible-card-key"),
);
mock.module("@tanstack/react-query", () => ({
  useQueryClient: () => ({ invalidateQueries: async () => {} }),
}));
mock.module("@/api/hooks/use-fleet-benchmark", () => ({
  useFleetBenchmark: () => ({
    data: benchmark,
    isError: benchmarkError,
    isFetching: false,
    refetch: async () => {
      refetches += 1;
    },
  }),
}));
mock.module("@/api/hooks/use-inbox-state", () => ({
  useInboxState: () => ({ data: inbox, isSuccess: true }),
}));
mock.module("@/api/hooks/use-org-profile", () => ({
  useEnableTelemetry: () => ({
    isPending: false,
    mutate: (via: string) => enabled.push(via),
  }),
}));
mock.module("@/api/hooks/use-ui-telemetry", () => ({
  isUiTelemetryEnabled: (status: { telemetry?: { enabled?: boolean } } | undefined) =>
    status !== undefined && status.telemetry?.enabled !== false,
  useUiTelemetry: () => (input: { event: string; properties: unknown }) => tracked.push(input),
}));
mock.module("@/app/status-context", () => ({
  useStatusContext: () => ({
    data: statusLoaded
      ? {
          instance: { workflow_runs_completed: workflowRunsCompleted },
          telemetry: { enabled: telemetryEnabled },
        }
      : undefined,
  }),
}));
mock.module("@/contexts/current-user-context", () => ({
  useCurrentUser: () => ({ userId: "u1", user: { role } }),
}));
mock.module("@/hooks/use-config", () => ({
  useConfig: () => ({ config: { apiUrl } }),
}));
mock.module("@/hooks/use-dismissible-card", () => ({
  useDismissibleCard: () => ({ dismissed: false, dismiss: () => {}, restore: () => {} }),
}));
mock.module("@/components/shared/fade-in", () => ({ FadeIn: Box }));
mock.module("@/components/shared/animated-reveal", () => ({
  AnimatedReveal: ({ open, children }: { open: boolean; children: ReactNode }) =>
    open ? children : null,
}));
mock.module("@/components/shared/border-beam", () => ({ BorderBeam: () => null }));
mock.module("@/components/shared/status-icon", () => ({ StatusLine: Box }));
mock.module("./fleet-benchmark-forms", () => ({
  FleetUnlockFlow: () => <p>unlock flow</p>,
  FleetReportForm: () => <p>report form</p>,
}));
mock.module("@/hooks/use-slack-connect-invite", () => ({
  SLACK_CONNECT_INVITE_KEY: "slack_connect_invite",
  useSlackConnectInvite: () => ({
    submit: (email: string) => inviteCalls.push(`submit:${email}`),
    dismiss: () => inviteCalls.push("dismiss"),
  }),
}));
mock.module("@/components/ui/button", () => ({
  Button: ({
    children,
    onClick,
    type,
  }: {
    children: ReactNode;
    onClick?: () => void;
    type?: "button" | "submit";
  }) => (
    <button type={type === "submit" ? "submit" : "button"} onClick={onClick}>
      {children}
    </button>
  ),
}));
mock.module("@/components/ui/input", () => ({ Input: () => <input /> }));

const { FleetBenchmarkCard } = await import("./fleet-benchmark-card");

afterAll(async () => {
  await GlobalRegistrator.unregister();
});

beforeEach(() => {
  benchmark = undefined;
  benchmarkError = false;
  refetches = 0;
  apiUrl = "https://fleet.example";
  statusLoaded = true;
  inbox = [];
  workflowRunsCompleted = 0;
  telemetryEnabled = true;
  role = "admin";
  tracked = [];
  inviteCalls = [];
  enabled = [];
  localStorage.clear();
});

async function render(): Promise<{
  text: () => string;
  buttons: string[];
  click: (label: string) => Promise<void>;
  rerender: () => Promise<void>;
  cleanup: () => Promise<void>;
}> {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(<FleetBenchmarkCard />));
  return {
    text: () => container.textContent ?? "",
    buttons: [...container.querySelectorAll("button")].map((b) => b.textContent ?? ""),
    click: async (label) => {
      const button = [...container.querySelectorAll("button")].find((b) => b.textContent === label);
      await act(async () => button?.click());
    },
    rerender: async () => {
      await act(async () => root.render(<FleetBenchmarkCard />));
    },
    cleanup: async () => {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

const READY: FleetBenchmarkResponse = {
  state: "ready",
  level: "basic",
  peerGroup: null,
  local: { tasksPerWeek: 14, taskSuccessRate: 0.95, finishedTasks: 60, agents: 3, bucket: "2-5" },
  minFinishedTasks: 10,
  generatedAt: "2026-10-11T23:00:00Z",
  comparisons: [
    { key: "tasksPerWeek", value: 14, p50: 101, band: "bottom_25", peers: "2-5", installs: 45 },
    {
      key: "taskSuccessRate",
      value: 0.95,
      p50: 0.911,
      band: "above_median",
      peers: "all",
      installs: 94,
    },
  ],
};

const OFF: FleetBenchmarkResponse = { ...READY, state: "telemetry_off", comparisons: [] };

test("ready: both comparisons, the Slack perk, and one viewed event per page load", async () => {
  benchmark = READY;
  const first = await render();
  expect(first.text()).toContain("Your swarm vs. similar swarms");
  expect(first.text()).toContain(
    "14 tasks/week, bottom 25% of swarms with 2-5 agents (median 101)",
  );
  expect(first.text()).toContain("95% success, above the median of active swarms (median 91.1%)");
  expect(first.text()).toContain("We reply within a business day");
  expect(first.buttons).toContain("Ask");
  await first.cleanup();
  const second = await render();
  await second.cleanup();
  expect(tracked).toEqual([
    { event: "fleet_benchmark.viewed", properties: { has_org_name: true, level: "basic" } },
  ]);
});

test("basic level: the peer rows are locked, and an admin opens the unlock flow", async () => {
  benchmark = READY;
  const view = await render();
  expect(view.text()).toContain("Tasks per week, against teams your size that do the same work");
  expect(view.text()).not.toContain("unlock flow");
  await view.click("Compare with teams like yours");
  expect(view.text()).toContain("unlock flow");
  await view.cleanup();
});

test("basic level for a non-admin: no unlock button, a pointer to an admin", async () => {
  benchmark = READY;
  role = "member";
  const view = await render();
  expect(view.buttons).not.toContain("Compare with teams like yours");
  expect(view.text()).toContain("An admin can unlock these");
  await view.cleanup();
});

test("full level: the peer group line and the monthly report", async () => {
  benchmark = {
    ...READY,
    level: "full",
    peerGroup: { teamSize: "2-10", useCase: "bugs", orgs: 25 },
  };
  const view = await render();
  expect(view.text()).toContain(
    "Compared with 25 organizations like yours (2-10 people, Fix bugs).",
  );
  expect(view.text()).toContain("report form");
  expect(view.text()).not.toContain("against teams your size");
  await view.cleanup();

  benchmark = { ...READY, level: "full", peerGroup: null };
  const fallback = await render();
  expect(fallback.text()).toContain("Not enough swarms like yours report yet");
  await fallback.cleanup();
});

test("a resolved invite hides the perk but keeps the benchmark", async () => {
  benchmark = READY;
  inbox = [
    { itemType: "notification", itemId: "slack_connect_invite", status: "done" } as InboxItemState,
  ];
  const view = await render();
  expect(view.text()).toContain("Your swarm vs. similar swarms");
  expect(view.text()).not.toContain("Slack Connect");
  await view.cleanup();
});

test("under 10 finished tasks: progress line", async () => {
  benchmark = {
    ...READY,
    state: "not_enough_tasks",
    comparisons: [],
    local: { ...READY.local!, finishedTasks: 4 },
  };
  const view = await render();
  expect(view.text()).toContain("Finish 10 tasks in 30 days to compare (4 so far)");
  await view.cleanup();
});

test("telemetry off with the banner up: nothing, unless a workflow completed, then the perk alone", async () => {
  benchmark = OFF;
  telemetryEnabled = false;
  const hidden = await render();
  expect(hidden.text()).toBe("");
  await hidden.cleanup();

  workflowRunsCompleted = 1;
  const perk = await render();
  expect(perk.text()).not.toContain("similar swarms");
  expect(perk.text()).toContain("Slack Connect");
  await perk.click("No thanks");
  expect(inviteCalls).toEqual(["dismiss"]);
  await perk.cleanup();
});

test("telemetry off after the banner was dismissed: what it unlocks, Turn on uses via benchmark", async () => {
  benchmark = OFF;
  telemetryEnabled = false;
  localStorage.setItem("swarm:v1:https://fleet.example:dashboard-telemetry-off", "2026-10-01");
  const view = await render();
  expect(view.text()).toContain("Turn on anonymized telemetry to see where your swarm stands");
  await view.click("Turn on telemetry");
  expect(enabled).toEqual(["benchmark"]);
  await view.cleanup();
});

test("telemetry off for a non-admin: what it unlocks, no button", async () => {
  benchmark = OFF;
  telemetryEnabled = false;
  role = "member";
  const view = await render();
  expect(view.text()).toContain("An admin can turn it on in Settings.");
  expect(view.buttons).not.toContain("Turn on telemetry");
  await view.cleanup();
});

test("viewed waits for /status and counts once per swarm", async () => {
  benchmark = READY;
  apiUrl = "https://other.example";
  statusLoaded = false;
  const loading = await render();
  expect(loading.text()).toContain("Your swarm vs. similar swarms");
  expect(tracked).toEqual([]);
  statusLoaded = true;
  await loading.rerender();
  await loading.rerender();
  await loading.cleanup();
  expect(tracked).toEqual([
    { event: "fleet_benchmark.viewed", properties: { has_org_name: true, level: "basic" } },
  ]);
});

test("a reload that comes back unavailable keeps the last numbers, with a Retry", async () => {
  benchmark = READY;
  const view = await render();
  benchmark = { ...READY, state: "unavailable", comparisons: [] };
  await view.rerender();
  expect(view.text()).toContain("14 tasks/week, bottom 25% of swarms with 2-5 agents");
  expect(view.text()).toContain("Could not refresh the comparison.");
  await view.click("Retry");
  expect(refetches).toBe(1);
  benchmark = { ...READY, level: "full", peerGroup: null };
  await view.rerender();
  expect(view.text()).not.toContain("Could not refresh");
  expect(view.text()).toContain("report form");
  await view.cleanup();
});

test("a failed reload keeps the numbers and offers a Retry", async () => {
  benchmark = READY;
  const view = await render();
  benchmarkError = true;
  await view.rerender();
  expect(view.text()).toContain("95% success");
  expect(view.text()).toContain("Could not refresh the comparison.");
  expect(view.buttons).toContain("Compare with teams like yours");
  await view.cleanup();
});

test("unavailable on the first load still hides the card", async () => {
  benchmark = { ...READY, state: "unavailable", comparisons: [] };
  const view = await render();
  expect(view.text()).toBe("");
  await view.cleanup();
});
