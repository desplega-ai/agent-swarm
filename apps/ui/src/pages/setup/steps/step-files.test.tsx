import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { MotionGlobalConfig } from "motion/react";
import { act, createContext, type FormEvent, type ReactNode, StrictMode, useContext } from "react";
import type { OnboardingAction, OnboardingResponse } from "../../../api/types";
import { AgentFsError } from "../../../lib/agent-fs/client";

// A DOM for the render tests; removed after this file so other files keep
// their server-render environment.
GlobalRegistrator.register();
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
// react-dom reads the DOM when it first loads: import it after the DOM exists.
const { createRoot } = await import("react-dom/client");
const { MemoryRouter } = await import("react-router-dom");
// happy-dom rejects a cancelled Web Animation, which motion does on unmount.
MotionGlobalConfig.skipAnimations = true;
afterAll(async () => {
  MotionGlobalConfig.skipAnimations = false;
  await GlobalRegistrator.unregister();
});

type FsState = "loading" | "needs-connect" | "ready" | "invalid-key" | "unreachable" | "disabled";

let fsState: FsState = "needs-connect";
let userEmail: string | null = "qa+files@example.com";
let registerResult: () => Promise<{ apiKey: string }>;
let inviteResult: () => Promise<unknown>;
let lsAllowed = false;
let actResult: (action: OnboardingAction) => Promise<OnboardingResponse>;
const calls: string[] = [];
const acts: OnboardingAction[] = [];
const holds: Array<string | null> = [];

const deps = {
  register: async (email: string) => {
    calls.push(`register:${email}`);
    return await registerResult();
  },
  getMe: async () => {
    calls.push("me");
    return { userId: "u1", email: userEmail ?? "", displayName: null } as never;
  },
  ls: async () => {
    calls.push("ls");
    if (!lsAllowed) throw new AgentFsError(404, "not_found", "Drive not found");
    return {};
  },
  invite: async (email: string) => {
    calls.push(`invite:${email}`);
    await inviteResult();
    lsAllowed = true;
  },
  connect: () => {
    calls.push("connect");
  },
};

const Passthrough = ({ children }: { children: ReactNode }) => <>{children}</>;
const FsContext = createContext<FsState>("needs-connect");

mock.module("@/app/status-context", () => ({
  StatusProvider: Passthrough,
  useStatusContext: () => ({ data: undefined, isLoading: false, error: null }),
}));
mock.module("@/contexts/agent-fs-context", () => ({
  AgentFsProvider: ({ children }: { children: ReactNode }) => (
    <FsContext.Provider value={fsState}>{children}</FsContext.Provider>
  ),
  useAgentFs: () => ({
    state: useContext(FsContext),
    endpoint: "http://agent-fs.test",
    orgId: "org",
    driveId: "drive",
    retry: () => {},
  }),
  useOptionalAgentFs: () => null,
}));
mock.module("@/contexts/current-user-context", () => ({
  useCurrentUser: () => ({ user: userEmail ? { email: userEmail } : null }),
}));
mock.module("@/components/comb/use-connect-flow-deps", () => ({
  useConnectFlowDeps: () => deps,
}));
mock.module("@/components/comb/connect-flow", () =>
  require("../../../components/comb/connect-flow"),
);
mock.module("@/components/comb/connect-card", () => ({
  ConnectCard: () => null,
  PasteKeyForm: ({
    apiKey,
    onApiKeyChange,
    onSubmit,
  }: {
    apiKey: string;
    onApiKeyChange: (value: string) => void;
    onSubmit: (event: FormEvent) => void;
  }) => (
    <form data-testid="paste-form" onSubmit={onSubmit}>
      <input value={apiKey} onChange={(e) => onApiKeyChange(e.target.value)} />
    </form>
  ),
}));
// Its tooltip needs the app's TooltipProvider: the label is enough here.
mock.module("@/components/shared/status-icon", () => ({
  StatusIcon: ({ label }: { label?: string }) => <span>{label}</span>,
}));
// The real module pulls the onboarding query and the config hooks: keep only the link helper.
mock.module("@/components/onboarding/onboarding-redirect", () => ({
  setupExitHref: (path: string) => `${path}?fromSetup=1`,
}));
mock.module("@/hooks/use-autosave", () => ({
  ...require("../../../hooks/use-autosave"),
  useContinueBlocker: (_setter: unknown, reason: string | null) => {
    holds.push(reason);
  },
}));
for (const [alias, path] of [
  ["@/lib/utils", "../../../lib/utils"],
  ["@/api/types", "../../../api/types"],
  ["@/components/ui/badge", "../../../components/ui/badge"],
  ["@/components/shared/setup-chip", "../../../components/shared/setup-chip"],
  ["@/components/onboarding/step-status", "../../../components/onboarding/step-status"],
  ["@/components/shared/animated-reveal", "../../../components/shared/animated-reveal"],
  ["@/components/shared/copy-button", "../../../components/shared/copy-button"],
  ["@/components/shared/setup-card", "../../../components/shared/setup-card"],
  ["@/components/ui/alert-callout", "../../../components/ui/alert-callout"],
  ["@/components/ui/button", "../../../components/ui/button"],
] as const) {
  mock.module(alias, () => require(path));
}

const { StepFiles } = await import("./step-files");

