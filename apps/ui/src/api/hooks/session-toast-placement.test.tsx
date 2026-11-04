import { afterAll, afterEach, beforeEach, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";

GlobalRegistrator.register();
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
afterAll(async () => {
  await GlobalRegistrator.unregister();
});

// Real sessions mutations and the app's real Toaster; only the API answers
// are stubbed. The test runner cannot resolve ui's `@/` alias.
const moveSessions = mock(async () => {
  throw new Error("Move rejected by the server");
});
const moveSessionPrefix = mock(async () => {
  throw new Error("Group move rejected by the server");
});
const patchInboxState = mock(async () => {
  throw new Error("Triage rejected by the server");
});
let listTriageFails = false;
const triageSessionList = mock(async () => {
  if (listTriageFails) throw new Error("List triage rejected by the server");
  return { updated: 3 };
});
mock.module("../client", () => ({
  api: { moveSessions, moveSessionPrefix, patchInboxState, triageSessionList },
}));
mock.module("@/contexts/current-user-context", () => ({
  useCurrentUser: () => ({ state: "ready", userId: "user-1" }),
}));
mock.module("@/lib/all-users-scope", () => require("../../lib/all-users-scope"));
mock.module("@/lib/sessions-show", () => require("../../lib/sessions-show"));
mock.module("@/lib/sessions-v2", () => require("../../lib/sessions-v2"));
mock.module("@/lib/utils", () => require("../../lib/utils"));
mock.module("@/components/ui/spinner", () => require("../../components/ui/spinner"));

// React DOM and Sonner must detect the browser after the DOM exists.
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { createRoot } = await import("react-dom/client");
const { Toaster } = await import("../../components/ui/sonner");
const { useMovePrefix, useMoveSessions } = await import("./use-session-moves");
const { useSessionListTriage, useSessionTriage } = await import("./use-session-triage");

type Actions = {
  moveSessions: () => void;
  movePrefix: () => void;
  triageOne: () => void;
  triageList: () => void;
};
let actions: Actions;
function Probe() {
  const move = useMoveSessions();
  const prefix = useMovePrefix();
  const triageOne = useSessionTriage();
  const triage = useSessionListTriage();
  actions = {
    moveSessions: () => move.mutate({ rootTaskIds: ["root-1"], groupKey: "work" }),
    movePrefix: () => prefix.mutate({ from: "work", to: "archive" }),
    triageOne: () =>
      triageOne.markRead({ rootId: "root-1", lastActivityAt: "2026-11-04T10:00:00Z" }),
    triageList: () => triage.run("inbox", "done"),
  };
  return null;
}

let root: ReturnType<typeof createRoot>;
let host: HTMLDivElement;
beforeEach(async () => {
  listTriageFails = false;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <Probe />
        {/* The root Toaster as `app/App.tsx` mounts it. */}
        <Toaster position="bottom-right" />
      </QueryClientProvider>,
    ),
  );
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

const tick = () => act(() => new Promise((resolve) => setTimeout(resolve, 50)));

/** The corner of the toaster that holds the toast with `text`. */
function cornerOf(text: string): string | undefined {
  const toastEl = [...document.querySelectorAll<HTMLElement>("[data-sonner-toast]")].find((el) =>
    el.textContent?.includes(text),
  );
  const list = toastEl?.closest<HTMLElement>("[data-sonner-toaster]");
  return list ? `${list.dataset.yPosition}-${list.dataset.xPosition}` : undefined;
}

test.each([
  ["a failed session move", "moveSessions", "Move rejected by the server", false],
  ["a failed group move", "movePrefix", "Group move rejected by the server", false],
  ["a failed session triage", "triageOne", "Triage rejected by the server", false],
  ["a select-all triage", "triageList", "3 sessions marked Done.", false],
  ["a failed select-all triage", "triageList", "List triage rejected by the server", true],
] as const)("%s toasts in the root Toaster's bottom-right corner", async (_, action, text, fails) => {
  listTriageFails = fails;
  await act(async () => actions[action]());
  await tick();
  expect(cornerOf(text)).toBe("bottom-right");
});
