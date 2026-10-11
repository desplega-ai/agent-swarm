import { afterAll, afterEach, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, type ReactNode } from "react";

GlobalRegistrator.register();
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const { createRoot } = await import("react-dom/client");
let role = "admin";
let apiUrl = "https://swarm.example";
const key = () => `swarm:org-name-prompt:later:v1:${apiUrl}`;
const Box = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
mock.module("@/api/hooks/use-config-api", () => ({
  useUpsertConfig: () => ({}),
  useConfigs: () => ({
    data: [
      { key: "telemetry_installed_at", value: new Date(Date.now() - 5 * 86400000).toISOString() },
    ],
  }),
}));
mock.module("@/api/hooks/use-integrations-meta", () => ({
  useEnvPresence: () => ({ data: { SWARM_ORG_NAME: false }, dataUpdatedAt: Date.now() + 1000 }),
  useReloadConfig: () => ({}),
}));
mock.module("@/api/hooks/use-onboarding", () => ({ useOnboardingOwnsFirstRun: () => false }));
mock.module("@/contexts/current-user-context", () => ({
  useCurrentUser: () => ({ state: "ready", userId: "admin", user: { role } }),
}));
mock.module("@/hooks/use-config", () => ({ useConfig: () => ({ config: { apiUrl } }) }));
mock.module("@/hooks/use-other-dialog-open", () => ({
  ...require("../../hooks/use-other-dialog-open"),
  useOtherDialogOpen: () => false,
}));
mock.module("@/app/status-context", () => ({
  useStatusContext: () => ({ data: { identity: { is_cloud: false, name: "" } } }),
}));
mock.module("@/api/hooks/use-tasks", () => ({ useTasks: () => ({ data: { tasks: [{}] } }) }));
mock.module("@/api/hooks/use-feedback", () => ({ useSubmitFeedback: () => ({}) }));
mock.module("@/lib/feedback-popup", () => require("../../lib/feedback-popup"));
mock.module("@/lib/utils", () => require("../../lib/utils"));
mock.module("@/components/ui/label", () => ({ Label: Box }));
mock.module("@/components/ui/textarea", () => ({ Textarea: () => <textarea /> }));
mock.module("@/lib/user-role", () => require("../../lib/user-role"));
mock.module("@/components/ui/button", () => ({
  Button: ({ children, onClick }: { children: ReactNode; onClick?: () => void }) => (
    <button type="button" onClick={onClick}>
      {children}
    </button>
  ),
}));
mock.module("@/components/ui/input", () => ({ Input: () => <input /> }));
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
  role = "admin";
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
