import { afterAll, afterEach, beforeEach, expect, mock, test } from "bun:test";
import { join } from "node:path";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, useState } from "react";

// AppSurface pulls in most of the `@/` tree and bun does not resolve vite's
// `@/` alias: map every `@/<path>` under src/ to its file (as app-shell.test.tsx does).
const SRC = join(import.meta.dir, "../..");
for (const file of new Bun.Glob("**/*.{ts,tsx}").scanSync(SRC)) {
  if (/\.test\.tsx?$/.test(file)) continue;
  const specifier = `@/${file.replace(/\.tsx?$/, "").replace(/\/index$/, "")}`;
  mock.module(specifier, async () => await import(join(SRC, file)));
}

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

const configValue = {
  config: { apiUrl: "http://swarm.test", apiKey: "test" },
  activeConnection: null,
  connections: [],
} as never;

const roots: { unmount(): void }[] = [];
let changePage: (page: string) => void = () => {};

function PageSwitcher({ app, pageName }: { app: never; pageName?: string }) {
  const [current, setCurrent] = useState(pageName);
  changePage = setCurrent;
  return <AppSurface app={app} pageName={current} />;
}

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

// The dashboard store outlives a mount, so every test uses its own app id.
async function mountApp(id: string, definition: Record<string, unknown>, pageName?: string) {
  const app = {
    id,
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
                <PageSwitcher app={app as never} pageName={pageName} />
              </TooltipProvider>
            </MemoryRouter>
          </CurrentUserProvider>
        </ConfigContext.Provider>
      </QueryClientProvider>,
    ),
  );
  return host;
}

const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
async function type(input: HTMLInputElement, text: string) {
  await act(async () => {
    input.focus();
    valueSetter.call(input, text);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
const inputs = (host: HTMLElement) => [...host.querySelectorAll("input")];
const values = (host: HTMLElement) => inputs(host).map((input) => input.value);

const draftPage = (draft: string) => ({
  state: { draft },
  root: "i",
  elements: { i: { type: "Input", props: { id: "draft", value: { $bindState: "/local/draft" } } } },
});

test("pages that declare the same state name keep their own values across navigation and remount", async () => {
  const definition = {
    models: {},
    defaultPage: "first",
    pages: { first: draftPage("First page"), second: draftPage("Second page") },
  };
  const host = await mountApp("scope-draft", definition, "first");
  expect(values(host)).toEqual(["First page"]);

  await act(async () => changePage("second"));
  expect(values(host)).toEqual(["Second page"]);
  await type(inputs(host)[0]!, "Edited second");

  await act(async () => changePage("first"));
  expect(values(host)).toEqual(["First page"]);
  await act(async () => changePage("second"));
  expect(values(host)).toEqual(["Edited second"]);

  // Warm remount: the per-page slot outlives the surface.
  await act(async () => {
    for (const root of roots.splice(0)) root.unmount();
  });
  const again = await mountApp("scope-draft", definition, "second");
  expect(values(again)).toEqual(["Edited second"]);
  await act(async () => changePage("first"));
  expect(values(again)).toEqual(["First page"]);
});

/** The apps skill's OTP example: repeat, $bindItem, ui.set, watch and $state reads of `/local`. */
async function otpPage() {
  const doc = await Bun.file(
    join(import.meta.dir, "../../../../../templates/skills/apps/content.md"),
  ).text();
  const start = doc.indexOf("### Example: 6-cell code input");
  const block = /```json\n([\s\S]*?)\n```/.exec(doc.slice(start));
  if (start < 0 || !block) throw new Error("code input example not found");
  const definition = JSON.parse(block[1]!);
  return definition.pages[definition.defaultPage] as Record<string, unknown>;
}

test("repeat, $bindItem, watch and ui.set paths stay on their own page", async () => {
  const page = await otpPage();
  const definition = { models: {}, defaultPage: "one", pages: { one: page, two: page } };
  const host = await mountApp("scope-otp", definition, "one");
  for (const [index, digit] of ["1", "2", "3", "4", "5", "6"].entries()) {
    await type(inputs(host)[index]!, digit);
  }
  expect(values(host)).toEqual(["1", "2", "3", "4", "5", "6"]);
  // The watch on `/local/otp` wrote `/local/code`, which the page shows.
  expect(host.textContent).toContain("123456");

  await act(async () => changePage("two"));
  expect(values(host)).toEqual(["", "", "", "", "", ""]);
  expect(host.textContent).not.toContain("123456");

  await act(async () => changePage("one"));
  expect(values(host)).toEqual(["1", "2", "3", "4", "5", "6"]);
  expect(host.textContent).toContain("123456");
});

// Typing in `a` moves focus to `b` of the same element instance.
const focusElement = (id: unknown) => ({
  mode: "bound",
  root: "row",
  elements: {
    row: { type: "Stack", props: { direction: "row" }, children: ["a", "b"] },
    a: { type: "Input", props: { id: "a", onInput: [{ action: "ui.focus", params: { id } }] } },
    b: { type: "Input", props: { id: "b" } },
  },
});
const twoRefs = {
  root: "root",
  elements: {
    root: { type: "Stack", props: {}, children: ["first", "second"] },
    first: { type: "ElementRef", props: { element: "pair" } },
    second: { type: "ElementRef", props: { element: "pair" } },
  },
};

test("ui.focus in a reused element focuses its own instance's Input", async () => {
  for (const [name, id] of [
    ["literal", "b"],
    ["expression", { $join: [["", "b"], ""] }],
  ] as const) {
    const host = await mountApp(`scope-focus-${name}`, {
      models: {},
      defaultPage: "main",
      pages: { main: twoRefs },
      elements: { pair: focusElement(id) },
    });
    const [a1, b1, a2, b2] = inputs(host);
    expect(new Set([a1, b1, a2, b2].map((input) => input?.id)).size).toBe(4);
    await type(a1!, "x");
    expect(document.activeElement).toBe(b1!);
    await type(a2!, "y");
    expect(document.activeElement).toBe(b2!);
  }
});
