import { afterAll, afterEach, beforeEach, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, type ReactNode, useState } from "react";
import type { ApprovalQuestion, FleetBenchmarkResponse } from "@/api/types";

GlobalRegistrator.register();
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const { createRoot } = await import("react-dom/client");

let benchmark: FleetBenchmarkResponse | undefined;
let enabled: string[] = [];
let saves: Array<{ patch: unknown; surface: string }> = [];
let calls: string[] = [];
let answers: Record<string, unknown> = {};

const Box = ({ children }: { children?: ReactNode }) => <div>{children}</div>;

mock.module("@/lib/company-profile", () => require("../../lib/company-profile"));
const fleetLib = await import("../../lib/fleet-benchmark");
mock.module("@/lib/fleet-benchmark", () => fleetLib);
mock.module("@tanstack/react-query", () => ({
  useQueryClient: () => ({ invalidateQueries: async () => {} }),
}));
mock.module("@/api/hooks/use-fleet-benchmark", () => ({
  useFleetBenchmark: () => ({ data: benchmark }),
}));
mock.module("@/api/hooks/use-org-profile", () => ({
  useEnableTelemetry: () => ({
    isPending: false,
    mutate: (via: string, options: { onSuccess: () => void }) => {
      enabled.push(via);
      options.onSuccess();
    },
  }),
}));
mock.module("@/api/hooks/use-company-profile", () => ({
  useCompanyProfile: () => ({
    loaded: true,
    name: null,
    website: null,
    teamSize: null,
    suggestedName: "Acme",
    suggestedWebsite: "acme.com",
    save: async (patch: unknown, surface: string) => {
      saves.push({ patch, surface });
      return [];
    },
  }),
}));
mock.module("@/app/status-context", () => ({ useStatusContext: () => ({ data: {} }) }));
mock.module("sonner", () => ({ toast: { error: () => {} } }));
mock.module("@/components/shared/border-beam", () => ({ BorderBeam: () => null }));
mock.module("@/components/shared/status-icon", () => ({ StatusLine: Box }));
mock.module("@/components/ui/button", () => ({
  Button: ({
    children,
    onClick,
    "aria-label": ariaLabel,
  }: {
    children: ReactNode;
    onClick?: () => void;
    "aria-label"?: string;
  }) => (
    <button type="button" aria-label={ariaLabel} onClick={onClick}>
      {children}
    </button>
  ),
}));
mock.module("@/components/shared/question-flow", () => ({
  QuestionFlow: ({
    questions,
    initialValues,
    onSubmit,
    done,
  }: {
    questions: ApprovalQuestion[];
    initialValues?: Record<string, unknown>;
    onSubmit: (values: Record<string, unknown>) => Promise<void>;
    done: (values: Record<string, unknown>) => ReactNode;
  }) => {
    const [finished, setFinished] = useState(false);
    if (finished) return <div>{done({})}</div>;
    return (
      <div>
        {questions.map((q) => (
          <p key={q.id}>{q.label}</p>
        ))}
        <p>initial:{JSON.stringify(initialValues)}</p>
        <button
          type="button"
          onClick={() => onSubmit({ ...initialValues, ...answers }).then(() => setFinished(true))}
        >
          Submit
        </button>
      </div>
    );
  },
}));

const { TelemetryBenchmarkBanner } = await import("./telemetry-benchmark-banner");

const OFF: FleetBenchmarkResponse = {
  state: "telemetry_off",
  level: "basic",
  peerGroup: null,
  local: { tasksPerWeek: 42, taskSuccessRate: 0.93, finishedTasks: 6, agents: 3, bucket: "2-5" },
  minFinishedTasks: 10,
  generatedAt: null,
  comparisons: [],
};

let container: HTMLDivElement;
let cleanup: (() => Promise<void>) | undefined;
async function mount() {
  container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () =>
    root.render(
      <TelemetryBenchmarkBanner
        onStart={() => calls.push("start")}
        onClose={() => calls.push("close")}
        onDismiss={() => calls.push("dismiss")}
      />,
    ),
  );
  cleanup = async () => {
    await act(async () => root.unmount());
    container.remove();
  };
}
async function click(label: string) {
  const button = [...container.querySelectorAll("button")].find((b) => b.textContent === label);
  await act(async () => button?.click());
}

beforeEach(() => {
  benchmark = OFF;
  enabled = [];
  saves = [];
  calls = [];
  answers = {};
});
afterEach(async () => {
  await cleanup?.();
  cleanup = undefined;
});
afterAll(async () => {
  await GlobalRegistrator.unregister();
});

test("off: this swarm's own numbers next to a locked fleet column, and the task minimum", async () => {
  await mount();
  const text = container.textContent ?? "";
  expect(text).toContain("Your last 30 days next to swarms with 2-5 agents.");
  expect(text).toContain("Tasks per week42");
  expect(text).toContain("Task success93%");
  expect(text).toContain("Hidden");
  expect(text).toContain("The comparison starts at 10 finished tasks in 30 days (6 so far).");
  expect(text).toContain("Telemetry turns on with this click.");
});

test("Turn on enables telemetry first, then asks what the benchmark needs", async () => {
  await mount();
  await click("Turn on telemetry");
  expect(calls).toEqual(["start"]);
  expect(enabled).toEqual(["banner"]);
  const text = container.textContent ?? "";
  expect(text).toContain("Organization name");
  expect(text).toContain("Company website");
  expect(text).toContain("How many people work with the swarm?");
  expect(text).toContain('initial:{"org_name":"Acme","website":"acme.com"}');
});

test("Submit saves the company profile from the telemetry banner", async () => {
  await mount();
  await click("Turn on telemetry");
  answers = { org_name: " Acme Labs ", team_size: "11-50" };
  await click("Submit");
  expect(saves).toEqual([
    {
      patch: { name: "Acme Labs", website: "acme.com", teamSize: "11-50" },
      surface: "telemetry_banner",
    },
  ]);
  expect(container.textContent).toContain("Saved.");
});

test("the X on the ask is the permanent dismissal; on the questions it only closes", async () => {
  await mount();
  const dismiss = container.querySelector(
    'button[aria-label="Dismiss See how your swarm compares"]',
  ) as HTMLButtonElement;
  await act(async () => dismiss.click());
  expect(calls).toEqual(["dismiss"]);
  await click("Turn on telemetry");
  const close = container.querySelector(
    'button[aria-label="Close the benchmark questions"]',
  ) as HTMLButtonElement;
  await act(async () => close.click());
  expect(calls).toEqual(["dismiss", "start", "close"]);
});
