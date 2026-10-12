import { afterAll, afterEach, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, type ReactNode } from "react";

GlobalRegistrator.register();
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const { createRoot } = await import("react-dom/client");
let role = "admin";
let pathname = "/";
mock.module("react-router-dom", () => ({ useLocation: () => ({ pathname }) }));
let apiUrl = "https://swarm.example";
const key = () => `swarm:org-name-prompt:later:v1:${apiUrl}`;
const Box = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
const upserts: Array<{ key: string; value: string }> = [];
const consents: boolean[] = [];
mock.module("@/api/hooks/use-config-api", () => ({
  useUpsertConfig: () => ({
    mutateAsync: async (input: { key: string; value: string }) => upserts.push(input),
  }),
  useConfigs: () => ({
    data: [
      { key: "telemetry_installed_at", value: new Date(Date.now() - 5 * 86400000).toISOString() },
    ],
  }),
}));
mock.module("@/api/hooks/use-integrations-meta", () => ({
  useEnvPresence: () => ({ data: { SWARM_ORG_NAME: false }, dataUpdatedAt: Date.now() + 1000 }),
  useReloadConfig: () => ({ mutateAsync: async () => {} }),
}));
mock.module("@/api/hooks/use-onboarding", () => ({ useOnboardingOwnsFirstRun: () => false }));
mock.module("@/api/hooks/use-org-profile", () => ({
  useSetUsedByConsent: () => ({ mutateAsync: async (granted: boolean) => consents.push(granted) }),
}));
const sentEvents: Array<{ event: string; properties: Record<string, unknown> }> = [];
mock.module("@/api/hooks/use-ui-telemetry", () => ({
  isUiTelemetryEnabled: () => true,
  useUiTelemetry: () => (input: { event: string; properties: Record<string, unknown> }) =>
    sentEvents.push(input),
}));
mock.module("@/contexts/current-user-context", () => ({
  useCurrentUser: () => ({ state: "ready", userId: "admin", user: { role } }),
}));
mock.module("@/hooks/use-config", () => ({ useConfig: () => ({ config: { apiUrl } }) }));
mock.module("@/hooks/use-other-dialog-open", () => ({
  ...require("../../hooks/use-other-dialog-open"),
  useOtherDialogOpen: () => false,
}));
mock.module("@/app/status-context", () => ({
  useStatusContext: () => ({
    data: {
      identity: { is_cloud: false, name: "" },
      instance: {
        first_seen_at: null,
        tasks_completed: 0,
        tasks_failed: 0,
        workflow_runs_completed: 1,
      },
    },
  }),
}));
mock.module("@/api/hooks/use-tasks", () => ({ useTasks: () => ({ data: { tasks: [{}] } }) }));
mock.module("@/api/hooks/use-feedback", () => ({ useSubmitFeedback: () => ({}) }));
mock.module("@/lib/feedback-popup", () => require("../../lib/feedback-popup"));
mock.module("@/lib/utils", () => require("../../lib/utils"));
mock.module("@/components/shared/image-preview", () => require("./image-preview"));
mock.module("@/components/ui/label", () => ({ Label: Box }));
mock.module("@/components/ui/textarea", () => ({ Textarea: () => <textarea /> }));
mock.module("@/lib/user-role", () => require("../../lib/user-role"));
mock.module("@/lib/org-name-prompt", () => require("../../lib/org-name-prompt"));
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
mock.module("@/components/ui/input", () => ({
  Input: (props: Record<string, unknown>) => <input {...props} />,
}));
mock.module("@/components/ui/settings-row", () => ({ SettingsRow: Box }));
mock.module("@/components/ui/dialog", () => ({
  Dialog: ({
    open,
    children,
    onOpenChange,
  }: {
    open: boolean;
    children: ReactNode;
    onOpenChange: (open: boolean) => void;
  }) =>
    open ? (
      <div role="dialog">
        {children}
        <button type="button" onClick={() => onOpenChange(false)}>
          Close
        </button>
      </div>
    ) : null,
  DialogContent: Box,
  DialogDescription: Box,
  DialogFooter: Box,
  DialogHeader: Box,
  DialogTitle: Box,
}));
const { OrganizationNameDialog } = await import("./organization-name-dialog");
let cleanup: (() => Promise<void>) | undefined;
async function mount() {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(<OrganizationNameDialog />));
  cleanup = async () => {
    await act(async () => root.unmount());
    container.remove();
  };
  return container;
}
afterEach(async () => {
  await cleanup?.();
  cleanup = undefined;
  sessionStorage.clear();
  sentEvents.length = 0;
  upserts.length = 0;
  consents.length = 0;
  role = "admin";
  pathname = "/";
  apiUrl = "https://swarm.example";
});
afterAll(async () => {
  await GlobalRegistrator.unregister();
});

