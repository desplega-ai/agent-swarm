import { afterAll, afterEach, beforeEach, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, type ReactNode } from "react";

GlobalRegistrator.register();
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, __APP_VERSION__: "1.0.0" });
const { createRoot } = await import("react-dom/client");

let telemetryEnabled = false;
let role = "admin";
const started: string[] = [];

mock.module("react-router-dom", () => ({
  Link: ({ children }: { children: ReactNode }) => children,
}));
mock.module("@/api/hooks/use-config-api", () => ({
  useConfigs: () => ({ data: [{ key: "SWARM_ORG_NAME", value: "Acme" }] }),
}));
mock.module("@/api/hooks/use-feature-gate", () => ({
  useFeatureGate: () => ({ currentVersion: null, supported: true }),
}));
mock.module("@/api/hooks/use-onboarding", () => ({ useOnboardingOwnsFirstRun: () => false }));
mock.module("@/app/status-context", () => ({
  useStatusContext: () => ({ data: { automations: [], telemetry: { enabled: telemetryEnabled } } }),
}));
// The banner has its own flow; here only its show and dismiss rules matter.
mock.module("./telemetry-benchmark-banner", () => ({
  TelemetryBenchmarkBanner: ({
    onStart,
    onDismiss,
  }: {
    onStart: () => void;
    onClose: () => void;
    onDismiss: () => void;
  }) => (
    <section>
      See how your swarm compares
      <button
        type="button"
        onClick={() => {
          started.push("start");
          onStart();
        }}
      >
        Turn on telemetry
      </button>
      <button type="button" aria-label="Dismiss See how your swarm compares" onClick={onDismiss} />
    </section>
  ),
}));
mock.module("@/components/ui/button", () => ({
  Button: ({
    children,
    onClick,
    asChild,
    "aria-label": ariaLabel,
  }: {
    children: ReactNode;
    onClick?: () => void;
    asChild?: boolean;
    "aria-label"?: string;
  }) =>
    asChild ? (
      children
    ) : (
      <button type="button" aria-label={ariaLabel} onClick={onClick}>
        {children}
      </button>
    ),
}));
mock.module("@/contexts/current-user-context", () => ({
  useCurrentUser: () => ({ user: { role } }),
}));
mock.module("@/hooks/use-config", () => ({
  useConfig: () => ({ config: { apiUrl: "https://nudges.example" } }),
}));
mock.module("@/hooks/use-dismissible-card", () => ({
  useDismissibleCard: () => ({ dismissed: false, dismiss: () => {}, restore: () => {} }),
}));
mock.module("@/hooks/use-dismissible-card-key", () =>
  require("../../hooks/use-dismissible-card-key"),
);
mock.module("@/lib/telemetry-banner", () => require("../../lib/telemetry-banner"));
mock.module("@/lib/user-role", () => require("../../lib/user-role"));
mock.module("@/lib/utils", () => require("../../lib/utils"));

const { DashboardNudges } = await import("./dashboard-nudges");

const TITLE = "See how your swarm compares";
let rerender: (() => Promise<void>) | undefined;
let cleanup: (() => Promise<void>) | undefined;
async function mount() {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(<DashboardNudges />));
  rerender = async () => {
    await act(async () => root.render(<DashboardNudges />));
  };
  cleanup = async () => {
    await act(async () => root.unmount());
    container.remove();
  };
  return container;
}

beforeEach(() => {
  telemetryEnabled = false;
  role = "admin";
  started.length = 0;
  localStorage.clear();
});
afterEach(async () => {
  await cleanup?.();
  cleanup = undefined;
});
afterAll(async () => {
  await GlobalRegistrator.unregister();
});

test("admins with telemetry off see the benchmark banner", async () => {
  expect((await mount()).textContent).toContain(TITLE);
});

test("members and installs with telemetry on see no banner", async () => {
  role = "member";
  expect((await mount()).textContent).not.toContain(TITLE);
  await cleanup?.();
  role = "admin";
  telemetryEnabled = true;
  expect((await mount()).textContent).not.toContain(TITLE);
});

test("after Turn on, the banner stays up for its questions once telemetry is on", async () => {
  const container = await mount();
  const turnOn = [...container.querySelectorAll("button")].find(
    (b) => b.textContent === "Turn on telemetry",
  );
  await act(async () => turnOn?.click());
  telemetryEnabled = true;
  await rerender?.();
  expect(started).toEqual(["start"]);
  expect(container.textContent).toContain(TITLE);
});

test("a dismissal persists across remounts", async () => {
  const container = await mount();
  const dismiss = container.querySelector(
    `button[aria-label="Dismiss ${TITLE}"]`,
  ) as HTMLButtonElement;
  await act(async () => dismiss.click());
  expect(container.textContent).not.toContain(TITLE);
  await cleanup?.();
  expect((await mount()).textContent).not.toContain(TITLE);
});
