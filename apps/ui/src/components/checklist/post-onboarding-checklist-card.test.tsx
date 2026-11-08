import { afterAll, afterEach, beforeEach, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, type ReactNode } from "react";
import type { ChecklistItem, ChecklistResponse } from "@/api/types";

GlobalRegistrator.register();
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, __APP_VERSION__: "1.0.0" });
const { createRoot } = await import("react-dom/client");

type Props = { children?: ReactNode; [key: string]: unknown };

mock.module("react-router-dom", () => ({
  Link: ({ children, to }: { children: ReactNode; to: string }) => <a href={to}>{children}</a>,
}));
// The view under test never calls the container's hooks.
mock.module("@/api/hooks/use-checklist", () => ({
  useChecklist: () => ({ data: undefined }),
  useChecklistMutation: () => ({ isPending: false, mutateAsync: async () => {} }),
}));
mock.module("@/api/hooks/use-onboarding", () => ({
  isOnboardingOpen: () => false,
  onboardingDoneCount: () => 0,
  useOnboarding: () => ({ data: null, isPending: false }),
  useVisibleOnboardingSteps: () => [],
}));
mock.module("@/lib/use-can", () => ({ useCan: () => true }));
mock.module("@/app/status-context", () => ({ useOptionalStatusContext: () => null }));
mock.module("@/lib/setup-checks", () => require("../../lib/setup-checks"));
mock.module("@/components/home/favorites", () => ({ NEW_USE_CASE_HREF: "/sessions?seed=x" }));
mock.module("@/lib/utils", () => require("../../lib/utils"));
mock.module("@/components/home/home-widget", () => require("../home/home-widget"));
mock.module("@/components/shared/status-icon", () => ({
  StatusIcon: ({ label }: { label?: ReactNode }) => <span data-status="success">{label}</span>,
}));
mock.module("@/components/ui/button", () => ({
  Button: ({ children, asChild, onClick, type, disabled, ...rest }: Props) =>
    asChild ? (
      children
    ) : (
      <button
        type={(type as "button" | "submit") ?? "button"}
        disabled={disabled as boolean}
        aria-label={rest["aria-label"] as string}
        onClick={onClick as () => void}
      >
        {children}
      </button>
    ),
}));
mock.module("@/components/ui/progress", () => ({ Progress: () => <span /> }));
mock.module("@/components/ui/label", () => ({
  Label: ({ children, htmlFor }: Props) => <label htmlFor={htmlFor as string}>{children}</label>,
}));
mock.module("@/components/ui/textarea", () => ({
  Textarea: ({ id, value, onChange }: Props) => (
    <textarea
      id={id as string}
      value={value as string}
      onChange={onChange as (event: unknown) => void}
    />
  ),
}));
mock.module("@/components/ui/dialog", () => ({
  Dialog: ({ open, children }: Props) => (open ? <div role="dialog">{children}</div> : null),
  DialogContent: ({ children }: Props) => <>{children}</>,
  DialogHeader: ({ children }: Props) => <>{children}</>,
  DialogTitle: ({ children }: Props) => <h3>{children}</h3>,
  DialogDescription: ({ children }: Props) => <p>{children}</p>,
  DialogFooter: ({ children }: Props) => <>{children}</>,
}));
const pass = ({ children }: Props) => <>{children}</>;
mock.module("@/components/ui/dropdown-menu", () => ({
  DropdownMenu: pass,
  DropdownMenuTrigger: pass,
  DropdownMenuContent: pass,
  DropdownMenuSub: pass,
  DropdownMenuSubTrigger: pass,
  DropdownMenuSubContent: pass,
  DropdownMenuSeparator: () => null,
  DropdownMenuItem: ({ children, onSelect }: Props) => (
    <button type="button" data-menu-item onClick={() => (onSelect as () => void)()}>
      {children}
    </button>
  ),
}));

const { PostOnboardingChecklistView } = await import("./post-onboarding-checklist-card");

function item(overrides: Partial<ChecklistItem>): ChecklistItem {
  return {
    id: "swarm:channel",
    scope: "swarm",
    userId: null,
    kind: "channel",
    label: "Connect a chat channel",
    href: "/integrations/channels",
    meta: null,
    sortOrder: 0,
    status: "open",
    statusChangedAt: null,
    statusChangedBy: null,
    statusChangedByName: null,
    statusReason: null,
    nudgedAt: null,
    nudgedTaskId: null,
    signal: false,
    done: false,
    editable: true,
    createdAt: "2026-11-04T10:00:00Z",
    lastUpdatedAt: "2026-11-04T10:00:00Z",
    ...overrides,
  };
}

const DEFAULTS: ChecklistItem[] = [
  item({ signal: true, done: true }),
  item({
    id: "swarm:tool",
    kind: "tool",
    label: "Connect work tools",
    href: "/integrations/tools",
    sortOrder: 1,
  }),
  item({
    id: "user:u1:use_case",
    scope: "user",
    userId: "u1",
    kind: "use_case",
    label: "Plan your first use case",
    href: "/sessions",
    sortOrder: 2,
  }),
];

const calls: { type: string; id?: string; body: unknown }[] = [];
let cleanup: (() => Promise<void>) | undefined;

