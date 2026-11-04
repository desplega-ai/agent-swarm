import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { MotionGlobalConfig } from "motion/react";
import {
  act,
  createContext,
  type FormEvent,
  type ReactNode,
  StrictMode,
  useContext,
  useState,
} from "react";
import type { OnboardingAction, OnboardingResponse } from "../../../api/types";

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
let setFsState: (next: FsState) => void = () => {};
let userEmail: string | null = "qa+files@example.com";
let fsMeResult: () => Promise<unknown>;
let mintResult: (label: string) => Promise<unknown>;
let actResult: (action: OnboardingAction) => Promise<OnboardingResponse>;
const calls: string[] = [];
const acts: OnboardingAction[] = [];
const holds: Array<string | null> = [];

/** A swarm API error as `FsApiError` throws it. */
function apiError(status: number, message: string): Error {
  return Object.assign(new Error(message), { status });
}

const deps = {
  fsMe: async () => {
    calls.push("fsMe");
    return await fsMeResult();
  },
  mintKey: async (label: string) => {
    calls.push(`mint:${label.split(" · ")[0]}`);
    return await mintResult(label);
  },
  getMe: async () => {
    calls.push("me");
    return { userId: "u1", email: userEmail ?? "", displayName: null } as never;
  },
  ls: async () => {
    calls.push("ls");
    return {};
  },
  invite: async (email: string) => {
    calls.push(`invite:${email}`);
  },
  connect: () => {
    calls.push("connect");
    setFsState("ready");
  },
};

const Passthrough = ({ children }: { children: ReactNode }) => <>{children}</>;
const FsContext = createContext<FsState>("needs-connect");