for (const action of ["Later", "Close"]) {
  test(`${action} persists dismissal across remounts`, async () => {
    const container = await mount();
    expect(container.querySelector('[role="dialog"]')).not.toBeNull();
    const button = [...container.querySelectorAll("button")].find(
      (item) => item.textContent === action,
    );
    await act(async () => button?.click());
    expect(sessionStorage.getItem(key())).toBe("1");
    await cleanup?.();
    expect((await mount()).querySelector('[role="dialog"]')).toBeNull();
  });
}
test("reports popup.shown once and popup.dismissed with the method", async () => {
  const container = await mount();
  const later = [...container.querySelectorAll("button")].find(
    (item) => item.textContent === "Later",
  );
  await act(async () => later?.click());
  expect(sentEvents).toEqual([
    { event: "popup.shown", properties: { popup: "org_name", trigger: "missing_org_name" } },
    { event: "popup.dismissed", properties: { popup: "org_name", method: "later" } },
  ]);
});
test("closing the dialog reports method close", async () => {
  const container = await mount();
  const close = [...container.querySelectorAll("button")].find(
    (item) => item.textContent === "Close",
  );
  await act(async () => close?.click());
  expect(sentEvents.at(-1)).toEqual({
    event: "popup.dismissed",
    properties: { popup: "org_name", method: "close" },
  });
});
test("clearing session storage lets a new session prompt again", async () => {
  sessionStorage.setItem(key(), "1");
  expect((await mount()).querySelector('[role="dialog"]')).toBeNull();
  await cleanup?.();
  sessionStorage.clear();
  expect((await mount()).querySelector('[role="dialog"]')).not.toBeNull();
});
test("members never see the prompt", async () => {
  role = "member";
  expect((await mount()).querySelector('[role="dialog"]')).toBeNull();
});
test("deferral belongs to its API connection", async () => {
  sessionStorage.setItem(key(), "1");
  apiUrl = "https://another.example";
  expect((await mount()).querySelector('[role="dialog"]')).not.toBeNull();
});

test("feedback stays hidden after the org prompt closes", async () => {
  const { FeedbackDialog } = await import("../feedback/feedback-dialog");
  apiUrl = "https://feedback-dialog.example";
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(<FeedbackDialog />));
  expect(container.querySelector('[role="dialog"]')).not.toBeNull();
  await act(async () => root.render(<OrganizationNameDialog />));
  const later = [...container.querySelectorAll("button")].find(
    (item) => item.textContent === "Later",
  );
  await act(async () => later?.click());
  await act(async () => root.render(<FeedbackDialog />));
  expect(container.querySelector('[role="dialog"]')).toBeNull();
  await act(async () => root.unmount());
  container.remove();
});

test("non-Home pages leave naming to the notification bell", async () => {
  pathname = "/tasks";
  expect((await mount()).querySelector('[role="dialog"]')).toBeNull();
  expect(sessionStorage.getItem(key())).toBeNull();
});

async function typeInto(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  await act(async () => {
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

test("saves the normalized website and the used-by consent with the name", async () => {
  const container = await mount();
  const checkbox = container.querySelector('input[type="checkbox"]') as HTMLInputElement;
  expect(checkbox.disabled).toBe(true);
  await typeInto(container.querySelector("#organization-name") as HTMLInputElement, "Acme");
  await typeInto(
    container.querySelector("#organization-website") as HTMLInputElement,
    "https://www.Acme.com/about",
  );
  expect(checkbox.disabled).toBe(false);
  await act(async () => checkbox.click());
  const form = container.querySelector("form") as HTMLFormElement;
  await act(async () => form.requestSubmit());
  expect(upserts.map(({ key, value }) => [key, value])).toEqual([
    ["SWARM_ORG_NAME", "Acme"],
    ["SWARM_ORG_WEBSITE", "acme.com"],
  ]);
  expect(consents).toEqual([true]);
  expect(sentEvents).toContainEqual({
    event: "org.profile_updated",
    properties: { fields: ["name", "website"], surface: "prompt" },
  });
});

test("previews the logo the website will fill as you type", async () => {
  const container = await mount();
  expect(container.querySelector('[data-testid="image-preview"] img')).toBeNull();
  await typeInto(
    container.querySelector("#organization-website") as HTMLInputElement,
    "https://www.Acme.com/about",
  );
  expect(container.querySelector('[data-testid="image-preview"] img')?.getAttribute("src")).toBe(
    "https://proxy.desplega.sh/v1/logo?domain=acme.com",
  );
});

test("an invalid website blocks saving", async () => {
  const container = await mount();
  await typeInto(container.querySelector("#organization-name") as HTMLInputElement, "Acme");
  await typeInto(container.querySelector("#organization-website") as HTMLInputElement, "localhost");
  expect(
    (container.querySelector("#organization-website") as HTMLInputElement).getAttribute(
      "aria-invalid",
    ),
  ).toBe("true");
  const form = container.querySelector("form") as HTMLFormElement;
  await act(async () => form.requestSubmit());
  expect(upserts).toEqual([]);
});
