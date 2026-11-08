import { afterAll, afterEach, beforeEach, expect, mock, test } from "bun:test";
import { join } from "node:path";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";

// AppSurface pulls in most of the `@/` tree and bun does not resolve vite's
// `@/` alias: map every `@/<path>` under src/ to its file (as table-phone-card.test.tsx does).
const SRC = join(import.meta.dir, "../..");
for (const file of new Bun.Glob("**/*.{ts,tsx}").scanSync(SRC)) {
  if (/\.test\.tsx?$/.test(file)) continue;
  const specifier = `@/${file.replace(/\.tsx?$/, "").replace(/\/index$/, "")}`;
  mock.module(specifier, async () => await import(join(SRC, file)));
}

// The SessionThread case needs a server new enough for sessions; nothing else here gates.
mock.module("@/api/hooks/use-feature-gate", () => ({
  useFeatureGate: () => ({ supported: true, requiredVersion: "0.0.0", currentVersion: "9.9.9" }),
}));

GlobalRegistrator.register();
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const realFetch = globalThis.fetch;
// Queries never settle: the surface renders its loading state, no network.
globalThis.fetch = (() => new Promise(() => {})) as unknown as typeof fetch;
const { createRoot } = await import("react-dom/client");
const { MemoryRouter } = await import("react-router");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { TooltipProvider } = await import("@/components/ui/tooltip");
const { ConfigContext } = await import("@/hooks/use-config");
const { CurrentUserProvider } = await import("@/contexts/current-user-context");
const { AppSurface } = await import("./app-surface");

const config = { apiUrl: "http://swarm.test", apiKey: "test" };
const configValue = { config, activeConnection: null, connections: [] } as never;

const FIXTURES = join(import.meta.dir, "../../../../../src/tests/fixtures");
const definitionOf = (name: string) => Bun.file(join(FIXTURES, name)).json();

const roots: { unmount(): void }[] = [];

beforeEach(() => {
  document.body.innerHTML = "";
});

afterEach(async () => {
  await act(async () => {
    for (const root of roots.splice(0)) root.unmount();
  });
});

afterAll(async () => {
  globalThis.fetch = realFetch;
  await GlobalRegistrator.unregister();
});

async function mountApp(
  definition: Record<string, unknown>,
  { mode, pageName }: { mode?: "default" | "full" | "chromeless"; pageName?: string } = {},
) {
  const app = {
    id: "app-1",
    name: "Factory",
    description: "Test app",
    definition,
    createdAt: "2026-11-01T00:00:00.000Z",
    updatedAt: "2026-11-01T00:00:00.000Z",
  };
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  roots.push(root);
  await act(async () =>
    root.render(
      <QueryClientProvider client={new QueryClient()}>
        <ConfigContext.Provider value={configValue}>
          <CurrentUserProvider>
            <MemoryRouter>
              <TooltipProvider>
                <AppSurface app={app as never} mode={mode} pageName={pageName} />
              </TooltipProvider>
            </MemoryRouter>
          </CurrentUserProvider>
        </ConfigContext.Provider>
      </QueryClientProvider>,
    ),
  );
  return host;
}

const EXISTING = [
  "bookmarks-definition.json.txt",
  "catalog-feedback-definition.json.txt",
  "catalog-inputs-definition.json.txt",
  "catalog-table-definition.json.txt",
  "kibo-blocks-definition.json.txt",
  "prs-app-definition.json.txt",
];

test("existing definitions (no layout opt-in) render the plain canvas in every mode", async () => {
  for (const name of EXISTING) {
    const definition = await definitionOf(name);
    expect(definition.layout).toBeUndefined();

    const host = await mountApp(definition);
    expect(host.querySelector('[data-testid="app-shell"]')).toBeNull();
    const canvas = host.querySelector('[data-testid="app-runtime"] > div:nth-child(2)');
    expect(canvas?.className).toContain(
      "flex flex-col flex-1 min-h-0 gap-4 overflow-y-auto rounded-lg border border-border p-4",
    );

    const embed = await mountApp(definition, { mode: "chromeless" });
    expect(embed.querySelector('[data-testid="app-shell"]')).toBeNull();
    expect(embed.querySelector('[data-testid="app-runtime"]')?.className).toBe(
      "fixed inset-0 z-50 flex flex-col gap-4 overflow-y-auto bg-background p-4",
    );
  }
});

