import { afterAll, afterEach, beforeEach, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, type ReactNode, useState } from "react";
import type { SlackConnectMoment } from "@/api/types";

GlobalRegistrator.register();
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const { createRoot } = await import("react-dom/client");

let moment: SlackConnectMoment | null = "task_failed";
/** What each stub flow submits, by the id of its first question. */
let flowValues: Record<string, Record<string, unknown>> = {};
const requests: Array<{ email: string; details: Record<string, unknown> }> = [];
const tracked: Array<{ action: string; properties?: Record<string, unknown> }> = [];
const Box = ({ children }: { children?: ReactNode }) => <div>{children}</div>;

mock.module("@/hooks/use-slack-connect-invite", () => ({
  useSlackConnectInvite: () => ({ dismiss: () => tracked.push({ action: "dismiss" }) }),
  useRequestSlackConnectInvite: () => async (email: string, details: Record<string, unknown>) => {
    requests.push({ email, details });
  },
}));
mock.module("@/api/hooks/use-company-profile", () => ({
  useCompanyProfile: () => ({ teamSize: null }),
}));
mock.module("@/api/hooks/use-notification-events", () => ({
  useNotificationEvents: () => ({
    trackEvent: (_key: string, action: string, properties?: Record<string, unknown>) =>
      tracked.push({ action, properties }),
  }),
}));
mock.module("@/api/hooks/use-ui-telemetry", () => ({ useUiTelemetry: () => () => {} }));
// The shared flow is tested on its own: this stub lists the cards and submits `flowValues`.
mock.module("@/components/shared/question-flow", () => ({
  QuestionFlow: ({
    questions,
    footer,
    done,
    onSubmit,
  }: {
    questions: Array<{ id: string; label: string; description?: string }>;
    footer?: ReactNode;
    done?: (values: Record<string, unknown>) => ReactNode;
    onSubmit: (values: Record<string, unknown>) => Promise<void>;
  }) => {
    const [sent, setSent] = useState(false);
    const values = flowValues[questions[0]?.id ?? ""] ?? {};
    if (sent) return <div>{done?.(values)}</div>;
    return (
      <div>
        {questions.map((question) => (
          <p key={question.id}>
            {question.label} {question.description}
          </p>
        ))}
        {footer}
        <button
          type="button"
          onClick={() =>
            onSubmit(values).then(
              () => setSent(true),
              () => {},
            )
          }
        >
          Submit
        </button>
      </div>
    );
  },
}));
mock.module("@/components/shared/setup-card", () => ({
  SetupCard: ({
    title,
    description,
    status,
    children,
  }: {
    title: ReactNode;
    description?: ReactNode;
    status?: ReactNode;
    children?: ReactNode;
  }) => (
    <section>
      <h3>{title}</h3>
      <p>{description}</p>
      {status}
      {children}
    </section>
  ),
}));
mock.module("@/components/shared/setup-chip", () => ({ SetupChip: Box }));
mock.module("@/components/shared/border-beam", () => ({ BorderBeam: () => null }));
mock.module("@/components/shared/status-icon", () => ({ StatusLine: Box }));
mock.module("@/components/ui/button", () => ({
  Button: ({
    children,
    onClick,
    asChild,
  }: {
    children: ReactNode;
    onClick?: () => void;
    asChild?: boolean;
  }) =>
    asChild ? (
      children
    ) : (
      <button type="button" onClick={onClick}>
        {children}
      </button>
    ),
}));
mock.module("@/contexts/current-user-context", () => ({
  useCurrentUser: () => ({ userId: "u1", user: { email: "dana@acme.com", metadata: {} } }),
}));
mock.module("@/lib/company-profile", () => require("../../lib/company-profile"));

const { SlackConnectInviteCard } = await import("./slack-connect-invite-card");

const definition = {
  key: "slack_connect_invite",
  title: "Connect with us on Slack",
  body: "A shared Slack channel.",
};

let cleanup: (() => Promise<void>) | undefined;
async function mount(state?: { status: string }) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () =>
    root.render(
      <SlackConnectInviteCard definition={definition} state={state as never} moment={moment} />,
    ),
  );
  cleanup = async () => {
    await act(async () => root.unmount());
    container.remove();
  };
  return container;
}
const button = (container: HTMLElement, label: string) =>
  [...container.querySelectorAll("button")].find((b) => b.textContent === label);

beforeEach(() => {
  moment = "task_failed";
  flowValues = {};
  requests.length = 0;
  tracked.length = 0;
});
afterEach(async () => {
  await cleanup?.();
  cleanup = undefined;
});
afterAll(async () => {
  await GlobalRegistrator.unregister();
});

test("the copy follows the moment, and default keeps the definition's copy", async () => {
  let container = await mount();
  expect(container.textContent).toContain("A task failed. Want a hand?");
  await cleanup?.();
  moment = "default";
  container = await mount();
  expect(container.textContent).toContain("Connect with us on Slack");
  expect(container.textContent).toContain("Pre-filled from your profile.");
  await cleanup?.();
  moment = null;
  container = await mount();
  expect(container.textContent).toContain("Connect with us on Slack");
});

test("the role is optional: unset, it stays out of the request and the event", async () => {
  moment = null;
  flowValues = { email: { email: "dana@acme.com" } };
  const container = await mount();
  await act(async () => button(container, "Submit")?.click());
  expect(requests).toHaveLength(1);
  expect(requests[0]?.details).not.toHaveProperty("user_function");
  expect(requests[0]?.details.moment).toBeUndefined();
  expect(tracked).toHaveLength(1);
  expect(tracked[0]?.properties).not.toHaveProperty("user_function");
  expect(tracked[0]?.properties).toMatchObject({ email_domain: "acme.com" });
});

test("Submit requests the invite, then the second set updates the same submission", async () => {
  flowValues = {
    email: { email: "dana@acme.com", user_function: "eng_lead" },
    team_size: { team_size: "11-50", working_on: "PR reviews" },
  };
  const container = await mount();
  await act(async () => button(container, "Submit")?.click());
  expect(requests).toHaveLength(1);
  expect(requests[0]).toMatchObject({
    email: "dana@acme.com",
    details: { moment: "task_failed", user_function: "eng_lead" },
  });
  expect(tracked).toEqual([
    {
      action: "submit",
      properties: { email_domain: "acme.com", moment: "task_failed", user_function: "eng_lead" },
    },
  ]);
  expect(container.textContent).toContain("We invite dana@acme.com within a business day");

  await act(async () => button(container, "Submit")?.click());
  expect(requests).toHaveLength(2);
  expect(requests[1]?.details).toMatchObject({
    submission_id: requests[0]?.details.submission_id,
    team_size: "11-50",
    working_on: "PR reviews",
  });
  expect(container.textContent).toContain("Book a kickoff call");
});

test("an invalid email does not send", async () => {
  flowValues = { email: { email: "dana", user_function: "engineer" } };
  const container = await mount();
  await act(async () => button(container, "Submit")?.click());
  expect(requests).toEqual([]);
});

test("a resolved invite shows its state and no form", async () => {
  const container = await mount({ status: "dismissed" });
  expect(container.textContent).toContain("Dismissed");
  expect(button(container, "Submit")).toBeUndefined();
});