mock.module("@/app/status-context", () => ({
  StatusProvider: Passthrough,
  useStatusContext: () => ({ data: undefined, isLoading: false, error: null }),
}));
mock.module("@/contexts/agent-fs-context", () => ({
  AgentFsProvider: ({ children }: { children: ReactNode }) => {
    const [state, setState] = useState<FsState>(fsState);
    setFsState = setState;
    return <FsContext.Provider value={state}>{children}</FsContext.Provider>;
  },
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
mock.module("@/hooks/use-config", () => ({
  useConfig: () => ({ config: { apiUrl: "http://api.test", apiKey: "" } }),
}));
mock.module("@/components/comb/connect-card", () => ({
  AGENT_FS_UPGRADE_HINT: "Upgrade agent-fs to 0.18.17 or later, or paste an agent-fs key.",
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
  ["@/lib/agent-fs/key-label", "../../../lib/agent-fs/key-label"],
  ["@/components/comb/use-auto-connect", "../../../components/comb/use-auto-connect"],
  ["@/components/shared/setup-card", "../../../components/shared/setup-card"],
  ["@/components/ui/alert-callout", "../../../components/ui/alert-callout"],
  ["@/components/ui/button", "../../../components/ui/button"],
] as const) {
  mock.module(alias, () => require(path));
}

const { StepFiles } = await import("./step-files");
const { _resetAutoConnectAttemptsForTests } = await import(
  "../../../components/comb/use-auto-connect"
);

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
  fsMeResult = async () => ({
    status: "ready",
    agentFsUserId: "fs-1",
    email: userEmail,
    orgId: "org",
    driveId: "drive",
  });
  mintResult = async (label) => ({
    apiKey: "af_test_key",
    keyId: "k1",
    label,
    agentFsUserId: "fs-1",
    orgId: "org",
    driveId: "drive",
  });
  _resetAutoConnectAttemptsForTests();
  actResult = async () => onboarding("done");
  calls.length = 0;
  acts.length = 0;
  holds.length = 0;
  document.body.innerHTML = "";
});

describe("StepFiles", () => {
  test("no email: asks for step 1", async () => {
    userEmail = null;
    fsMeResult = async () => ({ status: "pending", reason: "The swarm user has no email" });
    const view = await mount();
    expect(view.container.textContent).toContain(
      "Add your email in step 1 to create your files account.",
    );
    expect(view.container.querySelector("a")?.getAttribute("href")).toBe("/setup?step=connect");
    expect(calls.filter((c) => c.startsWith("mint:"))).toEqual([]);
    expect(acts).toEqual([]);
    await view.unmount();
  });

  test("mints once across renders and strict mode, completes as created", async () => {
    const view = await mount();
    await view.rerender();
    await view.rerender();
    expect(calls.filter((c) => c.startsWith("mint:"))).toEqual(["mint:Swarm dashboard"]);
    // The identity comes from the swarm: agent-fs `/auth/me` is never called.
    expect(calls).not.toContain("me");
    expect(calls).toContain("connect");
    expect(acts).toEqual([{ action: "complete", step: "files", method: "created" }]);
    expect(view.container.textContent).toContain("Your files account is ready.");
    expect(view.container.textContent).toContain("This browser has its own named agent-fs key.");
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

  test("a rejected saved key mints a new one once", async () => {
    fsState = "invalid-key";
    const view = await mount();
    expect(calls.filter((c) => c.startsWith("mint:"))).toEqual(["mint:Swarm dashboard"]);
    expect(view.container.textContent).toContain("Your files account is ready.");
    // The new key is rejected too: no second automatic mint in this page load.
    await act(async () => setFsState("invalid-key"));
    await settle();
    expect(calls.filter((c) => c.startsWith("mint:"))).toHaveLength(1);
    expect(view.container.textContent).toContain("agent-fs no longer accepts this browser's key");
    await view.unmount();
  });

  test("a pending account shows the server reason and Retry", async () => {
    fsMeResult = async () => ({ status: "pending", reason: "Registration is closed for x.test" });
    const view = await mount();
    expect(view.container.textContent).toContain("Your files account is not ready yet");
    expect(view.container.textContent).toContain("Registration is closed for x.test");
    expect(view.container.querySelector("figure")).toBeNull();
    expect(acts).toEqual([]);
    await view.unmount();
  });

  test("agent-fs too old (501): the paste-key form with the upgrade hint", async () => {
    mintResult = async () => {
      throw apiError(501, "agent_fs_too_old");
    };
    const view = await mount();
    expect(view.container.querySelector('[data-testid="paste-form"]')).not.toBeNull();
    expect(view.container.textContent).toContain("Upgrade agent-fs");
    expect(view.container.querySelector("figure")).toBeNull();
    expect(acts).toEqual([]);
    await view.unmount();
  });

  test("another failure shows the error and Retry mints again", async () => {
    mintResult = async () => {
      throw apiError(502, "agent-fs is down");
    };
    const view = await mount();
    expect(view.container.textContent).toContain("Could not create your files account");
    expect(view.container.textContent).toContain("agent-fs is down");
    expect(view.container.querySelector("figure")).toBeNull();
    const retry = [...view.container.querySelectorAll("button")].find((b) =>
      b.textContent?.includes("Retry"),
    );
    expect(retry).toBeDefined();
    mintResult = async (label) => ({
      apiKey: "af_test_key",
      keyId: "k2",
      label,
      agentFsUserId: "fs-1",
      orgId: "org",
      driveId: "drive",
    });
    await act(async () => retry?.click());
    await settle();
    expect(calls.filter((c) => c.startsWith("mint:"))).toHaveLength(2);
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

  test("already connected on entry: completes as connected, no mint", async () => {
    fsState = "ready";
    const view = await mount();
    expect(calls).toEqual([]);
    expect(acts).toEqual([{ action: "complete", step: "files", method: "connected" }]);
    expect(view.container.textContent).toContain("Your files account is ready.");
    await view.unmount();
  });

  test("a done step in a connected browser mints nothing and writes nothing", async () => {
    fsState = "ready";
    const view = await mount(onboarding("done"));
    expect(calls).toEqual([]);
    expect(acts).toEqual([]);
    expect(view.container.textContent).toContain("Your files account is ready.");
    await view.unmount();
  });

  test("a done step in a fresh browser mints this browser's own key", async () => {
    // Another browser finished the step: this browser has no key yet.
    const view = await mount(onboarding("done"));
    expect(calls.filter((c) => c.startsWith("mint:"))).toEqual(["mint:Swarm dashboard"]);
    expect(acts).toEqual([]);
    expect(view.container.textContent).toContain("Your files account is ready.");
    await view.unmount();
  });
});
