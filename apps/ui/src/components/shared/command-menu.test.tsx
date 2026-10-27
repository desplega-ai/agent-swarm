import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { join } from "node:path";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, type ReactNode } from "react";

// A DOM for the real palette, removed after this file. Keep Bun's fetch
// classes: mixed Bun and happy-dom classes reject each other.
const {
  Request: BunRequest,
  Response: BunResponse,
  AbortController: BunAbort,
  AbortSignal: BunSignal,
} = globalThis;
GlobalRegistrator.register();
Object.assign(globalThis, {
  Request: BunRequest,
  AbortController: BunAbort,
  AbortSignal: BunSignal,
});
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
afterAll(async () => {
  await GlobalRegistrator.unregister();
});
// cmdk scrolls the selected row into view; happy-dom has no layout.
Element.prototype.scrollIntoView = () => {};

// The root `bun test` run resolves no `@/` alias. The palette and its search
// providers load for real: each ui module they reach through `@/` is
// mapped to its file. Only the data hooks below are stubbed.
const UI_SRC = join(import.meta.dir, "../..");
const REAL = [
  "api/client",
  "components/command-palette/providers",
  "components/ui/button",
  "components/ui/command",
  "components/ui/dialog",
  "components/ui/kbd",
  "hooks/use-debounced-value",
  "lib/agent-fs/state",
  "lib/approval-shortcuts",
  "lib/comb/paths",
  "lib/command-palette/identity",
  "lib/command-palette/match",
  "lib/command-palette/recents",
  "lib/command-palette/route-meta",
  "lib/command-palette/task-result",
  "lib/command-palette/use-palette-identity",
  "lib/config",
  "lib/task-title",
  "lib/utils",
];
for (const path of REAL) mock.module(`@/${path}`, () => require(join(UI_SRC, path)));

// Data the palette reads besides search: none. Admin-only and gated
// providers hide, so only tasks, agents and pages search.
const noData = () => ({ data: undefined });
const noop = () => ({ mutate: () => {} });
mock.module("@/api/hooks/use-tasks", () => ({
  useTask: noData,
  useTasks: noData,
  useCancelTask: noop,
  usePauseTask: noop,
  useResumeTask: noop,
}));
mock.module("@/api/hooks/use-agents", () => ({ useAgents: noData }));
mock.module("@/api/hooks/use-feature-gate", () => ({ useVersionGate: () => () => true }));
mock.module("@/app/status-context", () => ({ useStatusContext: noData }));
mock.module("@/lib/runtime-pools", () => ({ useRuntimePoolsGate: () => ({ open: false }) }));
mock.module("@/lib/use-can", () => ({ useIsAdmin: () => false }));
mock.module("@/api/hooks/use-agent-fs", () => ({ useCombSearch: noData }));
mock.module("@/contexts/agent-fs-context", () => ({
  useAgentFs: () => ({ orgId: null, driveId: null }),
}));

const { createRoot } = await import("react-dom/client");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { MemoryRouter } = await import("react-router-dom");
const { CommandMenu, CommandMenuProvider, useOpenCommandMenu } = await import("./command-menu");
const { deriveStorageKey } = await import("../../hooks/use-dismissible-card-key");
const { CURRENT_USER_CARD_KEY } = await import("../../lib/dashboard-user");
const { pushRecent } = await import("../../lib/command-palette/recents");
const { SEARCH_PROVIDERS } = await import("../command-palette/providers");
const { usePaletteIdentity } = await import("../../lib/command-palette/use-palette-identity");
const { getConfig } = await import("../../lib/config");

// Placeholder key built at runtime, so secret scanners see no literal.
const swarm = { apiUrl: "http://command-menu.test", apiKey: `${"k".repeat(12)}1234` };
const USER_KEY = deriveStorageKey(swarm.apiUrl, CURRENT_USER_CARD_KEY);

interface Task {
  id: string;
  task: string;
  title: string;
  status: string;
}

/** Task search answers per user and query. A missing entry never answers. */
let answers: Record<string, Task[]> = {};
/** Task searches sent, as `user:query`. */
let asked: string[] = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input));
  if (url.pathname !== "/api/tasks") return BunResponse.json({ agents: [], pages: [] });
  const key = `${localStorage.getItem(USER_KEY)}:${url.searchParams.get("search")}`;
  asked.push(key);
  const rows = answers[key];
  return rows ? BunResponse.json({ tasks: rows }) : new Promise<Response>(() => {});
}) as typeof fetch;
afterAll(() => {
  globalThis.fetch = realFetch;
});

/** A task whose title and prompt are `text`. */
function task(id: string, text: string): Task {
  return { id, task: text, title: text, status: "completed" };
}

/** Lets timers, react-query and cmdk run, until `done` holds (2s cap). */
async function until(done: () => boolean) {
  for (let waited = 0; waited < 2000 && !done(); waited += 25) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 25));
    });
  }
  // One more turn, so a render the last answer started lands too.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 25));
  });
}

/** Lets a render that needs no answer land (a remount, a dropped row). */
async function pause() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 200));
  });
}

function Opener() {
  const open = useOpenCommandMenu();
  return (
    <button type="button" data-testid="open" onClick={open}>
      open
    </button>
  );
}

