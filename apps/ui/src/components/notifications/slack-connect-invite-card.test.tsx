import { afterAll, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, type ReactNode } from "react";

GlobalRegistrator.register();
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const { createRoot } = await import("react-dom/client");

const Box = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
mock.module("sonner", () => ({ toast: { success: () => {} } }));
mock.module("@/api/hooks/use-inbox-state", () => ({
  useUpdateInboxItem: () => ({ mutate: () => {} }),
}));
mock.module("@/api/hooks/use-notification-events", () => ({
  useNotificationEvents: () => ({ trackEvent: () => {}, notifyUs: () => {} }),
}));
mock.module("@/components/ui/badge", () => ({ Badge: Box }));
mock.module("@/components/ui/button", () => ({
  Button: ({ children }: { children: ReactNode }) => <button type="button">{children}</button>,
}));
mock.module("@/components/ui/input", () => ({ Input: () => <input /> }));
mock.module("@/contexts/current-user-context", () => ({
  useCurrentUser: () => ({ userId: "u1" }),
}));

const { SlackConnectInviteCard } = await import("./slack-connect-invite-card");

afterAll(async () => {
  await GlobalRegistrator.unregister();
});

test("the invite card offers OK and Dismiss, and no 'I already have one'", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const definition = {
    key: "slack-connect-invite",
    title: "Get a shared Slack channel",
    body: "Talk to the team.",
  } as never;
  await act(async () => root.render(<SlackConnectInviteCard definition={definition} />));
  const labels = [...container.querySelectorAll("button")].map((b) => b.textContent);
  expect(labels).toEqual(["OK", "Dismiss"]);
  expect(container.textContent).not.toContain("I already have one");
  await act(async () => root.unmount());
  container.remove();
});
