import { afterAll, afterEach, beforeEach, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, type ReactNode } from "react";

GlobalRegistrator.register();
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, __APP_VERSION__: "1.0.0" });
const { createRoot } = await import("react-dom/client");

let telemetryEnabled = false;
let role = "admin";
const enabled: string[] = [];

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
mock.module("@/api/hooks/use-org-profile", () => ({
  useEnableTelemetry: () => ({ isPending: false, mutate: (via: string) => enabled.push(via) }),
}));
mock.module("@/app/status-context", () => ({
  useStatusContext: () => ({ data: { automations: [], telemetry: { enabled: telemetryEnabled } } }),
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

let cleanup: (() => Promise<void>) | undefined;
async function mount() {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(<DashboardNudges />));
  cleanup = async () => {
    await act(async () => root.unmount());
    container.remove();
  };
  return container;
}

beforeEach(() => {
  telemetryEnabled = false;
  role = "admin";
  enabled.length = 0;
  localStorage.clear();
});
afterEach(async () => {
  await cleanup?.();
  cleanup = undefined;
});
afterAll(async () => {
  await GlobalRegistrator.unregister();
});

test("admins with telemetry off see the banner and can turn telemetry on", async () => {
  const container = await mount();
  expect(container.textContent).toContain("Telemetry is off");
  const turnOn = [...container.querySelectorAll("button")].find((b) => b.textContent === "Turn on");
  await act(async () => turnOn?.click());
  expect(enabled).toEqual(["banner"]);
});

test("members and installs with telemetry on see no banner", async () => {
  role = "member";
  expect((await mount()).textContent).not.toContain("Telemetry is off");
  await cleanup?.();
  role = "admin";
  telemetryEnabled = true;
  expect((await mount()).textContent).not.toContain("Telemetry is off");
});

test("a dismissal persists across remounts", async () => {
  const container = await mount();
  const dismiss = container.querySelector(
    'button[aria-label="Dismiss Telemetry is off"]',
  ) as HTMLButtonElement;
  await act(async () => dismiss.click());
  expect(container.textContent).not.toContain("Telemetry is off");
  await cleanup?.();
  expect((await mount()).textContent).not.toContain("Telemetry is off");
});
