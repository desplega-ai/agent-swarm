import { afterAll, afterEach, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, type ReactNode } from "react";

GlobalRegistrator.register();
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const { createRoot } = await import("react-dom/client");
let role = "";
let userEmail: string | undefined = "ada@acme.com";
let orgDomain = "acme.com";
let apiUrl = "https://swarm.example";
let namePresent = false;
let statusName = "Swarm";
// A future time reads as a profile fetched after mount. A past time is a persisted snapshot.
let configsUpdatedAt = Date.now() + 1000;
const Box = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
const upserts: Array<{ key: string; value: string }> = [];
const consents: unknown[] = [];
const invites: string[] = [];
const tracked: Array<{ key: string; action: string; properties: unknown }> = [];
let inbox: Array<{ itemId: string; status: string }> = [];
const toasts: string[] = [];
// Set to hold a request until the test releases it.
let upsertGate: Promise<void> | null = null;
let perkGate: Promise<void> | null = null;
let inviteFails = false;
mock.module("@/api/hooks/use-config-api", () => ({
  useUpsertConfig: () => ({
    mutateAsync: async (input: { key: string; value: string }) => {
      await upsertGate;
      upserts.push(input);
    },
  }),
  useConfigs: () => ({
    data: [{ key: "telemetry_org_domain", value: orgDomain }],
    dataUpdatedAt: configsUpdatedAt,
  }),
}));
mock.module("@/api/hooks/use-integrations-meta", () => ({
  useEnvPresence: () => ({
    data: { SWARM_ORG_NAME: namePresent },
    dataUpdatedAt: Date.now() + 1000,
  }),
}));
mock.module("@/api/hooks/use-onboarding", () => ({ useOnboardingOwnsFirstRun: () => false }));
mock.module("@/api/hooks/use-org-profile", () => ({
  useSetUsedByConsent: () => ({
    mutateAsync: async (input: unknown) => {
      await perkGate;
      consents.push(input);
    },
  }),
}));
mock.module("@/api/hooks/use-inbox-state", () => ({
  useInboxState: () => ({ data: inbox }),
  useUpdateInboxItem: () => ({ mutate: () => {} }),
}));
mock.module("@/api/hooks/use-notification-events", () => ({
  useNotificationEvents: () => ({
    trackEvent: (key: string, action: string, properties: unknown) =>
      tracked.push({ key, action, properties }),
    notifyUs: async (_key: string, _note: string, email: string) => {
      await perkGate;
      invites.push(email);
      if (inviteFails) throw new Error("proxy down");
    },
  }),
}));
// The real perk hook, so the request, the event and the done check are the shared ones.
mock.module("@/hooks/use-slack-connect-invite", () =>
  require("../../hooks/use-slack-connect-invite"),
);
mock.module("sonner", () => ({
  toast: {
    success: (message: string) => toasts.push(`success: ${message}`),
    error: (message: string) => toasts.push(`error: ${message}`),
  },
}));
const sentEvents: Array<{ event: string; properties: Record<string, unknown> }> = [];
mock.module("@/api/hooks/use-ui-telemetry", () => ({
  isUiTelemetryEnabled: () => true,
  useUiTelemetry: () => (input: { event: string; properties: Record<string, unknown> }) =>
    sentEvents.push(input),
}));
mock.module("@/api/hooks/use-company-profile", () =>
  require("../../api/hooks/use-company-profile"),
);
mock.module("@/lib/company-profile", () => require("../../lib/company-profile"));
mock.module("@/contexts/current-user-context", () => ({
  useCurrentUser: () => ({ state: "ready", userId: "admin", user: { role, email: userEmail } }),
}));
mock.module("@/hooks/use-config", () => ({ useConfig: () => ({ config: { apiUrl } }) }));
mock.module("@/hooks/use-other-dialog-open", () => require("../../hooks/use-other-dialog-open"));
mock.module("@/app/status-context", () => ({
  useStatusContext: () => ({
    data: { identity: { is_cloud: false, name: statusName, logo_url: "" } },
  }),
}));
mock.module("@/lib/utils", () => require("../../lib/utils"));
mock.module("@/lib/user-role", () => require("../../lib/user-role"));
mock.module("@/components/shared/image-preview", () => require("./image-preview"));
mock.module("@/components/shared/animated-reveal", () => ({
  AnimatedReveal: ({ open, children }: { open: boolean; children: ReactNode }) =>
    open ? <div>{children}</div> : null,
}));
mock.module("@/components/shared/status-icon", () => ({ StatusIcon: () => null }));
mock.module("@/components/ui/badge", () => ({ Badge: Box }));
mock.module("@/components/ui/label", () => ({ Label: Box }));
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
const { promptShownThisLoad } = await import("../../hooks/use-other-dialog-open");
let cleanup: (() => Promise<void>) | undefined;
async function mount() {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () =>
    root.render(
      <QueryClientProvider client={new QueryClient()}>
        <OrganizationNameDialog />
      </QueryClientProvider>,
    ),
  );
  cleanup = async () => {
    await act(async () => root.unmount());
    container.remove();
  };
  return container;
}
afterEach(async () => {
  await cleanup?.();
  cleanup = undefined;
  sentEvents.length = 0;
  upserts.length = 0;
  consents.length = 0;
  invites.length = 0;
  tracked.length = 0;
  inbox = [];
  toasts.length = 0;
  upsertGate = null;
  perkGate = null;
  inviteFails = false;
  role = "";
  userEmail = "ada@acme.com";
  orgDomain = "acme.com";
  apiUrl = "https://swarm.example";
  namePresent = false;
  statusName = "Swarm";
  configsUpdatedAt = Date.now() + 1000;
});
afterAll(async () => {
  await GlobalRegistrator.unregister();
});

