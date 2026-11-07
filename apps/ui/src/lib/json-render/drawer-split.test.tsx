import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { join } from "node:path";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, type ReactNode } from "react";

// Every `@/` specifier maps to its real file (bun does not resolve vite's alias).
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
const { MemoryRouter, useLocation } = await import("react-router");
const { swarmComponents } = await import("./components");
const { SplitDetailRegion, SPLIT_DEFAULT_WIDTH, SPLIT_MIN_WIDTH, splitWidthKey } = await import(
  "./split-pane"
);

type Viewport = { happyDOM: { setViewport(v: { width: number }): void } };
const setViewport = (width: number) =>
  (window as unknown as Viewport).happyDOM.setViewport({ width });

const STORAGE = "test:apps:app-1:split";
const roots: { unmount(): void }[] = [];
let lastSearch = "";

function LocationProbe() {
  lastSearch = useLocation().search;
  return null;
}

beforeEach(() => {
  document.body.innerHTML = "";
  localStorage.clear();
  setViewport(1440);
});

afterEach(async () => {
  await act(async () => {
    for (const root of roots.splice(0)) root.unmount();
  });
});

afterAll(async () => {
  await GlobalRegistrator.unregister();
});

const Drawer = swarmComponents.Drawer as (arg: {
  props: unknown;
  children?: ReactNode;
}) => ReactNode;

async function mount({
  open = true,
  presentation = "split",
  region = true,
}: {
  open?: boolean;
  presentation?: string;
  region?: boolean;
} = {}) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  roots.push(root);
  const drawer = (
    <Drawer props={{ param: "issue", presentation, title: "Issue", size: "md" }}>
      <p data-testid="detail-body">Issue detail</p>
    </Drawer>
  );
  await act(async () =>
    root.render(
      <MemoryRouter initialEntries={[open ? "/apps/app-1?issue=42&tab=x" : "/apps/app-1?tab=x"]}>
        <LocationProbe />
        <StateProvider initialState={{ route: { params: open ? { issue: "42" } : {} } }}>
          <ActionProvider handlers={{}}>
            {region ? (
              <SplitDetailRegion storageKey={STORAGE} fill={false}>
                <p data-testid="canvas">Canvas</p>
                {drawer}
              </SplitDetailRegion>
            ) : (
              drawer
            )}
          </ActionProvider>
        </StateProvider>
      </MemoryRouter>,
    ),
  );
  // useIsMobile settles in an effect.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

const pane = () => document.querySelector<HTMLElement>('[data-testid="json-render-drawer-split"]');
const slot = () => document.querySelector<HTMLElement>('[data-testid="split-detail-slot"]');
const handle = () => document.querySelector<HTMLElement>('[data-testid="resize-handle"]');
const sheet = () => document.querySelector('[data-testid="json-render-drawer"]');

describe("Drawer presentation split", () => {
  test("the param opens the pane inline, inside the region's slot", async () => {
    await mount();
    expect(pane()).not.toBeNull();
    expect(slot()?.contains(pane())).toBe(true);
    expect(pane()?.textContent).toContain("Issue detail");
    expect(sheet()).toBeNull();
    expect(pane()?.style.width).toBe(`${SPLIT_DEFAULT_WIDTH.md}px`);
  });

  test("no param renders no pane", async () => {
    await mount({ open: false });
    expect(pane()).toBeNull();
    expect(sheet()).toBeNull();
  });

  test("close clears the param and keeps the rest of the URL", async () => {
    await mount();
    expect(lastSearch).toContain("issue=42");
    await act(async () => {
      document
        .querySelector<HTMLButtonElement>('[data-testid="json-render-drawer-split-close"]')
        ?.click();
    });
    expect(lastSearch).not.toContain("issue=");
    expect(lastSearch).toContain("tab=x");
  });

  test("keyboard resize changes the width and persists it per param", async () => {
    await mount();
    const key = splitWidthKey(STORAGE, "issue");
    await act(async () => {
      handle()?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }));
    });
    expect(pane()?.style.width).toBe(`${SPLIT_DEFAULT_WIDTH.md + 16}px`);
    expect(localStorage.getItem(key)).toBe(String(SPLIT_DEFAULT_WIDTH.md + 16));
    await act(async () => {
      handle()?.dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowRight", shiftKey: true, bubbles: true }),
      );
    });
    expect(pane()?.style.width).toBe(`${SPLIT_DEFAULT_WIDTH.md + 16 - 64}px`);
    await act(async () => {
      handle()?.dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true }));
    });
    expect(pane()?.style.width).toBe(`${SPLIT_MIN_WIDTH}px`);
    expect(handle()?.getAttribute("aria-valuenow")).toBe(String(SPLIT_MIN_WIDTH));
  });

  test("a stored width is restored on the next mount, and double-click resets it", async () => {
    localStorage.setItem(splitWidthKey(STORAGE, "issue"), "520");
    await mount();
    expect(pane()?.style.width).toBe("520px");
    await act(async () => {
      handle()?.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    });
    expect(pane()?.style.width).toBe(`${SPLIT_DEFAULT_WIDTH.md}px`);
    expect(localStorage.getItem(splitWidthKey(STORAGE, "issue"))).toBeNull();
  });

  test("below md it falls back to the sheet", async () => {
    setViewport(390);
    await mount();
    expect(pane()).toBeNull();
    expect(sheet()).not.toBeNull();
  });

  test("without a detail region (the pages renderer) it is the sheet", async () => {
    await mount({ region: false });
    expect(pane()).toBeNull();
    expect(sheet()).not.toBeNull();
  });

  test("control: presentation sheet inside a region stays a sheet", async () => {
    await mount({ presentation: "sheet" });
    expect(pane()).toBeNull();
    expect(sheet()).not.toBeNull();
  });
});