test("layout: sidebar lists navigable pages, marks the active one and fills the header", async () => {
  const definition = await definitionOf("app-shell-charts-definition.json.txt");
  const host = await mountApp(definition);

  const sidebar = host.querySelector('[data-testid="app-shell-sidebar"]')!;
  const links = [...sidebar.querySelectorAll("a")];
  // `service` needs a required param and `settings` sets nav: false.
  expect(links.map((a) => a.textContent)).toEqual(["Overview", "Spend"]);
  expect(links.map((a) => a.getAttribute("href"))).toEqual(["/apps/app-1", "/apps/app-1/p/spend"]);
  expect(links[0]!.getAttribute("aria-current")).toBe("page");
  expect(links[1]!.getAttribute("aria-current")).toBeNull();
  // The dashboard header already names the app in the default view.
  expect(sidebar.textContent).not.toContain("Factory");

  const header = host.querySelector('[data-testid="app-shell-header"]')!;
  // The header sits outside the scroll container; the body below it scrolls
  // with a bounded height, so a `fill` Stack gets independent panes.
  expect(header.className).toContain("shrink-0");
  const body = host.querySelector('[data-testid="app-shell-body"]')!;
  expect(header.nextElementSibling).toBe(body);
  expect(body.className).toContain("min-h-0 flex-1");
  expect(body.className).toContain("overflow-y-auto");
  expect(header.parentElement?.className).not.toContain("overflow");
  expect(header.querySelector("h2")?.textContent).toBe("Overview");
  expect(header.textContent).toContain("Deploys, failures and spend");
  expect(header.querySelector('[data-testid="app-shell-actions"]')?.textContent).toContain(
    "Refresh",
  );
  // The header actions render once, outside the page body.
  expect(host.querySelectorAll('[data-testid="app-shell-actions"] button').length).toBe(1);
  expect(header.nextElementSibling?.textContent).not.toContain("Refresh");

  expect(host.querySelectorAll('[data-testid="json-render-chart"]').length).toBe(2);
});

test("layout: sidebar keeps the shell in chromeless and names the app there", async () => {
  const definition = await definitionOf("app-shell-charts-definition.json.txt");
  const host = await mountApp(definition, { mode: "chromeless", pageName: "spend" });
  const sidebar = host.querySelector('[data-testid="app-shell-sidebar"]')!;
  expect(sidebar.textContent).toContain("Factory");
  expect(sidebar.querySelector('[aria-current="page"]')?.textContent).toBe("Spend");
  expect(host.querySelector('[data-testid="app-shell-actions"]')).toBeNull();
});

test("a page left out of the sidebar keeps the crumbs back to the default page", async () => {
  const definition = await definitionOf("app-shell-charts-definition.json.txt");
  const host = await mountApp(definition, { pageName: "settings" });
  const header = host.querySelector('[data-testid="app-shell-header"]')!;
  expect(header.querySelector('[data-testid="app-page-crumbs"]')?.textContent).toContain(
    "Overview",
  );
  expect(host.querySelector('[data-testid="app-shell-sidebar"] [aria-current="page"]')).toBeNull();
});

test("layout: sidebar gives page components the app scope (a SessionThread can chat)", async () => {
  const definition = {
    layout: "sidebar",
    defaultPage: "chat",
    pages: {
      chat: {
        title: "Chat",
        root: "thread",
        elements: { thread: { type: "SessionThread", props: { id: "chat", sessionKey: "main" } } },
      },
      other: { title: "Other", root: "t", elements: { t: { type: "Text", props: { text: "x" } } } },
    },
  };
  const host = await mountApp(definition);
  expect(host.querySelector('[data-testid="app-shell"]')).not.toBeNull();
  const thread = host.querySelector('[data-testid="json-render-session-thread"]');
  expect(thread).not.toBeNull();
  expect(thread?.textContent).not.toContain("This chat only works on an app page.");
});
