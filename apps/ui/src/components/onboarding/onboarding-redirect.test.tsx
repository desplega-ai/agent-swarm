import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { MemoryRouter, Route, Routes } from "react-router-dom";

// A DOM for the redirect: `<Navigate>` navigates in an effect, so a static
// render would never show where it went. Removed after this file.
GlobalRegistrator.register();
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const { createRoot } = await import("react-dom/client");
afterAll(async () => {
  await GlobalRegistrator.unregister();
});

let canSetup = true;
let grantsPending = false;

mock.module("@/api/hooks/use-onboarding", () => ({
  isOnboardingOpen: (data: unknown) => Boolean(data),
  useOnboardingOwnsFirstRun: () => false,
  // Fetched after mount, onboarding open and not minimized.
  useOnboarding: () => ({
    data: { state: { minimizedAt: null } },
    dataUpdatedAt: Date.now() + 60_000,
    isFetchedAfterMount: true,
  }),
}));
mock.module("@/hooks/use-config", () => ({
  useConfig: () => ({ config: { apiUrl: "http://swarm.test" }, pendingConnection: null }),
}));
// The real module (full export shape), with the grants under test control.
mock.module("@/lib/use-can", () => ({
  ...require("../../lib/use-can"),
  useCan: () => canSetup,
  useGrantsState: () => ({ operatorTab: false, pending: grantsPending, grants: undefined }),
}));

const { OnboardingRedirect } = await import("./onboarding-redirect");

async function landing(): Promise<string> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <MemoryRouter initialEntries={["/"]}>
        <Routes>
          <Route
            path="/"
            element={
              <>
                <OnboardingRedirect />
                <p>home</p>
              </>
            }
          />
          <Route path="/setup" element={<p>setup</p>} />
        </Routes>
      </MemoryRouter>,
    );
  });
  const text = container.textContent ?? "";
  await act(async () => root.unmount());
  container.remove();
  return text;
}

describe("OnboardingRedirect", () => {
  beforeEach(() => {
    canSetup = true;
    grantsPending = false;
  });

  test("an admin is sent to /setup while onboarding is open", async () => {
    expect(await landing()).toBe("setup");
  });

  test("a non-admin stays on Home", async () => {
    canSetup = false;
    expect(await landing()).toBe("home");
  });

  test("a token-bound tab waits for whoami before it redirects", async () => {
    grantsPending = true;
    expect(await landing()).toBe("home");
  });
});
