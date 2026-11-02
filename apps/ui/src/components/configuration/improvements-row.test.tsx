import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, type ReactNode } from "react";
import type { Improvement, ImprovementsResponse } from "@/api/types";

GlobalRegistrator.register();
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const { createRoot } = await import("react-dom/client");

let data: ImprovementsResponse;

mock.module("@tanstack/react-query", () => ({
  useQueryClient: () => ({ invalidateQueries: () => {} }),
}));
mock.module("@/api/hooks/use-config-api", () => ({ useConfigs: () => ({ data: [] }) }));
mock.module("@/api/hooks/use-improvements", () => ({
  useImprovements: () => ({ data, isError: false }),
  useApproveImprovement: () => ({ isPending: false, mutateAsync: async () => ({}) }),
  useDiscardImprovement: () => ({ isPending: false, mutateAsync: async () => ({}) }),
}));
mock.module("@/contexts/current-user-context", () => ({
  useCurrentUser: () => ({ userId: "u1", user: { email: "dana@acme.com" } }),
}));
mock.module("@/lib/utils", () => require("../../lib/utils"));
mock.module("@/components/ui/button", () => require("../ui/button"));
mock.module("@/components/ui/input", () => require("../ui/input"));
mock.module("@/components/ui/label", () => require("../ui/label"));
mock.module("sonner", () => ({ toast: { success: () => {}, error: () => {} } }));
mock.module("@/components/improvements/improvement-approval-list", () =>
  require("../improvements/improvement-approval-list"),
);
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

beforeEach(() => {
  data = { enabled: true, improvements: [row({})] };
});
afterEach(async () => unmount());

test("settings has no approval list or submit: it points to the header", async () => {
  await mount();
  expect(container.querySelectorAll("button")).toHaveLength(0);
  expect(container.querySelector("mark")).toBeNull();
  expect(container.textContent).toContain("1 draft is waiting for approval in the header.");
});

test("history lists sent rows with the approver", async () => {
  data = {
    enabled: true,
    improvements: [row({ id: "s1", status: "sent", approvedBy: "operator", proxyStatus: 202 })],
  };
  await mount();
  expect(container.textContent).toContain("Approved by operator");
  expect(container.textContent).toContain("Proxy 202");
  expect(container.textContent).not.toContain("waiting for approval in the header");
});

test("with the switch off the section reads Off", async () => {
  data = { enabled: false, improvements: [row({})] };
  await mount();
  expect([...container.querySelectorAll("[data-badge]")].map((b) => b.textContent)).toContain(
    "Off",
  );
  expect(container.textContent).toContain("Turned off.");
});
