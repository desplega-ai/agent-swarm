import { afterAll, afterEach, beforeEach, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, type ReactNode, useState } from "react";
import type { ApprovalQuestion, UsedByConsentInput } from "@/api/types";

GlobalRegistrator.register();
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const { createRoot } = await import("react-dom/client");

let configs: Array<{ key: string; value: string }> = [];
let consentCalls: UsedByConsentInput[] = [];
let slackCalls: Array<{ email: string; details: unknown }> = [];
let tracked: Array<{ key: string; action: string; properties: unknown }> = [];
let inbox: Array<{ itemId: string; status: string }> = [];
let role: string | undefined;
/** What the stub flow submits when its Submit is clicked. */
let answers: Record<string, unknown> = {};
let flowError: string | null = null;

const Box = ({ children }: { children?: ReactNode }) => <div>{children}</div>;

mock.module("@/lib/company-profile", () => require("../../lib/company-profile"));
mock.module("@/api/hooks/use-config-api", () => ({ useConfigs: () => ({ data: configs }) }));
mock.module("@/api/hooks/use-org-profile", () => ({
  useSetUsedByConsent: () => ({
    isPending: false,
    mutate: (input: UsedByConsentInput) => consentCalls.push(input),
    mutateAsync: async (input: UsedByConsentInput) => {
      consentCalls.push(input);
    },
  }),
}));
mock.module("@/app/status-context", () => ({
  useStatusContext: () => ({ data: { identity: { logo_url: null } } }),
}));
mock.module("@/contexts/current-user-context", () => ({
  useCurrentUser: () => ({
    userId: "u1",
    user: { email: "dana@acme.com", role, metadata: { jobFunction: "founder" } },
  }),
}));
mock.module("@/lib/user-role", () => require("../../lib/user-role"));
mock.module("@/api/hooks/use-inbox-state", () => ({
  useInboxState: () => ({ data: inbox }),
  useUpdateInboxItem: () => ({ mutate: () => {} }),
}));
mock.module("@/api/hooks/use-notification-events", () => ({
  useNotificationEvents: () => ({
    trackEvent: (key: string, action: string, properties: unknown) =>
      tracked.push({ key, action, properties }),
    notifyUs: async (_key: string, _note: string, email: string, details: unknown) => {
      slackCalls.push({ email, details });
    },
  }),
}));
mock.module("@/hooks/use-swarm-config", () => ({
  isTruthyConfigValue: (value: string) => value === "true",
}));
// The real perk hook, so the request, the event and the done check are the shared ones.
mock.module("@/hooks/use-slack-connect-invite", () =>
  require("../../hooks/use-slack-connect-invite"),
);
mock.module("sonner", () => ({ toast: { success: () => {}, error: () => {} } }));
mock.module("@/components/shared/fade-in", () => ({ FadeIn: Box }));
mock.module("@/components/shared/setup-card", () => ({
  SetupCard: ({ title, children }: { title: ReactNode; children: ReactNode }) => (
    <section>
      {title}
      {children}
    </section>
  ),
}));
mock.module("@/components/shared/setup-chip", () => ({ SetupChip: Box }));
mock.module("@/components/shared/border-beam", () => ({ BorderBeam: () => null }));
mock.module("@/components/shared/status-icon", () => ({ StatusLine: Box }));
mock.module("@/components/ui/avatar", () => ({
  Avatar: Box,
  AvatarImage: () => null,
  AvatarFallback: Box,
}));
mock.module("@/components/ui/button", () => ({
  Button: ({
    children,
    onClick,
    "aria-disabled": ariaDisabled,
  }: {
    children: ReactNode;
    onClick?: () => void;
    "aria-disabled"?: boolean;
  }) => (
    <button type="button" aria-disabled={ariaDisabled} onClick={onClick}>
      {children}
    </button>
  ),
}));
mock.module("@/components/ui/switch", () => ({
  Switch: ({
    disabled,
    onCheckedChange,
  }: {
    disabled?: boolean;
    onCheckedChange: (next: boolean) => void;
  }) => (
    <button
      type="button"
      role="switch"
      aria-checked="true"
      disabled={disabled}
      onClick={() => onCheckedChange(false)}
    />
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
    const [finished, setFinished] = useState<Record<string, unknown> | null>(null);
    if (finished) return <div>{done(finished)}</div>;
    return (
      <div>
        {questions.map((q) => (
          <p key={q.id}>{q.label}</p>
        ))}
        <p>initial:{JSON.stringify(initialValues)}</p>
        <button
          type="button"
          onClick={() => {
            const values = { ...initialValues, ...answers };
            onSubmit(values).then(
              () => setFinished(values),
              (error: Error) => {
                flowError = error.message;
              },
            );
          }}
        >
          Submit
        </button>
      </div>
    );
  },
}));

const { UsedByConsentRow } = await import("./used-by-consent-row");

