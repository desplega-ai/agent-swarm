import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, type ReactNode } from "react";
import type { Improvement, ImprovementsResponse } from "@/api/types";

GlobalRegistrator.register();
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const { createRoot } = await import("react-dom/client");

let data: ImprovementsResponse;
let canApprove = true;
let approved: Array<{ id: string; email: string | null }> = [];
let discarded: string[] = [];

mock.module("@tanstack/react-query", () => ({
  useQueryClient: () => ({ invalidateQueries: () => {} }),
}));
mock.module("@/api/hooks/use-config-api", () => ({ useConfigs: () => ({ data: [] }) }));
mock.module("@/api/hooks/use-improvements", () => ({
  useImprovements: () => ({ data, isError: false }),
  useApproveImprovement: () => ({
    isPending: false,
    mutateAsync: async (input: { id: string; email: string | null }) => {
      approved.push(input);
      return { status: "sent" };
    },
  }),
  useDiscardImprovement: () => ({
    isPending: false,
    mutateAsync: async (id: string) => {
      discarded.push(id);
    },
  }),
}));
mock.module("@/lib/use-can", () => ({ useCan: () => canApprove }));
mock.module("@/contexts/current-user-context", () => ({
  useCurrentUser: () => ({ userId: "u1", user: { email: "dana@acme.com" } }),
}));
mock.module("@/lib/utils", () => require("../../lib/utils"));
mock.module("@/components/ui/button", () => require("../ui/button"));
mock.module("@/components/ui/input", () => require("../ui/input"));
mock.module("@/components/ui/label", () => require("../ui/label"));
mock.module("@/components/ui/textarea", () => require("../ui/textarea"));
mock.module("sonner", () => ({ toast: { success: () => {}, error: () => {} } }));
mock.module("@/components/improvements/improvement-dialog", () => ({
  ImprovementDialog: () => null,
}));
mock.module("@/components/ui/badge", () => ({
  Badge: ({ children }: { children: ReactNode }) => <span data-badge>{children}</span>,
}));

const { ImprovementsRow } = await import("./improvements-row");

function row(overrides: Partial<Improvement>): Improvement {
  return {
    id: "i1",
    text: "worker-7 keeps failing on acme/api",
    email: null,
    status: "pending_approval",
    source: "mcp",
    requestedByAgentId: "aaaaaaaa-0000-4000-8000-000000000001",
    approvedBy: null,
    approvedAt: null,
    sentAt: null,
    proxyStatus: null,
    proxyId: null,
    proxyError: null,
    createdAt: "2026-11-01T10:00:00.000Z",
    updatedAt: "2026-11-01T10:00:00.000Z",
    leakHints: ["worker-7", "acme/api"],
    ...overrides,
  };
}

let container: HTMLDivElement;
let unmount: () => Promise<void>;
async function mount() {
  container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(<ImprovementsRow />));
  unmount = async () => {
    await act(async () => root.unmount());
    container.remove();
  };
}
const button = (label: string) =>
  [...container.querySelectorAll("button")].find((b) => b.textContent === label);

beforeEach(() => {
  data = { enabled: true, improvements: [row({})] };
  canApprove = true;
  approved = [];
  discarded = [];
});
afterEach(async () => unmount());

test("a pending row highlights its leak hints and approves with the person's email", async () => {
  await mount();
  const marks = [...container.querySelectorAll("mark")].map((m) => m.textContent);
  expect(marks).toEqual(["worker-7", "acme/api"]);
  await act(async () => button("Approve and send")?.click());
  expect(approved).toEqual([{ id: "i1", email: "dana@acme.com" }]);
});

test("discard calls the discard route", async () => {
  await mount();
  await act(async () => button("Discard")?.click());
  expect(discarded).toEqual(["i1"]);
});

test("a failed row offers Retry and history lists sent rows with the approver", async () => {
  data = {
    enabled: true,
    improvements: [
      row({ id: "f1", status: "failed", proxyStatus: 500 }),
      row({
        id: "s1",
        status: "sent",
        approvedBy: "operator",
        proxyStatus: 202,
        leakHints: undefined,
      }),
    ],
  };
  await mount();
  expect(button("Retry")).toBeDefined();
  expect(container.textContent).toContain("Proxy answered 500");
  expect(container.textContent).toContain("Approved by operator");
});

test("without the approve grant there is no approve button", async () => {
  canApprove = false;
  await mount();
  expect(button("Approve and send")).toBeUndefined();
  expect(container.textContent).toContain("A person with approval rights must approve it.");
});

test("with the switch off the section reads Off and offers no actions", async () => {
  data = { enabled: false, improvements: [row({})] };
  await mount();
  expect([...container.querySelectorAll("[data-badge]")].map((b) => b.textContent)).toContain(
    "Off",
  );
  expect(button("Approve and send")).toBeUndefined();
  expect(button("Suggest an improvement")).toBeUndefined();
});
