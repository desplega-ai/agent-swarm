import { afterAll, afterEach, beforeEach, expect, mock, test } from "bun:test";
import { join } from "node:path";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";

// The phone card layout is chosen inside TableComponent, which pulls in most of
// the `@/` component tree, and bun does not resolve vite's `@/` alias. Map every
// `@/<path>` specifier under src/ to its file, once, instead of mocking each
// module by hand. (The helper tests in link-cell-model.test.ts do not prove the
// Table calls the helper; this file renders the real Table.)
const SRC = join(import.meta.dir, "../..");
for (const file of new Bun.Glob("**/*.{ts,tsx}").scanSync(SRC)) {
  if (/\.test\.tsx?$/.test(file)) continue;
  const specifier = `@/${file.replace(/\.tsx?$/, "").replace(/\/index$/, "")}`;
  mock.module(specifier, async () => await import(join(SRC, file)));
}

GlobalRegistrator.register();
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const { createRoot } = await import("react-dom/client");
const { StateProvider, ActionProvider } = await import("@json-render/react");
const { MemoryRouter } = await import("react-router");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { swarmComponents } = await import("./components");

type Viewport = { happyDOM: { setViewport(v: { width: number }): void } };
const setWidth = (width: number) => (window as unknown as Viewport).happyDOM.setViewport({ width });

beforeEach(() => {
  document.body.innerHTML = "";
});

const roots: { unmount(): void }[] = [];

afterEach(async () => {
  // Unmount so no scheduled React work outlives GlobalRegistrator.unregister().
  await act(async () => {
    for (const root of roots.splice(0)) root.unmount();
  });
  setWidth(1024);
});

afterAll(async () => {
  await GlobalRegistrator.unregister();
});

async function mountPhoneTable(
  columns: Record<string, unknown>[],
  rows: Record<string, unknown>[],
) {
  setWidth(500);
  const Table = swarmComponents.Table as (arg: { props: unknown }) => React.ReactNode;
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  roots.push(root);
  await act(async () =>
    root.render(
      // useIsMobile reads the width in an effect, so the first render is the
      // desktop grid (it needs a router); the effect then swaps in the card list.
      <QueryClientProvider client={new QueryClient()}>
        <MemoryRouter>
          <StateProvider initialState={{}}>
            <ActionProvider handlers={{}}>
              {Table({ props: { columns, data: rows, mobile: "list", pagination: false } })}
            </ActionProvider>
          </StateProvider>
        </MemoryRouter>
      </QueryClientProvider>,
    ),
  );
  return host;
}

const toggleChain = [{ action: "setState", params: { statePath: "/x", value: true } }];

const controlLabels = (host: HTMLElement) =>
  [...host.querySelectorAll('[role="checkbox"], [role="switch"]')].map((el) =>
    el.getAttribute("aria-label"),
  );

test("the phone card renders a formatted or link checkbox/switch column as text, a plain onChange one as a control", async () => {
  const host = await mountPhoneTable(
    [
      { key: "name", label: "Name" },
      { key: "plain", label: "Plain", kind: "checkbox", onChange: toggleChain },
      { key: "fmt", label: "Fmt", kind: "checkbox", format: "FMT-{{name}}", onChange: toggleChain },
      { key: "sw", label: "Sw", kind: "switch", format: "SWFMT-{{name}}", onChange: toggleChain },
      {
        key: "lnk",
        label: "Lnk",
        kind: "checkbox",
        href: "https://example.com/{{name}}",
        onChange: toggleChain,
      },
    ],
    [{ id: "r1", name: "proxy88", plain: false, fmt: true, sw: true, lnk: true }],
  );
  // Exactly one control: the plain editable checkbox.
  expect(controlLabels(host)).toEqual(["Plain: proxy88"]);
  // The formatted columns keep their templated text on the card.
  expect(host.textContent).toContain("FMT-proxy88");
  expect(host.textContent).toContain("SWFMT-proxy88");
});

test("the phone card shows the whole title, no line clamp", async () => {
  const title = "feat(models): profile validity check, credential allowlist, tier overrides";
  const host = await mountPhoneTable(
    [
      { key: "name", label: "Name" },
      { key: "state", label: "State" },
    ],
    [{ id: "r1", name: title, state: "open" }],
  );
  const span = host.querySelector("li span.font-medium")!;
  expect(span.textContent).toBe(title);
  expect(span.className).not.toContain("line-clamp");
});
