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
const { StateProvider, ActionProvider, useStateStore } = await import("@json-render/react");
const { MemoryRouter, useLocation } = await import("react-router");
const { swarmComponents } = await import("./components");
const { openAccordionKeys } = await import("./accordion");

const roots: { unmount(): void }[] = [];
let lastSearch = "";
let snapshot: () => Record<string, unknown> = () => ({});

function Probe() {
  lastSearch = useLocation().search;
  snapshot = useStateStore().getSnapshot;
  return null;
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
  await GlobalRegistrator.unregister();
});

type Renderable = (arg: { props: unknown; children?: ReactNode }) => ReactNode;
const Accordion = swarmComponents.Accordion as Renderable;
const Dialog = swarmComponents.Dialog as Renderable;

const ITEMS = [
  { key: "billing", title: "Billing" },
  { key: "limits", title: "Limits" },
  { key: "sso", title: "SSO" },
];

async function mount(node: ReactNode, url = "/apps/a", state: Record<string, unknown> = {}) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  roots.push(root);
  await act(async () =>
    root.render(
      <MemoryRouter initialEntries={[url]}>
        <StateProvider initialState={state}>
          <Probe />
          <ActionProvider handlers={{}}>{node}</ActionProvider>
        </StateProvider>
      </MemoryRouter>,
    ),
  );
}

function bodies() {
  return ["billing", "limits", "sso"].map((key) => ({
    key,
    open:
      document
        .querySelector(`[data-testid="json-render-accordion-item-${key}"]`)
        ?.getAttribute("data-state") === "open",
  }));
}

async function clickTrigger(key: string) {
  await act(async () => {
    document
      .querySelector<HTMLButtonElement>(`[data-testid="json-render-accordion-item-${key}"] button`)
      ?.click();
  });
}

const openKeys = () => (snapshot().ui as Record<string, { open?: unknown }> | undefined)?.faq?.open;

function accordion(type: "single" | "multiple", defaultOpen?: string[]) {
  return (
    <Accordion props={{ id: "faq", type, items: ITEMS, defaultOpen }}>
      {[<p key="1">billing body</p>, <p key="2">limits body</p>, <p key="3">sso body</p>]}
    </Accordion>
  );
}

describe("Accordion", () => {
  test("single mode: opening one closes the others, and the open one can close", async () => {
    await mount(accordion("single", ["billing"]));
    expect(
      bodies()
        .filter((b) => b.open)
        .map((b) => b.key),
    ).toEqual(["billing"]);
    expect(openKeys()).toEqual(["billing"]);
    await clickTrigger("limits");
    expect(
      bodies()
        .filter((b) => b.open)
        .map((b) => b.key),
    ).toEqual(["limits"]);
    expect(openKeys()).toEqual(["limits"]);
    expect(document.body.textContent).toContain("limits body");
    expect(document.body.textContent).not.toContain("billing body");
    await clickTrigger("limits");
    expect(bodies().every((b) => !b.open)).toBe(true);
    expect(openKeys()).toEqual([]);
  });

  test("multiple mode keeps several open", async () => {
    await mount(accordion("multiple"));
    expect(openKeys()).toEqual([]);
    await clickTrigger("billing");
    await clickTrigger("sso");
    expect(
      bodies()
        .filter((b) => b.open)
        .map((b) => b.key),
    ).toEqual(["billing", "sso"]);
    expect(openKeys()).toEqual(["billing", "sso"]);
  });

  test("stored open keys win over defaultOpen; unknown keys are dropped", async () => {
    await mount(accordion("multiple", ["billing"]), "/apps/a", {
      ui: { faq: { open: ["sso", "gone"] } },
    });
    expect(
      bodies()
        .filter((b) => b.open)
        .map((b) => b.key),
    ).toEqual(["sso"]);
    expect(openKeys()).toEqual(["sso"]);
  });

  test("openAccordionKeys: single keeps the first, duplicates collapse", () => {
    expect(openAccordionKeys(undefined, ITEMS, "single", ["limits", "sso"])).toEqual(["limits"]);
    expect(openAccordionKeys(["sso", "sso", 3], ITEMS, "multiple", undefined)).toEqual(["sso"]);
  });
});

describe("Dialog", () => {
  const dialog = (
    <Dialog props={{ param: "item", title: "New item", size: "sm" }}>
      <p data-testid="dialog-body">form</p>
    </Dialog>
  );
  const dialogEl = () => document.querySelector('[data-testid="json-render-dialog"]');

  test("opens on its param", async () => {
    await mount(dialog, "/apps/a?item=new", { route: { params: { item: "new" } } });
    expect(dialogEl()).not.toBeNull();
    expect(dialogEl()?.textContent).toContain("New item");
    expect(document.querySelector('[data-testid="dialog-body"]')).not.toBeNull();
  });

  test("stays closed without its param", async () => {
    await mount(dialog, "/apps/a", { route: { params: {} } });
    expect(dialogEl()).toBeNull();
  });

  test("the close button clears the param and keeps the rest of the URL", async () => {
    await mount(dialog, "/apps/a?item=new&tab=x", { route: { params: { item: "new" } } });
    expect(lastSearch).toContain("item=new");
    await act(async () => {
      document.querySelector<HTMLButtonElement>('[data-slot="dialog-close"]')?.click();
    });
    expect(lastSearch).not.toContain("item=");
    expect(lastSearch).toContain("tab=x");
  });
});