const input = (container: HTMLElement, id: string) =>
  container.querySelector(`#${id}`) as HTMLInputElement;
const button = (container: HTMLElement, text: string) =>
  [...container.querySelectorAll("button")].find((item) => item.textContent === text);
const checkboxes = (container: HTMLElement) =>
  [...container.querySelectorAll('input[type="checkbox"]')] as HTMLInputElement[];

async function typeInto(field: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  await act(async () => {
    setter?.call(field, value);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function submit(container: HTMLElement) {
  const form = container.querySelector("form") as HTMLFormElement;
  await act(async () => form.requestSubmit());
}

test("cannot be dismissed and reports popup.shown once", async () => {
  const container = await mount();
  expect(button(container, "Later")).toBeUndefined();
  await act(async () => button(container, "Close")?.click());
  expect(container.querySelector('[role="dialog"]')).not.toBeNull();
  expect(sentEvents).toEqual([
    { event: "popup.shown", properties: { popup: "org_name", trigger: "missing_org_name" } },
  ]);
  expect(promptShownThisLoad(apiUrl)).toBe(true);
});

test("stays closed on a persisted profile until a fresh read lands", async () => {
  configsUpdatedAt = Date.now() - 60_000;
  expect((await mount()).querySelector('[role="dialog"]')).toBeNull();
});

test("members never see the prompt", async () => {
  role = "member";
  expect((await mount()).querySelector('[role="dialog"]')).toBeNull();
});

test("pre-fills the name and website from the admin's work domain", async () => {
  const container = await mount();
  expect(input(container, "organization-name").value).toBe("Acme");
  expect(input(container, "organization-website").value).toBe("acme.com");
});

test("never pre-fills from free mail", async () => {
  orgDomain = "gmail.com";
  userEmail = "ada@gmail.com";
  const container = await mount();
  expect(input(container, "organization-name").value).toBe("");
  expect(input(container, "organization-website").value).toBe("");
  await submit(container);
  expect(upserts).toEqual([]);
});

test("saves the confirmed name and website with no perks", async () => {
  const container = await mount();
  await typeInto(input(container, "organization-website"), "https://www.Acme.com/about");
  await submit(container);
  expect(upserts.map(({ key, value }) => [key, value])).toEqual([
    ["SWARM_ORG_NAME", "Acme"],
    ["SWARM_ORG_WEBSITE", "acme.com"],
  ]);
  expect(consents).toEqual([]);
  expect(invites).toEqual([]);
  expect(sentEvents).toContainEqual({
    event: "popup.submitted",
    properties: { popup: "org_name", has_message: false, has_contact: false, perks: [] },
  });
  expect(sentEvents).toContainEqual({
    event: "org.profile_updated",
    properties: { fields: ["name", "website"], surface: "org_name_popup" },
  });
});

test("sends both perks with the one contact email", async () => {
  const container = await mount();
  expect(input(container, "organization-contact")).toBeNull();
  const [featured, slack] = checkboxes(container);
  expect(featured.checked).toBe(false);
  expect(slack.checked).toBe(false);
  await act(async () => featured.click());
  await act(async () => slack.click());
  expect(input(container, "organization-contact").value).toBe("ada@acme.com");
  await typeInto(input(container, "organization-contact"), "ops@acme.com");
  await submit(container);
  expect(consents).toEqual([{ granted: true, contactEmail: "ops@acme.com" }]);
  expect(invites).toEqual(["ops@acme.com"]);
  // After the request lands, and the domain only.
  expect(tracked).toEqual([
    { key: "slack_connect_invite", action: "submit", properties: { email_domain: "acme.com" } },
  ]);
  expect(sentEvents).toContainEqual({
    event: "popup.submitted",
    properties: {
      popup: "org_name",
      has_message: false,
      has_contact: true,
      perks: ["used_by", "slack_connect"],
    },
  });
});

test("an invite this user already requested is not asked again, and the copy says so", async () => {
  inbox = [{ itemId: "slack_connect_invite", status: "done" }];
  const container = await mount();
  expect(container.textContent).toContain("You already asked for a Slack Connect channel");
  // Only the logo perk is left to tick.
  const boxes = checkboxes(container);
  expect(boxes).toHaveLength(1);
  await act(async () => boxes[0].click());
  await submit(container);
  expect(consents).toEqual([{ granted: true, contactEmail: "ada@acme.com" }]);
  expect(invites).toEqual([]);
  expect(tracked).toEqual([]);
  expect(sentEvents).toContainEqual({
    event: "popup.submitted",
    properties: { popup: "org_name", has_message: false, has_contact: true, perks: ["used_by"] },
  });
});

test("a failed Slack Connect request sends no notification.submitted", async () => {
  inviteFails = true;
  const container = await mount();
  await act(async () => checkboxes(container)[1].click());
  await submit(container);
  expect(invites).toEqual(["ada@acme.com"]);
  expect(tracked).toEqual([]);
  expect(toasts).toEqual(["error: Saved. The Slack Connect request did not go through."]);
});

test("a ticked perk needs a valid contact email", async () => {
  const container = await mount();
  await act(async () => checkboxes(container)[1].click());
  await typeInto(input(container, "organization-contact"), "nope");
  await submit(container);
  expect(upserts).toEqual([]);
  expect(container.textContent).toContain("Add a contact email for the perks you ticked.");
});

test("the logo perk needs a website", async () => {
  const container = await mount();
  await typeInto(input(container, "organization-website"), "");
  expect(checkboxes(container)[0].disabled).toBe(true);
});

test("previews the logo the website will fill as you type", async () => {
  orgDomain = "";
  userEmail = undefined;
  const container = await mount();
  expect(container.querySelector('[data-testid="image-preview"] img')).toBeNull();
  await typeInto(input(container, "organization-website"), "https://www.Acme.com/about");
  expect(container.querySelector('[data-testid="image-preview"] img')?.getAttribute("src")).toBe(
    "https://proxy.desplega.sh/v1/logo?domain=acme.com",
  );
});

test("an invalid website blocks saving", async () => {
  const container = await mount();
  await typeInto(input(container, "organization-website"), "localhost");
  expect(input(container, "organization-website").getAttribute("aria-invalid")).toBe("true");
  await submit(container);
  expect(upserts).toEqual([]);
});

test("a stored old default name counts as missing", async () => {
  namePresent = true;
  statusName = "Your Swarm";
  expect((await mount()).querySelector('[role="dialog"]')).not.toBeNull();
});

test("a stored name keeps it closed", async () => {
  namePresent = true;
  statusName = "Acme";
  expect((await mount()).querySelector('[role="dialog"]')).toBeNull();
});

test("closes once the name saves, then each perk toasts on its own", async () => {
  let releasePerks = () => {};
  perkGate = new Promise((resolve) => {
    releasePerks = resolve;
  });
  inviteFails = true;
  const container = await mount();
  const [featured, slack] = checkboxes(container);
  await act(async () => featured.click());
  await act(async () => slack.click());
  await submit(container);
  // The perk requests are still in flight: they do not hold the gate.
  expect(container.querySelector('[role="dialog"]')).toBeNull();
  expect(toasts).toEqual([]);
  await act(async () => {
    releasePerks();
    await perkGate;
  });
  expect(consents).toEqual([{ granted: true, contactEmail: "ada@acme.com" }]);
  expect(toasts).toEqual([
    "success: Thanks. We'll review your logo before it appears on agent-swarm.dev.",
    "error: Saved. The Slack Connect request did not go through.",
  ]);
});

test("ticked perks stay checked while the name saves", async () => {
  let releaseUpsert = () => {};
  upsertGate = new Promise((resolve) => {
    releaseUpsert = resolve;
  });
  const container = await mount();
  const [featured, slack] = checkboxes(container);
  await act(async () => featured.click());
  await act(async () => slack.click());
  await submit(container);
  for (const box of checkboxes(container)) {
    expect(box.disabled).toBe(true);
    expect(box.checked).toBe(true);
  }
  await act(async () => {
    releaseUpsert();
    await upsertGate;
  });
  expect(container.querySelector('[role="dialog"]')).toBeNull();
});

test("a contact email needs the full address the API accepts", async () => {
  const container = await mount();
  await act(async () => checkboxes(container)[1].click());
  await typeInto(input(container, "organization-contact"), "ops@acme.c");
  await submit(container);
  expect(upserts).toEqual([]);
  expect(container.textContent).toContain("Add a contact email for the perks you ticked.");
});