let container: HTMLDivElement;
let cleanup: (() => Promise<void>) | undefined;
async function mount() {
  container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(<UsedByConsentRow />));
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
  configs = [
    { key: "SWARM_ORG_NAME", value: "Acme" },
    { key: "SWARM_ORG_WEBSITE", value: "acme.com" },
  ];
  consentCalls = [];
  slackCalls = [];
  tracked = [];
  inbox = [];
  role = undefined;
  answers = {};
  flowError = null;
});
afterEach(async () => {
  await cleanup?.();
  cleanup = undefined;
});
afterAll(async () => {
  await GlobalRegistrator.unregister();
});

test("the offer previews the listing; the flow pre-fills the user's email and job function", async () => {
  await mount();
  expect(container.textContent).toContain("Feature Acme on agent-swarm.dev");
  expect(container.textContent).toContain("A shared Slack channel");
  await click("Get featured");
  expect(container.textContent).toContain("Send these details to Desplega and list Acme");
  expect(container.textContent).toContain(
    'initial:{"contact_email":"dana@acme.com","contact_function":"founder"}',
  );
});

test("a yes grants with the contact details, then asks for the Slack channel", async () => {
  await mount();
  await click("Get featured");
  answers = { consent: true, contact_function: "eng_lead", quote: "  Reviews every PR.  " };
  await click("Submit");
  expect(consentCalls).toEqual([
    {
      granted: true,
      contactEmail: "dana@acme.com",
      contactFunction: "eng_lead",
      quote: "Reviews every PR.",
    },
  ]);
  expect(slackCalls).toEqual([{ email: "dana@acme.com", details: { user_function: "eng_lead" } }]);
  expect(tracked).toEqual([
    {
      key: "slack_connect_invite",
      action: "submit",
      properties: { email_domain: "acme.com", user_function: "eng_lead" },
    },
  ]);
});

test("an invite this user already requested is not sent again, and the copy says so", async () => {
  inbox = [{ itemId: "slack_connect_invite", status: "done" }];
  await mount();
  expect(container.textContent).toContain("Agent Swarm (already requested)");
  await click("Get featured");
  answers = { consent: true };
  await click("Submit");
  expect(consentCalls).toHaveLength(1);
  expect(slackCalls).toEqual([]);
  expect(tracked).toEqual([]);
  expect(container.textContent).toContain("Your Slack channel request was already in.");
});

test("a non-admin sees the offer read-only and cannot revoke", async () => {
  role = "member";
  await mount();
  expect(container.textContent).toContain("Feature Acme on agent-swarm.dev");
  expect(container.textContent).toContain("Ask an admin to get Acme featured.");
  expect([...container.querySelectorAll("button")].map((b) => b.textContent)).not.toContain(
    "Get featured",
  );
  await cleanup?.();
  configs = [...configs, { key: "SWARM_USED_BY_CONSENT", value: "true" }];
  await mount();
  expect(container.textContent).toContain("An admin can turn it off");
  const toggle = container.querySelector('[role="switch"]') as HTMLButtonElement;
  expect(toggle.disabled).toBe(true);
});

test("a no sends nothing", async () => {
  await mount();
  await click("Get featured");
  answers = { consent: false };
  await click("Submit");
  expect(consentCalls).toEqual([]);
  expect(slackCalls).toEqual([]);
  expect(container.textContent).toContain("Nothing was sent to Desplega.");
});

test("an invalid email or a long quote is refused before any request", async () => {
  await mount();
  await click("Get featured");
  answers = { consent: true, contact_email: "dana" };
  await click("Submit");
  expect(flowError).toBe("Enter a valid contact email.");
  answers = { consent: true, quote: "x".repeat(281) };
  await click("Submit");
  expect(flowError).toBe("Keep the line to 280 characters (now 281).");
  expect(consentCalls).toEqual([]);
});

test("without a name and website, Get featured does nothing and says why", async () => {
  configs = [{ key: "SWARM_ORG_NAME", value: "Acme" }];
  await mount();
  expect(container.textContent).toContain("Set the organization name and company website");
  await click("Get featured");
  expect(container.textContent).not.toContain("Send these details");
});

test("granted: the preview shows the quote, and the switch revokes without an email", async () => {
  configs = [
    ...configs,
    { key: "SWARM_USED_BY_CONSENT", value: "true" },
    // The API masks the secret email row.
    { key: "SWARM_USED_BY_CONTACT_EMAIL", value: "********" },
    { key: "SWARM_USED_BY_CONTACT_FUNCTION", value: "eng_lead" },
    { key: "SWARM_USED_BY_QUOTE", value: "Reviews every PR." },
  ];
  await mount();
  expect(container.textContent).toContain("writes to the contact email you gave");
  expect(container.textContent).not.toContain("********");
  expect(container.textContent).toContain('"Reviews every PR.", Engineering lead at Acme');
  const toggle = container.querySelector('[role="switch"]') as HTMLButtonElement;
  await act(async () => toggle.click());
  expect(consentCalls).toEqual([{ granted: false }]);
});