async function mount(data: ChecklistResponse) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () =>
    root.render(
      <PostOnboardingChecklistView
        data={data}
        onAdd={(body) => {
          calls.push({ type: "add", body });
        }}
        onUpdate={(id, body) => {
          calls.push({ type: "update", id, body });
        }}
      />,
    ),
  );
  cleanup = async () => {
    await act(async () => root.unmount());
    container.remove();
  };
  return container;
}

function button(container: HTMLElement, text: string): HTMLButtonElement {
  const found = [...container.querySelectorAll("button")].find(
    (b) => b.textContent?.trim() === text,
  );
  if (!found) throw new Error(`No button "${text}" in: ${container.textContent}`);
  return found;
}

/** The menu items of one row (the mock renders every row's menu inline). */
function rowButton(container: HTMLElement, label: string, text: string): HTMLButtonElement {
  const row = [...container.querySelectorAll("li")].find((li) => li.textContent?.includes(label));
  if (!row) throw new Error(`No row "${label}"`);
  return button(row as HTMLElement, text);
}

beforeEach(() => {
  calls.length = 0;
});
afterEach(async () => {
  await cleanup?.();
  cleanup = undefined;
});
afterAll(async () => {
  await GlobalRegistrator.unregister();
});

test("shows the three defaults with progress and one action per open row", async () => {
  const container = await mount({ items: DEFAULTS, canEditSwarm: true });
  const text = container.textContent ?? "";
  expect(text).toContain("Get the swarm working");
  expect(text).toContain("1 of 3");
  expect(text).toContain("Connected");
  const links = [...container.querySelectorAll("a")].map((a) => [
    a.textContent,
    a.getAttribute("href"),
  ]);
  expect(links).toEqual([
    ["Open", "/integrations/tools"],
    // A use case starts as a session that asks the Lead to plan it.
    ["Start", "/sessions?seed=x"],
  ]);
});

test("remove asks why and sends the reason", async () => {
  const container = await mount({ items: DEFAULTS, canEditSwarm: true });
  await act(async () => rowButton(container, "Plan your first use case", "Remove…").click());
  const dialog = container.ownerDocument.querySelector('[role="dialog"]') as HTMLElement;
  expect(dialog.textContent).toContain('Remove "Plan your first use case"?');
  const textarea = dialog.querySelector("textarea") as HTMLTextAreaElement;
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
    setter?.call(textarea, "  not now ");
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => button(dialog, "Remove").click());
  expect(calls).toEqual([
    { type: "update", id: "user:u1:use_case", body: { action: "remove", reason: "not now" } },
  ]);
});

test("remove without a reason sends no reason", async () => {
  const container = await mount({ items: DEFAULTS, canEditSwarm: true });
  await act(async () => rowButton(container, "Connect work tools", "Remove…").click());
  const dialog = container.ownerDocument.querySelector('[role="dialog"]') as HTMLElement;
  await act(async () => button(dialog, "Remove").click());
  expect(calls).toEqual([{ type: "update", id: "swarm:tool", body: { action: "remove" } }]);
});

test("removed items sit under a disclosure with who and why, and restore", async () => {
  const items = [
    DEFAULTS[0],
    item({
      ...DEFAULTS[1],
      status: "removed",
      statusChangedBy: "u2",
      statusChangedByName: "Ana",
      statusReason: "we use email",
    }),
    DEFAULTS[2],
  ];
  const container = await mount({ items, canEditSwarm: true });
  expect(container.textContent).toContain("1 of 2");
  expect(container.textContent).not.toContain("Removed by Ana");
  await act(async () => button(container, "Show removed (1)").click());
  expect(container.textContent).toContain("Removed by Ana: we use email");
  await act(async () => button(container, "Restore").click());
  expect(calls).toEqual([{ type: "update", id: "swarm:tool", body: { action: "restore" } }]);
});

test("custom items can be marked done, and a channel row adds another channel", async () => {
  const items = [
    ...DEFAULTS,
    item({ id: "c1", scope: "user", kind: "custom", label: "Write the runbook", href: null }),
  ];
  const container = await mount({ items, canEditSwarm: true });
  await act(async () => rowButton(container, "Write the runbook", "Mark done").click());
  await act(async () => rowButton(container, "Connect a chat channel", "Telegram").click());
  expect(calls).toEqual([
    { type: "update", id: "c1", body: { action: "done" } },
    {
      type: "add",
      body: {
        kind: "channel",
        scope: "swarm",
        label: "Connect Telegram",
        href: "/integrations/channels",
        meta: { adapter: "telegram" },
      },
    },
  ]);
});

test("a member sees swarm items without actions", async () => {
  const items = DEFAULTS.map((entry) => ({ ...entry, editable: entry.scope === "user" }));
  const container = await mount({ items, canEditSwarm: false });
  const toolRow = [...container.querySelectorAll("li")].find((li) =>
    li.textContent?.includes("Connect work tools"),
  ) as HTMLElement;
  expect(toolRow.querySelector("a")).toBeNull();
  expect(toolRow.querySelectorAll("[data-menu-item]").length).toBe(0);
  expect(container.textContent).not.toContain("Add another channel");
});

test("all done hides the card", async () => {
  const items = DEFAULTS.map((entry) => ({ ...entry, done: true, signal: true }));
  const container = await mount({ items, canEditSwarm: true });
  expect(container.textContent).toBe("");
});
