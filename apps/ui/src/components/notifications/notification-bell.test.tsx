import { afterAll, afterEach, beforeEach, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, type ReactNode } from "react";

GlobalRegistrator.register();
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const { createRoot } = await import("react-dom/client");

let inboxRows: Array<{ itemId: string; status: string; readAt?: string }> = [];
let liveMoment: string | null = "task_failed";
/** The `enabled` argument of each `useSlackConnectMoment` call. */
const momentEnabled: boolean[] = [];
const tracked: Array<{ key: string; action: string; properties?: Record<string, unknown> }> = [];
/** The `inviteMoment` the panel got on its last render. */
let panelMoment: string | null | undefined;

const Box = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
mock.module("@/api/hooks/use-agent-fs", () => ({ useAgentFsMentions: () => ({ drive: false }) }));
mock.module("@/api/hooks/use-inbox-state", () => ({
  useInboxState: () => ({ data: inboxRows }),
  useUpdateInboxItem: () => ({ mutate: () => {} }),
}));
mock.module("@/api/hooks/use-notification-events", () => ({
  useNotificationEvents: () => ({
    trackEvent: (key: string, action: string, properties?: Record<string, unknown>) =>
      tracked.push({ key, action, properties }),
  }),
}));
mock.module("@/components/ui/badge", () => ({ Badge: Box }));
mock.module("@/components/ui/button", () => ({ Button: Box }));
mock.module("@/components/ui/popover", () => ({
  Popover: ({
    onOpenChange,
    children,
  }: {
    onOpenChange: (open: boolean) => void;
    children?: ReactNode;
  }) => (
    <div>
      <button type="button" onClick={() => onOpenChange(true)}>
        open
      </button>
      <button type="button" onClick={() => onOpenChange(false)}>
        close
      </button>
      {children}
    </div>
  ),
  PopoverTrigger: Box,
  PopoverContent: Box,
}));
mock.module("@/contexts/current-user-context", () => ({
  useCurrentUser: () => ({ userId: "admin", user: { role: "admin" } }),
}));
mock.module("@/lib/notifications/definitions", () =>
  require("../../lib/notifications/definitions"),
);
mock.module("@/lib/notifications/unread", () => require("../../lib/notifications/unread"));
mock.module("./notification-panel", () => ({
  NotificationPanel: ({
    definitions,
    inviteMoment,
  }: {
    definitions: Array<{ key: string }>;
    inviteMoment: string | null;
  }) => {
    panelMoment = inviteMoment;
    return (
      <ul>
        {definitions.map((definition) => (
          <li key={definition.key}>{definition.key}</li>
        ))}
      </ul>
    );
  },
}));

mock.module("@/hooks/use-slack-connect-invite", () => ({
  SLACK_CONNECT_INVITE_KEY: "slack_connect_invite",
}));
mock.module("./use-slack-connect-moment", () => ({
  useSlackConnectMoment: (enabled: boolean) => {
    momentEnabled.push(enabled);
    return enabled ? liveMoment : null;
  },
}));

const { NotificationBell } = await import("./notification-bell");

let rerender: (() => Promise<void>) | undefined;
let cleanup: (() => Promise<void>) | undefined;
async function mount() {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(<NotificationBell />));
  rerender = async () => {
    await act(async () => root.render(<NotificationBell />));
  };
  cleanup = async () => {
    await act(async () => root.unmount());
    container.remove();
  };
  return container;
}
const keys = (container: HTMLElement) =>
  [...container.querySelectorAll("li")].map((item) => item.textContent);
const click = (container: HTMLElement, label: string) =>
  act(async () => {
    [...container.querySelectorAll("button")].find((b) => b.textContent === label)?.click();
  });

beforeEach(() => {
  inboxRows = [];
  liveMoment = "task_failed";
  momentEnabled.length = 0;
  tracked.length = 0;
  panelMoment = undefined;
});
afterEach(async () => {
  await cleanup?.();
  cleanup = undefined;
  rerender = undefined;
  sessionStorage.clear();
});
afterAll(async () => {
  await GlobalRegistrator.unregister();
});

test("the bell lists only the static notifications", async () => {
  expect(keys(await mount())).toEqual(["slack_connect_invite"]);
});

test("the moment is pinned when the bell opens and used for the view", async () => {
  const container = await mount();
  await click(container, "open");
  expect(tracked).toEqual([
    { key: "slack_connect_invite", action: "view", properties: { moment: "task_failed" } },
  ]);
  expect(panelMoment).toBe("task_failed");
  liveMoment = "first_workflow";
  await rerender?.();
  expect(panelMoment).toBe("task_failed");
});

test("a moment still loading at open is pinned, and viewed, once it resolves", async () => {
  liveMoment = null;
  const container = await mount();
  await click(container, "open");
  expect(tracked).toEqual([]);
  expect(panelMoment).toBeNull();
  liveMoment = "first_workflow";
  await rerender?.();
  expect(panelMoment).toBe("first_workflow");
  expect(tracked).toEqual([
    { key: "slack_connect_invite", action: "view", properties: { moment: "first_workflow" } },
  ]);
});

test("a dismissed or done invite does not poll for its moment", async () => {
  inboxRows = [{ itemId: "slack_connect_invite", status: "dismissed" }];
  await mount();
  expect(momentEnabled.length).toBeGreaterThan(0);
  expect(momentEnabled.every((enabled) => !enabled)).toBe(true);
  await cleanup?.();
  momentEnabled.length = 0;
  inboxRows = [{ itemId: "slack_connect_invite", status: "open" }];
  await mount();
  expect(momentEnabled.every((enabled) => enabled)).toBe(true);
});