function onboarding(filesStatus: "todo" | "done" = "todo"): OnboardingResponse {
  const step = { status: "todo", at: null, method: null, errorClass: null } as const;
  return {
    state: {
      steps: { files: { ...step, status: filesStatus } },
    },
    signals: { files: { enabled: true } },
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
  // Strict mode runs effects twice: the flow must still register once.
  const element = () => (
    <StrictMode>
      <MemoryRouter>
        <StepFiles
          onboarding={data}
          act={async (action) => {
            acts.push(action);
            return await actResult(action);
          }}
          setContinueBlocker={() => {}}
          setContinueAction={() => {}}
        />
      </MemoryRouter>
    </StrictMode>
  );
  await act(async () => root.render(element()));
  await settle();
  return {
    container,
    rerender: async () => {
      await act(async () => root.render(element()));
      await settle();
    },
    unmount: () => act(async () => root.unmount()),
  };
}

beforeEach(() => {
  fsState = "needs-connect";
  userEmail = "qa+files@example.com";
  registerResult = async () => ({ apiKey: "af_test_key" });
  inviteResult = async () => ({});
  lsAllowed = false;
  actResult = async () => onboarding("done");
  calls.length = 0;
  acts.length = 0;
  holds.length = 0;
  document.body.innerHTML = "";
});

describe("StepFiles", () => {
  test("no email: asks for step 1 and never registers", async () => {
    userEmail = null;
    const view = await mount();
    expect(view.container.textContent).toContain(
      "Add your email in step 1 to create your files account.",
    );
    expect(view.container.querySelector("a")?.getAttribute("href")).toBe("/setup?step=connect");
    expect(calls).toEqual([]);
    expect(acts).toEqual([]);
    await view.unmount();
  });

  test("auto-runs once across renders, invites with the same email, completes as created", async () => {
    const view = await mount();
    await view.rerender();
    await view.rerender();
    expect(calls.filter((c) => c.startsWith("register:"))).toEqual([
      "register:qa+files@example.com",
    ]);
    expect(calls).toContain("invite:qa+files@example.com");
    expect(calls).toContain("connect");
    expect(acts).toEqual([{ action: "complete", step: "files", method: "created" }]);
    expect(view.container.textContent).toContain("Your files account is ready.");
    expect(view.container.textContent).toContain("Connected as qa+files@example.com.");
    // Comb opens in a new tab, marked so the landing redirect does not send it back to setup.
    const open = view.container.querySelector('a[href="/file?fromSetup=1"]');
    expect(open?.getAttribute("target")).toBe("_blank");
    expect(open?.getAttribute("aria-label")).toBe("Open your files");
    // The Comb picture explains the step while it runs and once it is done.
    expect(view.container.querySelector("figure")?.textContent).toContain(
      "Send it back to an agent",
    );
    // Continue held while the flow ran, then released.
    expect(holds).toContain("Creating your files account…");
    expect(holds.at(-1)).toBeNull();
    await view.unmount();
  });

  test("email-taken shows the paste-key form and does not complete", async () => {
    registerResult = async () => {
      throw new AgentFsError(409, "conflict", "User with this email already exists");
    };
    const view = await mount();
    expect(view.container.querySelector('[data-testid="paste-form"]')).not.toBeNull();
    expect(view.container.textContent).toContain("This email already has an agent-fs account");
    // A state that needs the person shows alone, without the picture.
    expect(view.container.querySelector("figure")).toBeNull();
    expect(acts).toEqual([]);
    await view.unmount();
  });

  test("a fresh key that cannot finish is shown once with a copy button", async () => {
    inviteResult = async () => {
      throw new Error("forbidden");
    };
    const view = await mount();
    expect(view.container.textContent).toContain("Save this key now. It is shown once.");
    expect(view.container.textContent).toContain("af_test_key");
    expect(view.container.querySelector('button[aria-label="Copy key"]')).not.toBeNull();
    expect(acts).toEqual([]);
    await view.unmount();
  });

  test("another failure shows the error and Retry", async () => {
    registerResult = async () => {
      throw new AgentFsError(503, "unavailable", "agent-fs is down");
    };
    const view = await mount();
    expect(view.container.textContent).toContain("Could not create your files account");
    expect(view.container.querySelector("figure")).toBeNull();
    const retry = [...view.container.querySelectorAll("button")].find((b) =>
      b.textContent?.includes("Retry"),
    );
    expect(retry).toBeDefined();
    registerResult = async () => ({ apiKey: "af_test_key" });
    await act(async () => retry?.click());
    await settle();
    expect(acts).toEqual([{ action: "complete", step: "files", method: "created" }]);
    await view.unmount();
  });

  test("a 403 from act still shows done", async () => {
    actResult = async () => {
      throw Object.assign(new Error("Forbidden"), { status: 403 });
    };
    const view = await mount();
    expect(acts).toHaveLength(1);
    expect(view.container.textContent).toContain("Your files account is ready.");
    await view.unmount();
  });

  test("already connected on entry: completes as connected, no register", async () => {
    fsState = "ready";
    const view = await mount();
    expect(calls).toEqual([]);
    expect(acts).toEqual([{ action: "complete", step: "files", method: "connected" }]);
    expect(view.container.textContent).toContain("Your files account is ready.");
    await view.unmount();
  });

  test("a done step in a connected browser does not register again", async () => {
    fsState = "ready";
    const view = await mount(onboarding("done"));
    expect(calls).toEqual([]);
    expect(acts).toEqual([]);
    expect(view.container.textContent).toContain("Your files account is ready.");
    await view.unmount();
  });

  test("a done step in a fresh browser connects it, and never claims it is ready", async () => {
    // Another browser finished the step: the account exists, this browser has no key.
    registerResult = async () => {
      throw new AgentFsError(409, "conflict", "User with this email already exists");
    };
    const view = await mount(onboarding("done"));
    expect(calls.filter((c) => c.startsWith("register:"))).toEqual([
      "register:qa+files@example.com",
    ]);
    expect(view.container.textContent).not.toContain("Your files account is ready.");
    expect(view.container.querySelector('[data-testid="paste-form"]')).not.toBeNull();
    await view.unmount();
  });
});
