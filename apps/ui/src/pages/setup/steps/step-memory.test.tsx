import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider, useMutation } from "@tanstack/react-query";
import { MotionGlobalConfig } from "motion/react";
import { act, StrictMode, useLayoutEffect } from "react";
import type {
  OnboardingAction,
  OnboardingMemoryTestRequest,
  OnboardingMemoryTestResponse,
  OnboardingResponse,
  OnboardingStepStatus,
} from "../../../api/types";

// A DOM for the render tests; removed after this file so other files keep
// their server-render environment.
GlobalRegistrator.register();
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
// react-dom reads the DOM when it first loads: import it after the DOM exists.
const { createRoot } = await import("react-dom/client");
const { MemoryRouter } = await import("react-router-dom");
// happy-dom rejects a cancelled Web Animation, which motion does on unmount.
MotionGlobalConfig.skipAnimations = true;
mock.module("@radix-ui/react-use-layout-effect", () => ({ useLayoutEffect }));
afterAll(async () => {
  MotionGlobalConfig.skipAnimations = false;
  await GlobalRegistrator.unregister();
});

const tests: OnboardingMemoryTestRequest[] = [];
const blockers: Array<string | null> = [];
let continueAction: (() => Promise<void>) | null = null;
let probe: (body: OnboardingMemoryTestRequest) => Promise<OnboardingMemoryTestResponse>;

const PASS: OnboardingMemoryTestResponse = { ok: true, dimensions: 512, latencyMs: 12 };
const UNREACHABLE: OnboardingMemoryTestResponse = {
  ok: false,
  latencyMs: 0,
  error: "The endpoint could not be reached.",
  errorClass: "network",
};

// Mocks of shared modules keep every export of the real module: in one `bun test`
// process the first file to register a specifier fixes its export names.
// The `@/` alias does not resolve from the repo root: point each one at its file.
for (const [alias, path] of [
  ["@/lib/utils", "../../../lib/utils"],
  ["@/lib/config", "../../../lib/config"],
  ["@/lib/agent-runtime-models", "../../../lib/agent-runtime-models"],
  ["@/api/client", "../../../api/client"],
  ["@/lib/model-vendor", "../../../lib/model-vendor"],
  ["@/lib/azure-embeddings", "../../../lib/azure-embeddings"],
  ["@/components/ui/tooltip", "../../../components/ui/tooltip"],
  ["@/components/ui/spinner", "../../../components/ui/spinner"],
  ["@/components/ui/button", "../../../components/ui/button"],
  ["@/components/ui/input", "../../../components/ui/input"],
  ["@/components/ui/label", "../../../components/ui/label"],
  ["@/components/ui/textarea", "../../../components/ui/textarea"],
  ["@/components/ui/badge", "../../../components/ui/badge"],
  ["@/components/ui/skeleton", "../../../components/ui/skeleton"],
  ["@/components/ui/settings-row", "../../../components/ui/settings-row"],
  ["@/components/ui/info-tip", "../../../components/ui/info-tip"],
  ["@/components/kibo-ui/spinner", "../../../components/kibo-ui/spinner"],
  ["@/components/shared/animated-reveal", "../../../components/shared/animated-reveal"],
  ["@/components/shared/status-icon", "../../../components/shared/status-icon"],
  ["@/components/shared/setup-card", "../../../components/shared/setup-card"],
  ["@/components/shared/setup-chip", "../../../components/shared/setup-chip"],
  ["@/components/shared/fade-in", "../../../components/shared/fade-in"],
  ["@/components/shared/brand-logo", "../../../components/shared/brand-logo"],
  ["@/components/shared/collapsible-section", "../../../components/shared/collapsible-section"],
  ["@/components/shared/secret-input", "../../../components/shared/secret-input"],
  ["@/hooks/use-autosave", "../../../hooks/use-autosave"],
  ["@/components/onboarding/save-indicator", "../../../components/onboarding/save-indicator"],
  [
    "@/components/onboarding/autosave-secret-field",
    "../../../components/onboarding/autosave-secret-field",
  ],
] as const) {
  mock.module(alias, () => require(path));
}
// The real module reads the models catalog query: the name is enough here.
mock.module("@/components/shared/model-logo", () => ({
  ModelLogo: () => null,
  ModelLabel: ({ model }: { model: string }) => <span>{model}</span>,
}));
// The real module pulls the onboarding query and the config hooks.
mock.module("@/components/onboarding/onboarding-redirect", () => ({
  markSetupVisited: () => {},
  wasSetupVisited: () => false,
  setupExitHref: (path: string) => `${path}?fromSetup=1`,
  OnboardingRedirect: () => null,
}));
// Every export of the real module. No step 3 key to reuse.
mock.module("@/api/hooks/use-integrations-meta", () => ({
  useEnvPresence: () => ({ data: {}, isPending: false, isFetching: false }),
  useReloadConfig: () => ({ mutateAsync: async () => ({}) }),
  useMcpUserConfig: () => ({ data: undefined }),
  useTestClaudeManagedConnection: () => ({ mutateAsync: async () => ({}) }),
}));
mock.module("@/api/hooks/use-onboarding", () => ({
  ...require("../../../api/hooks/use-onboarding"),
  useTestOnboardingMemory: () =>
    useMutation({
      mutationFn: async (body: OnboardingMemoryTestRequest) => {
        tests.push(body);
        return await probe(body);
      },
    }),
}));