let unmount: (() => Promise<void>) | null = null;
afterEach(async () => {
  await unmount?.();
  unmount = null;
  document.body.innerHTML = "";
});

async function render(node: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () =>
    root.render(<QueryClientProvider client={client}>{node}</QueryClientProvider>),
  );
  unmount = () => act(async () => root.unmount());
  return container;
}

async function openPalette() {
  const container = await render(
    <MemoryRouter>
      <CommandMenuProvider>
        <Opener />
        <CommandMenu />
      </CommandMenuProvider>
    </MemoryRouter>,
  );
  await act(async () => {
    container.querySelector<HTMLButtonElement>('[data-testid="open"]')?.click();
  });
  await until(() => document.querySelector("[cmdk-input]") !== null);
}

/**
 * The real task provider, re-rendered on a user switch but never remounted,
 * so only its own placeholder rule keeps the answers apart.
 */
function TaskSearch() {
  usePaletteIdentity(getConfig);
  const { results } = SEARCH_PROVIDERS.tasks.useSearch("deploy", 8);
  return <output data-testid="results">{results.map((row) => row.title).join(",")}</output>;
}

/** The palette's rows (the dialog portals into document.body). */
function rows(): string[] {
  return [...document.querySelectorAll("[cmdk-item]")].map((item) => item.textContent ?? "");
}

const hasRow = (text: string) => rows().some((row) => row.includes(text));

/** Types `text`, then waits until the debounced task search for it went out. */
async function type(text: string) {
  const input = document.querySelector<HTMLInputElement>("[cmdk-input]");
  if (!input) throw new Error("palette input missing");
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, text);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await until(() => asked.some((key) => key.endsWith(`:${text}`)));
}

/** Another tab picks a user: it writes storage, and this tab gets a `storage` event. */
async function switchUserInOtherTab(userId: string) {
  localStorage.setItem(USER_KEY, userId);
  await act(async () => {
    window.dispatchEvent(new StorageEvent("storage", { key: USER_KEY, newValue: userId }));
  });
  await pause();
}

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem(
    "agent-swarm-connections",
    JSON.stringify({ connections: [{ id: "c1", name: "test", ...swarm }], activeId: "c1" }),
  );
  localStorage.setItem(USER_KEY, "user-a");
  answers = {};
  asked = [];
});

describe("Cmd+K palette", () => {
  test("a user switch in another tab clears the first user's recents and results", async () => {
    pushRecent(swarm, { kind: "tasks", title: "a's recent", href: "/tasks/r" });
    answers = { "user-a:deploy": [task("a1", "Deploy a's private task")] };
    await openPalette();
    expect(hasRow("a's recent")).toBe(true);

    await type("deploy");
    await until(() => hasRow("Deploy a's private task"));
    expect(hasRow("Deploy a's private task")).toBe(true);

    // No answer for user b: a placeholder or a kept body would show user a's rows.
    await switchUserInOtherTab("user-b");
    expect(rows().filter((row) => row.includes("a's"))).toEqual([]);
  });

  test("a storage write that changes no identity keeps the palette", async () => {
    pushRecent(swarm, { kind: "tasks", title: "a's recent", href: "/tasks/r" });
    answers = { "user-a:deploy": [task("a1", "Deploy a's task")] };
    await openPalette();
    await type("deploy");
    await until(() => hasRow("Deploy a's task"));

    await act(async () => {
      localStorage.setItem("unrelated", "1");
      window.dispatchEvent(new StorageEvent("storage", { key: "unrelated", newValue: "1" }));
    });
    await pause();
    expect(hasRow("Deploy a's task")).toBe(true);
    expect(document.querySelector<HTMLInputElement>("[cmdk-input]")?.value).toBe("deploy");
  });

  test("the task provider never stands in one user's answer for another's", async () => {
    answers = { "user-a:deploy": [task("a1", "Deploy a's private task")] };
    const container = await render(<TaskSearch />);
    const shown = () => container.querySelector('[data-testid="results"]')?.textContent;
    await until(() => shown() !== "");
    expect(shown()).toBe("Deploy a's private task");

    // Same observer, new query key; user b's search never answers.
    await switchUserInOtherTab("user-b");
    expect(asked).toContain("user-b:deploy");
    expect(shown()).toBe("");
  });

  test("while the next query loads, the previous query's server-only matches leave", async () => {
    // The server matched "Ship the API" on prompt text past the preview.
    answers = { "user-a:deploy": [task("d1", "Ship the API"), task("d2", "Deploy payroll")] };
    await openPalette();
    await type("deploy");
    await until(() => hasRow("Ship the API"));
    expect(hasRow("Ship the API")).toBe(true);

    // "payroll" never answers, so the deploy answer stands in meanwhile.
    await type("payroll");
    expect(hasRow("Ship the API")).toBe(false);
    // A stand-in row the client matcher finds on its own stays.
    expect(hasRow("Deploy payroll")).toBe(true);
  });

  test("once the next query answers, its server-only matches show", async () => {
    answers = {
      "user-a:deploy": [task("d1", "Deploy the API")],
      "user-a:payroll": [task("p1", "Ship the API")],
    };
    await openPalette();
    await type("deploy");
    await type("payroll");
    await until(() => hasRow("Ship the API"));
    expect(hasRow("Ship the API")).toBe(true);
    expect(hasRow("Deploy the API")).toBe(false);
  });
});
