import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";

// A DOM for the router; removed after this file so other files keep their
// server-render environment. The data router builds a `Request` with an
// `AbortSignal`. Mixed Bun and happy-dom classes reject each other, so keep
// Bun's three.
const {
  Request: BunRequest,
  AbortController: BunAbortController,
  AbortSignal: BunAbortSignal,
} = globalThis;
GlobalRegistrator.register();
Object.assign(globalThis, {
  Request: BunRequest,
  AbortController: BunAbortController,
  AbortSignal: BunAbortSignal,
});
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
afterAll(async () => {
  await GlobalRegistrator.unregister();
});

// The test runner cannot resolve ui's `@/` alias. The URL state and the
// local toggle are real; the version gate says "supported".
const API_URL = "http://sessions-view.test";
mock.module("@/api/hooks/use-feature-gate", () => ({
  useFeatureGate: () => ({
    supported: true,
    currentVersion: "2.5.1",
    requiredVersion: "2.5.1",
    isError: false,
    error: null,
  }),
}));
mock.module("@/api/hooks/use-stats", () => ({ useStats: () => ({ isPending: false }) }));
mock.module("@/components/shared/command-menu", () => ({ useCommandMenuGroup: () => {} }));
mock.module("./use-config", () => ({ useConfig: () => ({ config: { apiUrl: API_URL } }) }));
mock.module("@/hooks/use-local-toggle", () => require("./use-local-toggle"));
mock.module("@/hooks/use-url-search-state", () => require("./use-url-search-state"));
mock.module("@/lib/sessions-v2", () => require("../lib/sessions-v2"));

// react-dom must load after the DOM exists.
const { createRoot } = await import("react-dom/client");
const { createMemoryRouter, RouterProvider, useLocation } = await import("react-router-dom");
const { deriveStorageKey } = await import("./use-dismissible-card-key");
const { newViewLink, useSessionsView } = await import("./use-sessions-view");

const PREF_KEY = deriveStorageKey(API_URL, "sessions:legacy");

function Probe() {
  const { view, setView } = useSessionsView();
  const { search } = useLocation();
  return (
    <div>
      <output data-testid="view">{view}</output>
      <output data-testid="search">{search}</output>
      <button type="button" data-testid="v2" onClick={() => setView("v2")} />
      <button type="button" data-testid="legacy" onClick={() => setView("legacy")} />
    </div>
  );
}

// RouterProvider applies navigations in a transition, as the app does. A
// render can then still see the old query string after a URL write.
async function mount(url: string) {
  const router = createMemoryRouter([{ path: "/sessions", element: <Probe /> }], {
    initialEntries: [url],
  });
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => root.render(<RouterProvider router={router} />));
  await act(async () => {});
  const text = (id: string) => container.querySelector(`[data-testid="${id}"]`)?.textContent;
  const click = async (id: string) => {
    await act(async () =>
      (container.querySelector(`[data-testid="${id}"]`) as HTMLButtonElement).click(),
    );
    await act(async () => {});
  };
  return { text, click, unmount: () => act(async () => root.unmount()) };
}

describe("useSessionsView and ?legacy=", () => {
  beforeEach(() => localStorage.clear());

  test("?legacy=1 stores Legacy once, drops the param, and the first New view click works", async () => {
    const page = await mount("/sessions?legacy=1");
    expect(page.text("view")).toBe("legacy");
    expect(page.text("search")).toBe("");
    expect(localStorage.getItem(PREF_KEY)).toBe("1");

    await page.click("v2");
    expect(page.text("view")).toBe("v2");
    expect(localStorage.getItem(PREF_KEY)).toBe("0");
    await page.unmount();
  });

  test("?legacy=0 stores v2 over a Legacy preference, and the first Legacy click works", async () => {
    localStorage.setItem(PREF_KEY, "1");
    const page = await mount("/sessions?legacy=0");
    expect(page.text("view")).toBe("v2");
    expect(page.text("search")).toBe("");
    expect(localStorage.getItem(PREF_KEY)).toBe("0");

    await page.click("legacy");
    expect(page.text("view")).toBe("legacy");
    expect(localStorage.getItem(PREF_KEY)).toBe("1");
    await page.unmount();
  });

  test("without the param, the stored preference decides", async () => {
    localStorage.setItem(PREF_KEY, "1");
    const page = await mount("/sessions");
    expect(page.text("view")).toBe("legacy");
    await page.click("v2");
    expect(page.text("view")).toBe("v2");
    await page.unmount();
  });
});

describe("newViewLink (the legacy view's New sessions view button)", () => {
  test("switches to v2 on an API that serves it", () => {
    const picked: string[] = [];
    const link = newViewLink({
      view: "legacy",
      supported: true,
      currentVersion: "2.5.1",
      pending: false,
      setView: (view) => picked.push(view),
    });
    if (!("onSwitch" in link)) throw new Error("expected a switch");
    link.onSwitch();
    expect(picked).toEqual(["v2"]);
  });

  test("on an older API, gives the version to upgrade to instead", () => {
    const base = { view: "legacy" as const, supported: false, pending: false, setView: () => {} };
    expect(newViewLink({ ...base, currentVersion: "2.5.0" })).toEqual({
      upgradeTip:
        "The new sessions view needs API 2.5.1 or later. This swarm runs 2.5.0. Upgrade the swarm to use it.",
    });
    expect(newViewLink({ ...base, currentVersion: null })).toEqual({
      upgradeTip: "The new sessions view needs API 2.5.1 or later. Upgrade the swarm to use it.",
    });
  });
});
