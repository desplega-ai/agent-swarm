import { afterAll, afterEach, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, type ReactNode } from "react";

GlobalRegistrator.register();
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const { createRoot } = await import("react-dom/client");

const apiUrl = "https://bell.example";
let pathname = "/";
const Box = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
mock.module("react-router-dom", () => ({ useLocation: () => ({ pathname }) }));
mock.module("@/api/hooks/use-agent-fs", () => ({ useAgentFsMentions: () => ({ drive: false }) }));
mock.module("@/api/hooks/use-inbox-state", () => ({
  useInboxState: () => ({ data: [] }),
  useUpdateInboxItem: () => ({ mutate: () => {} }),
}));
mock.module("@/api/hooks/use-integrations-meta", () => ({
  useEnvPresence: () => ({
    data: { SWARM_ORG_NAME: false },
    dataUpdatedAt: Date.now() + 60_000,
    isError: false,
  }),
}));
mock.module("@/api/hooks/use-notification-events", () => ({
  useNotificationEvents: () => ({ trackEvent: () => {} }),
}));
mock.module("@/api/hooks/use-onboarding", () => ({ useOnboardingOwnsFirstRun: () => false }));
mock.module("@/components/ui/badge", () => ({ Badge: Box }));
mock.module("@/components/ui/button", () => ({ Button: Box }));
mock.module("@/components/ui/popover", () => ({
  Popover: Box,
  PopoverTrigger: Box,
  PopoverContent: Box,
}));
mock.module("@/contexts/current-user-context", () => ({
  useCurrentUser: () => ({ userId: "admin", user: { role: "admin" } }),
}));
mock.module("@/hooks/use-config", () => ({ useConfig: () => ({ config: { apiUrl } }) }));
mock.module("@/lib/notifications/definitions", () =>
  require("../../lib/notifications/definitions"),
);
mock.module("@/lib/notifications/unread", () => require("../../lib/notifications/unread"));
mock.module("@/lib/org-name-prompt", () => require("../../lib/org-name-prompt"));
mock.module("@/lib/user-role", () => require("../../lib/user-role"));
mock.module("./notification-panel", () => ({
  NotificationPanel: ({ definitions }: { definitions: Array<{ key: string }> }) => (
    <ul>
      {definitions.map((definition) => (
        <li key={definition.key}>{definition.key}</li>
      ))}
    </ul>
  ),
}));

const { NotificationBell } = await import("./notification-bell");
const { deferOrgNamePrompt } = await import("../../lib/org-name-prompt");

let cleanup: (() => Promise<void>) | undefined;
async function mount() {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(<NotificationBell />));
  cleanup = async () => {
    await act(async () => root.unmount());
    container.remove();
  };
  return container;
}
const keys = (container: HTMLElement) =>
  [...container.querySelectorAll("li")].map((item) => item.textContent);

afterEach(async () => {
  await cleanup?.();
  cleanup = undefined;
  sessionStorage.clear();
  pathname = "/";
});
afterAll(async () => {
  await GlobalRegistrator.unregister();
});

test("Home leaves the org-name ask to the dialog until Later", async () => {
  const container = await mount();
  expect(keys(container)).not.toContain("organization_name");
  await act(async () => deferOrgNamePrompt(apiUrl));
  expect(keys(container)).toContain("organization_name");
});

test("off Home the bell carries the org-name ask", async () => {
  pathname = "/tasks";
  expect(keys(await mount())).toContain("organization_name");
});
