import { afterAll, afterEach, beforeEach, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, type ReactNode } from "react";
import type { ApprovalQuestion } from "@/api/types";

GlobalRegistrator.register();
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const { createRoot } = await import("react-dom/client");

let profile: Record<string, unknown> = {};
let saves: Array<{ patch: unknown; surface: string }> = [];
let tracked: Array<{ event: string; properties: unknown }> = [];
let subscribed: string[] = [];
let answers: Record<string, unknown> = {};

const Box = ({ children }: { children?: ReactNode }) => <div>{children}</div>;

mock.module("@/lib/company-profile", () => require("../../lib/company-profile"));
mock.module("@tanstack/react-query", () => ({
  useQueryClient: () => ({ invalidateQueries: async () => {} }),
}));
mock.module("@/api/hooks/use-company-profile", () => ({
  useCompanyProfile: () => ({
    loaded: true,
    ...profile,
    save: async (patch: unknown, surface: string) => {
      saves.push({ patch, surface });
      return [];
    },
  }),
}));
mock.module("@/api/hooks/use-fleet-report", () => ({
  useSubscribeFleetReport: () => async (email: string) => {
    subscribed.push(email);
  },
}));
mock.module("@/api/hooks/use-ui-telemetry", () => ({
  useUiTelemetry: () => (input: { event: string; properties: unknown }) => tracked.push(input),
}));
mock.module("@/contexts/current-user-context", () => ({
  useCurrentUser: () => ({ user: { email: "dana@acme.com" } }),
}));
mock.module("@/hooks/use-dismissible-card", () => ({
  useDismissibleCard: () => ({ dismissed: false, dismiss: () => {}, restore: () => {} }),
}));
mock.module("sonner", () => ({ toast: { error: () => {} } }));
mock.module("@/components/shared/fade-in", () => ({ FadeIn: Box }));
mock.module("@/components/shared/status-icon", () => ({ StatusLine: Box }));
mock.module("@/components/shared/border-beam", () => ({ BorderBeam: () => null }));
mock.module("@/components/ui/input", () => ({
  Input: (props: { value: string; onChange: () => void }) => <input {...props} />,
}));
mock.module("@/components/ui/button", () => ({
  Button: ({
    children,
    onClick,
    type,
    disabled,
  }: {
    children: ReactNode;
    onClick?: () => void;
    type?: "button" | "submit";
    disabled?: boolean;
  }) => (
    <button type={type === "submit" ? "submit" : "button"} disabled={disabled} onClick={onClick}>
      {children}
    </button>
  ),
}));
mock.module("@/components/shared/question-flow", () => ({
  QuestionFlow: ({
    questions,
    initialValues,
    onSubmit,
  }: {
    questions: ApprovalQuestion[];
    initialValues?: Record<string, unknown>;
    onSubmit: (values: Record<string, unknown>) => Promise<void>;
  }) => (
    <div>
      <p>asked:{questions.map((q) => q.id).join(",")}</p>
      <p>initial:{JSON.stringify(initialValues)}</p>
      <button type="button" onClick={() => onSubmit({ ...initialValues, ...answers })}>
        Submit
      </button>
    </div>
  ),
}));

const { FleetReportForm, FleetUnlockFlow } = await import("./fleet-benchmark-forms");

let container: HTMLDivElement;
let cleanup: (() => Promise<void>) | undefined;
async function mount(node: ReactNode) {
  container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(node));
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
  profile = { website: null, teamSize: null, useCase: null, suggestedWebsite: "acme.com" };
  saves = [];
  tracked = [];
  subscribed = [];
  answers = {};
});
afterEach(async () => {
  await cleanup?.();
  cleanup = undefined;
});
afterAll(async () => {
  await GlobalRegistrator.unregister();
});

test("unlock asks only for what is missing, pre-filling the website from the email domain", async () => {
  profile = { ...profile, teamSize: "2-10" };
  await mount(<FleetUnlockFlow onCancel={() => {}} />);
  expect(container.textContent).toContain("asked:website,use_case");
  expect(container.textContent).toContain('initial:{"website":"acme.com"}');
});

test("unlock saves from the benchmark, then reports which fields it asked", async () => {
  await mount(<FleetUnlockFlow onCancel={() => {}} />);
  answers = { team_size: "11-50", use_case: "bugs" };
  await click("Submit");
  expect(saves).toEqual([
    {
      patch: { website: "acme.com", teamSize: "11-50", useCase: "bugs" },
      surface: "fleet_benchmark",
    },
  ]);
  expect(tracked).toEqual([
    {
      event: "fleet_benchmark.unlocked",
      properties: { fields: ["website", "team_size", "use_case"] },
    },
  ]);
});

test("with nothing missing (stale card data), unlock confirms all three", async () => {
  profile = { website: "acme.com", teamSize: "2-10", useCase: "review", suggestedWebsite: null };
  await mount(<FleetUnlockFlow onCancel={() => {}} />);
  expect(container.textContent).toContain("asked:website,team_size,use_case");
});

test("the report sends nothing until the unchecked box is ticked", async () => {
  await mount(<FleetReportForm />);
  const checkbox = container.querySelector('input[type="checkbox"]') as HTMLInputElement;
  const subscribe = [...container.querySelectorAll("button")].find(
    (b) => b.textContent === "Subscribe",
  ) as HTMLButtonElement;
  expect(checkbox.checked).toBe(false);
  expect(subscribe.disabled).toBe(true);
  await act(async () => checkbox.click());
  const form = container.querySelector("form") as HTMLFormElement;
  await act(async () => form.requestSubmit());
  expect(subscribed).toEqual(["dana@acme.com"]);
  expect(container.textContent).toContain(
    "Request sent. We will email dana@acme.com when the monthly report starts.",
  );
});
