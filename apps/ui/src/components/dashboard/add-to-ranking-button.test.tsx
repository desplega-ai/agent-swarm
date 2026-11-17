import { afterAll, afterEach, beforeEach, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, type ReactNode } from "react";
import type { RankingState } from "@/api/client";

GlobalRegistrator.register();
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const { createRoot } = await import("react-dom/client");

let isAdmin = true;
let state: RankingState | undefined;
let calls: unknown[] = [];

const Box = ({ children }: { children?: ReactNode }) => <div>{children}</div>;

mock.module("@/lib/use-can", () => ({ useIsAdmin: () => isAdmin }));
mock.module("@/api/hooks/use-config-api", () => ({ useConfigs: () => ({ data: [] }) }));
mock.module("@/api/hooks/use-company-profile", () => ({
  useCompanyProfile: () => ({
    loaded: true,
    suggestedName: "Acme",
    suggestedWebsite: "acme.com",
    save: async (patch: unknown, surface: string) => {
      calls.push(["save", patch, surface]);
      return [];
    },
  }),
}));
mock.module("@/api/hooks/use-org-profile", () => ({
  useRanking: () => ({ data: state }),
  useEnableTelemetry: () => ({
    mutateAsync: async (via: string) => calls.push(["telemetry", via]),
  }),
  useRankingOptIn: () => ({
    mutateAsync: async (form: unknown) => calls.push(["optIn", form]),
  }),
}));
mock.module("sonner", () => ({ toast: { success: () => {} } }));
mock.module("@/components/ui/button", () => ({
  Button: ({
    children,
    onClick,
    type = "button",
    form,
  }: {
    children: ReactNode;
    onClick?: () => void;
    type?: "button" | "submit";
    form?: string;
  }) => (
    <button type={type} form={form} onClick={onClick}>
      {children}
    </button>
  ),
}));
mock.module("@/components/ui/input", () => ({ Input: (props: object) => <input {...props} /> }));
mock.module("@/components/ui/label", () => ({ Label: Box }));
mock.module("@/components/ui/alert-callout", () => ({ AlertCallout: Box }));
mock.module("@/components/ui/dialog", () => ({
  Dialog: Box,
  DialogContent: Box,
  DialogDescription: Box,
  DialogFooter: Box,
  DialogHeader: Box,
  DialogTitle: Box,
}));

const { AddToRankingButton } = await import("./add-to-ranking-button");

const NOT_RANKED: RankingState = {
  eligible: false,
  missing: ["SWARM_ORG_NAME", "SWARM_ORG_WEBSITE"],
  telemetryOn: false,
  enabled: false,
  name: "Swarm",
  domain: null,
  listing: null,
  listingMatchesDomain: false,
  verifyUrl: null,
};

let container: HTMLDivElement;
let cleanup: (() => Promise<void>) | undefined;
async function mount() {
  container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(<AddToRankingButton />));
  cleanup = async () => {
    await act(async () => root.unmount());
    container.remove();
  };
}
const buttons = () => [...container.querySelectorAll("button")].map((b) => b.textContent);

beforeEach(() => {
  isAdmin = true;
  state = NOT_RANKED;
  calls = [];
});
afterEach(async () => {
  await cleanup?.();
  cleanup = undefined;
});
afterAll(async () => {
  await GlobalRegistrator.unregister();
});

test("hidden for a non-admin, once ranked, and while the state is unknown", async () => {
  isAdmin = false;
  await mount();
  expect(buttons()).toEqual([]);
  await cleanup?.();
  isAdmin = true;
  state = { ...NOT_RANKED, enabled: true };
  await mount();
  expect(buttons()).toEqual([]);
  await cleanup?.();
  state = undefined;
  await mount();
  expect(buttons()).toEqual([]);
});

test("asks only name and website, then saves, turns telemetry on and opts in", async () => {
  await mount();
  await act(async () => container.querySelector("button")?.click());
  const inputs = [...container.querySelectorAll("input")];
  // The placeholder name "Swarm" is not offered: the suggestion from the admin's domain is.
  expect(inputs.map((input) => [input.id, input.value])).toEqual([
    ["ranking-org-name", "Acme"],
    ["ranking-org-website", "acme.com"],
  ]);
  const form = container.querySelector("form") as HTMLFormElement;
  await act(async () => form.requestSubmit());
  expect(calls).toEqual([
    ["save", { name: "Acme", website: "acme.com" }, "settings"],
    ["telemetry", "banner"],
    ["optIn", { category: "engineering", subcategory: null, description: null }],
  ]);
});