const { StepMemory } = await import("./step-memory");
const { TooltipProvider } = await import("../../../components/ui/tooltip");

function onboarding(status: OnboardingStepStatus = "todo"): OnboardingResponse {
  return {
    state: {
      steps: { memory: { status, at: null, method: null, errorClass: null } },
    },
    signals: {
      embeddings: {
        configured: true,
        dimensions: 512,
        model: "nomic-ai/nomic-embed-text-v1.5",
        local: true,
      },
    },
  } as unknown as OnboardingResponse;
}

async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
}

async function mount(data = onboarding()) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  // Strict mode runs effects twice: the setup must still test once.
  await act(async () =>
    root.render(
      <StrictMode>
        <QueryClientProvider client={queryClient}>
          <TooltipProvider>
            <MemoryRouter>
              <StepMemory
                onboarding={data}
                act={async (_action: OnboardingAction) => data}
                setContinueBlocker={(reason) => {
                  blockers.push(reason);
                }}
                setContinueAction={(action) => {
                  continueAction = action;
                }}
              />
            </MemoryRouter>
          </TooltipProvider>
        </QueryClientProvider>
      </StrictMode>,
    ),
  );
  await settle();
  return { container, unmount: () => act(async () => root.unmount()) };
}

const providerForm = (container: HTMLElement) =>
  container.querySelector('[role="radiogroup"][aria-label="Provider"]');

const buttonText = (container: HTMLElement, text: string) =>
  [...container.querySelectorAll("button")].find((b) => b.textContent?.includes(text));

beforeEach(() => {
  tests.length = 0;
  blockers.length = 0;
  continueAction = null;
  probe = async () => PASS;
  document.body.innerHTML = "";
});

describe("StepMemory on a server that has memory search on", () => {
  test("tests the server's setup once when the step opens and shows the pass", async () => {
    const view = await mount();
    expect(tests).toEqual([{ preset: "existing" }]);
    expect(view.container.textContent).toContain("Memory search is on");
    expect(view.container.textContent).toContain("Memory works.");
    expect(buttonText(view.container, "Test again")).toBeDefined();
    expect(providerForm(view.container)).toBeNull();
    await view.unmount();
  });

  test("Continue keeps the fresh pass and does not test again", async () => {
    const view = await mount();
    expect(tests).toHaveLength(1);
    await act(async () => {
      await continueAction?.();
    });
    expect(tests).toHaveLength(1);
    await view.unmount();
  });

  test("Continue waits while the test runs", async () => {
    let finish: (result: OnboardingMemoryTestResponse) => void = () => {};
    probe = () =>
      new Promise((resolve) => {
        finish = resolve;
      });
    const view = await mount();
    expect(blockers.at(-1)).toBe("Testing memory…");
    expect(view.container.textContent).toContain("Testing the endpoint");
    await act(async () => finish(PASS));
    await settle();
    expect(blockers.at(-1)).toBeNull();
    expect(view.container.textContent).toContain("Memory works.");
    await view.unmount();
  });

  test("a failed test shows the error and opens the provider form", async () => {
    probe = async () => UNREACHABLE;
    const view = await mount();
    expect(view.container.textContent).toContain("Could not reach the endpoint.");
    expect(providerForm(view.container)).not.toBeNull();
    // The card's Test again is the one retry: no second icon button.
    expect(view.container.querySelectorAll('button[aria-label="Test again"]')).toHaveLength(0);
    probe = async () => PASS;
    await act(async () => {
      buttonText(view.container, "Test again")?.click();
    });
    await settle();
    expect(tests).toHaveLength(2);
    expect(view.container.textContent).toContain("Memory works.");
    await view.unmount();
  });

  test("a skipped step does not test by itself", async () => {
    const view = await mount(onboarding("skipped"));
    expect(tests).toEqual([]);
    expect(buttonText(view.container, "Test current setup")).toBeDefined();
    await view.unmount();
  });
});
