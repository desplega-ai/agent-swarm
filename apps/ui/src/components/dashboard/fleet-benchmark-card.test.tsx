import { afterAll, beforeEach, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, type ReactNode } from "react";
import type { FleetBenchmarkResponse, InboxItemState } from "@/api/types";

GlobalRegistrator.register();
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const { createRoot } = await import("react-dom/client");

let benchmark: FleetBenchmarkResponse | undefined;
let inbox: InboxItemState[] = [];
let workflowRunsCompleted = 0;
let tracked: Array<{ event: string; properties: unknown }> = [];
let inviteCalls: string[] = [];

// The root runner maps "@/" to the API's src/, so point the alias at the real file.
const fleetLib = await import("../../lib/fleet-benchmark");
mock.module("@/lib/fleet-benchmark", () => fleetLib);
mock.module("@/api/hooks/use-fleet-benchmark", () => ({
  useFleetBenchmark: () => ({ data: benchmark }),
}));
mock.module("@/api/hooks/use-inbox-state", () => ({
  useInboxState: () => ({ data: inbox, isSuccess: true }),
}));
mock.module("@/api/hooks/use-ui-telemetry", () => ({
  useUiTelemetry: () => (input: { event: string; properties: unknown }) => tracked.push(input),
}));
mock.module("@/app/status-context", () => ({
  useStatusContext: () => ({
    data: { instance: { workflow_runs_completed: workflowRunsCompleted } },
  }),
}));
mock.module("@/contexts/current-user-context", () => ({
  useCurrentUser: () => ({ userId: "u1" }),
}));
mock.module("@/hooks/use-dismissible-card", () => ({
  useDismissibleCard: () => ({ dismissed: false, dismiss: () => {}, restore: () => {} }),
}));
mock.module("../notifications/use-slack-connect-invite", () => ({
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
  inbox = [];
  workflowRunsCompleted = 0;
  tracked = [];
  inviteCalls = [];
});

async function render(): Promise<{
  text: string;
  buttons: string[];
  cleanup: () => Promise<void>;
}> {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(<FleetBenchmarkCard />));
  return {
    text: container.textContent ?? "",
    buttons: [...container.querySelectorAll("button")].map((b) => b.textContent ?? ""),
    cleanup: async () => {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

const READY: FleetBenchmarkResponse = {
  state: "ready",
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

test("ready: both comparisons, the Slack perk, and one viewed event per page load", async () => {
  benchmark = READY;
  const first = await render();
  expect(first.text).toContain("Your swarm vs. similar swarms");
  expect(first.text).toContain("14 tasks/week, bottom 25% of swarms with 2-5 agents (median 101)");
  expect(first.text).toContain("95% success, above the median of active swarms (median 91.1%)");
  expect(first.text).toContain("We reply within a business day");
  expect(first.buttons).toContain("Ask");
  await first.cleanup();
  const second = await render();
  await second.cleanup();
  expect(tracked).toEqual([
    { event: "fleet_benchmark.viewed", properties: { has_org_name: true } },
  ]);
});

test("a resolved invite hides the perk but keeps the benchmark", async () => {
  benchmark = READY;
  inbox = [
    { itemType: "notification", itemId: "slack_connect_invite", status: "done" } as InboxItemState,
  ];
  const view = await render();
  expect(view.text).toContain("Your swarm vs. similar swarms");
  expect(view.text).not.toContain("Slack Connect");
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
  expect(view.text).toContain("Finish 10 tasks in 30 days to compare (4 so far)");
  await view.cleanup();
});

test("telemetry off: nothing, unless a workflow completed, then the perk alone", async () => {
  benchmark = { ...READY, state: "telemetry_off", local: null, comparisons: [] };
  const hidden = await render();
  expect(hidden.text).toBe("");
  await hidden.cleanup();

  workflowRunsCompleted = 1;
  const perk = await render();
  expect(perk.text).not.toContain("similar swarms");
  expect(perk.text).toContain("Slack Connect");
  const noThanks = [...document.querySelectorAll("button")].find(
    (b) => b.textContent === "No thanks",
  );
  await act(async () => noThanks?.click());
  expect(inviteCalls).toEqual(["dismiss"]);
  await perk.cleanup();
});
