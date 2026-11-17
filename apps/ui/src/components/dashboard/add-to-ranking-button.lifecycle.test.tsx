import { afterAll, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, type ComponentProps, type ReactNode } from "react";
import type { RankingState } from "@/api/client";

// Real config, profile and ranking hooks over a stubbed API: a saved name or
// website changes the ranking query key, and the dialog must outlive that refetch.
GlobalRegistrator.register();
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const { createRoot } = await import("react-dom/client");

const Box = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
// The root run has no `@/` alias for apps/ui: map each one to its real file.
// Keep every export: in one `bun test` process the first mock of a specifier fixes its exports.
mock.module("@/api/hooks/use-config-api", () => require("../../api/hooks/use-config-api"));
mock.module("@/api/hooks/use-company-profile", () =>
  require("../../api/hooks/use-company-profile"),
);
mock.module("@/api/hooks/use-org-profile", () => require("../../api/hooks/use-org-profile"));
mock.module("@/lib/company-profile", () => require("../../lib/company-profile"));
mock.module("@/lib/utils", () => require("../../lib/utils"));
// motion's animations throw under happy-dom. The stub keeps Button's contract
// (button.tsx): a press while the status is not idle does nothing.
mock.module("@/components/ui/button", () => ({
  Button: ({
    status = "idle",
    variant: _variant,
    onClick,
    ...props
  }: ComponentProps<"button"> & { status?: string; variant?: string }) => (
    <button
      type="button"
      data-status={status}
      {...props}
      onClick={(event) => (status === "idle" ? onClick?.(event) : event.preventDefault())}
    />
  ),
}));
mock.module("@/components/ui/input", () => require("../ui/input"));
mock.module("@/components/ui/label", () => require("../ui/label"));
mock.module("@/components/ui/alert-callout", () => require("../ui/alert-callout"));
mock.module("@/lib/use-can", () => ({ useIsAdmin: () => true }));
mock.module("@/api/hooks/use-ui-telemetry", () => ({ useUiTelemetry: () => () => {} }));
mock.module("sonner", () => ({ toast: { success: () => {}, error: () => {} } }));
mock.module("@/components/ui/dialog", () => ({
  Dialog: Box,
  DialogContent: Box,
  DialogDescription: Box,
  DialogFooter: Box,
  DialogHeader: Box,
  DialogTitle: Box,
}));

type Config = { scope: string; key: string; value: string; isSecret: boolean };
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
let configs: Config[] = [
  { scope: "global", key: "telemetry_org_domain", value: "acme.com", isSecret: false },
];
let ranking = NOT_RANKED;
let holdRanking: Promise<void> | undefined;
let optInResult: Promise<unknown> = Promise.resolve({});
const calls: string[] = [];

mock.module("../../api/client", () => ({
  api: {
    fetchConfigs: async () => ({ configs: [...configs] }),
    upsertConfig: async (data: Config) => {
      calls.push(`upsert ${data.key}`);
      configs = [...configs.filter((c) => c.key !== data.key), data];
      return data;
    },
    getRanking: async () => {
      await holdRanking;
      return ranking;
    },
    enableTelemetry: async () => {
      calls.push("telemetry");
      return { enabled: true };
    },
    rankingOptIn: async () => {
      calls.push("optIn");
      return optInResult;
    },
  },
}));

const { AddToRankingButton } = await import("./add-to-ranking-button");

afterAll(async () => {
  await GlobalRegistrator.unregister();
});

const settle = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });

test("the dialog stays pending through the identity refetch and shows a failed opt-in", async () => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const submitButton = () =>
    container.querySelector("button[type=submit]") as HTMLButtonElement | null;
  try {
    await act(async () =>
      root.render(
        <QueryClientProvider client={client}>
          <AddToRankingButton />
        </QueryClientProvider>,
      ),
    );
    await settle();
    await act(async () => container.querySelector("button")?.click());

    let releaseRanking = () => {};
    holdRanking = new Promise<void>((resolve) => {
      releaseRanking = resolve;
    });
    let failOptIn: (error: Error) => void = () => {};
    optInResult = new Promise((_, reject) => {
      failOptIn = reject;
    });
    // Pre-filled from the admin's domain; both fields are new rows, so the ranking key changes.
    await act(async () => submitButton()?.click());
    await act(async () => submitButton()?.click());
    await settle();
    expect(submitButton()?.getAttribute("data-status")).toBe("loading");

    releaseRanking();
    await settle();
    expect(calls).toEqual([
      "upsert SWARM_ORG_NAME",
      "upsert SWARM_ORG_WEBSITE",
      "telemetry",
      "optIn",
    ]);
    expect(submitButton()?.getAttribute("data-status")).toBe("loading");

    failOptIn(new Error("ranking service unavailable"));
    await settle();
    expect(container.textContent).toContain("ranking service unavailable");
    expect(submitButton()?.getAttribute("data-status")).toBe("idle");

    // The retry neither rewrites the profile nor turns telemetry on again.
    optInResult = Promise.resolve({});
    ranking = { ...NOT_RANKED, enabled: true };
    await act(async () => submitButton()?.click());
    await settle();
    expect(calls.slice(4)).toEqual(["optIn"]);
    expect(container.querySelector("form")).toBeNull();
    expect(container.querySelector("button")).toBeNull();
  } finally {
    await act(async () => root.unmount());
    client.clear();
    container.remove();
  }
});
