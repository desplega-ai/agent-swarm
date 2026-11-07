import { afterAll, beforeEach, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";

GlobalRegistrator.register();
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const { createRoot } = await import("react-dom/client");

mock.module("@/lib/utils", () => require("../../lib/utils"));
mock.module("@/components/ui/button", () => require("../../components/ui/button"));
mock.module("@/components/ui/checkbox", () => require("../../components/ui/checkbox"));
mock.module("@/components/ui/input", () => require("../../components/ui/input"));
mock.module("@/components/ui/popover", () => require("../../components/ui/popover"));
mock.module("@/components/ui/tooltip", () => require("../../components/ui/tooltip"));

const { TooltipProvider } = await import("../../components/ui/tooltip");
const { ColumnFilterPanel, ColumnHeader, FilterPills, PhoneFilterButton, createFilterStore } =
  await import("./table-filters-ui");

beforeEach(() => {
  document.body.innerHTML = "";
});

afterAll(async () => {
  await GlobalRegistrator.unregister();
});

async function mount(node: React.ReactNode) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(<TooltipProvider>{node}</TooltipProvider>));
  return { host, root };
}

function click(el: Element) {
  return act(async () => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
}

function fireInput(el: HTMLInputElement, value: string) {
  return act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    setter.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

const ci = { key: "ci", label: "CI on head", mode: "values" as const };
const title = { key: "title", label: "Title", mode: "text" as const };

function storeWith(filters: Record<string, string | string[]> = {}) {
  const store = createFilterStore();
  store.update({
    filters,
    facets: {
      ci: [
        { value: "green", label: "green", count: 9 },
        { value: "red", label: "red", count: 1 },
      ],
    },
  });
  const calls: unknown[][] = [];
  store.handlers = {
    toggle: (...args) => calls.push(["toggle", ...args]),
    setText: (...args) => calls.push(["setText", ...args]),
    clear: (...args) => calls.push(["clear", ...args]),
    clearAll: () => calls.push(["clearAll"]),
  };
  return { store, calls };
}

test("the values panel lists each value with its count and reports a toggle", async () => {
  const { store, calls } = storeWith({ ci: ["red"] });
  const { host } = await mount(<ColumnFilterPanel target={ci} store={store} />);

  const boxes = [...host.querySelectorAll<HTMLButtonElement>('button[role="checkbox"]')];
  expect(boxes.map((b) => b.getAttribute("aria-label"))).toEqual(["green, 9 rows", "red, 1 row"]);
  expect(boxes.map((b) => b.getAttribute("aria-checked"))).toEqual(["false", "true"]);
  expect(host.textContent).toContain("1 selected");

  await click(boxes[0]!);
  await click(boxes[1]!);
  expect(calls).toEqual([
    ["toggle", "ci", "green", true],
    ["toggle", "ci", "red", false],
  ]);
});

test("Clear is disabled with nothing selected and clears the column otherwise", async () => {
  const none = storeWith();
  const first = await mount(<ColumnFilterPanel target={ci} store={none.store} />);
  const clearIdle = [...first.host.querySelectorAll("button")].find(
    (b) => b.textContent === "Clear",
  ) as HTMLButtonElement;
  expect(clearIdle.disabled).toBe(true);
  expect(first.host.textContent).toContain("Showing all");

  document.body.innerHTML = "";
  const some = storeWith({ ci: ["green"] });
  const second = await mount(<ColumnFilterPanel target={ci} store={some.store} />);
  const clear = [...second.host.querySelectorAll("button")].find(
    (b) => b.textContent === "Clear",
  ) as HTMLButtonElement;
  await click(clear);
  expect(some.calls).toEqual([["clear", "ci"]]);
});

test("a long list gets a find field that narrows the options", async () => {
  const store = createFilterStore();
  store.update({
    filters: {},
    facets: {
      ci: Array.from({ length: 12 }, (_, i) => ({
        value: `v${i}`,
        label: i === 3 ? "needle" : `value ${i}`,
        count: i + 1,
      })),
    },
  });
  const { host } = await mount(<ColumnFilterPanel target={ci} store={store} />);
  expect(host.querySelectorAll('button[role="checkbox"]')).toHaveLength(12);
  const find = host.querySelector<HTMLInputElement>('input[aria-label="Find a CI on head value"]')!;
  await fireInput(find, "needle");
  expect(host.querySelectorAll('button[role="checkbox"]')).toHaveLength(1);
  await fireInput(find, "zzz");
  expect(host.textContent).toContain("No values match");
});

test("a short list has no find field and an empty one says so", async () => {
  const { store } = storeWith();
  const { host } = await mount(<ColumnFilterPanel target={ci} store={store} />);
  expect(host.querySelector("input")).toBeNull();

  document.body.innerHTML = "";
  const empty = createFilterStore();
  const second = await mount(<ColumnFilterPanel target={ci} store={empty} />);
  expect(second.host.textContent).toContain("No values yet");
});

test("the text panel writes what is typed and clears it", async () => {
  const { store, calls } = storeWith({ title: "fix" });
  const { host } = await mount(<ColumnFilterPanel target={title} store={store} />);
  const input = host.querySelector<HTMLInputElement>('input[aria-label="Title contains"]')!;
  expect(input.value).toBe("fix");
  await fireInput(input, "feat");
  const clear = [...host.querySelectorAll("button")].find(
    (b) => b.textContent === "Clear",
  ) as HTMLButtonElement;
  await click(clear);
  expect(calls).toEqual([
    ["setText", "title", "feat"],
    ["clear", "title"],
  ]);
});

test("a value renderer replaces the plain label", async () => {
  const { store } = storeWith();
  const { host } = await mount(
    <ColumnFilterPanel
      target={{ ...ci, renderValue: (_value, label) => <b data-pill>{label.toUpperCase()}</b> }}
      store={store}
    />,
  );
  expect([...host.querySelectorAll("[data-pill]")].map((n) => n.textContent)).toEqual([
    "GREEN",
    "RED",
  ]);
});

test("the header menu opens on click, marks an active filter, and never reaches the header", async () => {
  let headerClicks = 0;
  const { store } = storeWith({ ci: ["red"] });
  const { host } = await mount(
    <div onClick={() => headerClicks++}>
      <ColumnHeader displayName="CI on head" store={store} filter={ci} />
    </div>,
  );
  expect(host.textContent).toContain("CI on head");
  const button = host.querySelector<HTMLButtonElement>('button[aria-label^="Filter CI on head"]')!;
  expect(button.getAttribute("aria-label")).toBe("Filter CI on head (active)");
  expect(button.dataset.active).toBe("true");

  await click(button);
  expect(headerClicks).toBe(0);
  expect(document.body.querySelector('[data-slot="popover-content"]')).not.toBeNull();
  expect(document.body.textContent).toContain("green");
});

test("a column with no filter renders just its label, with the icon when given", async () => {
  const { host } = await mount(<ColumnHeader displayName="Findings" />);
  expect(host.querySelector("button")).toBeNull();
  expect(host.textContent).toBe("Findings");
});

test("a header with a hint keeps the filter menu beside its label", async () => {
  const { store } = storeWith({});
  const { host } = await mount(
    <ColumnHeader
      displayName="CI on head"
      hint="Status of the last run"
      store={store}
      filter={ci}
    />,
  );
  expect(host.textContent).toContain("CI on head");
  expect(host.querySelector('button[aria-label^="Filter CI on head"]')).not.toBeNull();
});

test("pills show each filter, remove one, and clear all", async () => {
  const removed: string[] = [];
  let cleared = 0;
  const { host } = await mount(
    <FilterPills
      pills={[
        { key: "ci", column: "CI on head", text: "red, pending" },
        { key: "title", column: "Title", text: 'contains "fix"' },
      ]}
      onRemove={(key) => removed.push(key)}
      onClearAll={() => cleared++}
    />,
  );
  const group = host.querySelector('[aria-label="Active filters"]')!;
  expect(group.textContent).toContain("CI on headred, pending");
  await click(host.querySelector('button[aria-label="Remove Title filter"]')!);
  const clearAll = [...host.querySelectorAll("button")].find((b) => b.textContent === "Clear all")!;
  await click(clearAll);
  expect(removed).toEqual(["title"]);
  expect(cleared).toBe(1);
});

test("no pills renders nothing", async () => {
  const { host } = await mount(
    <FilterPills pills={[]} onRemove={() => {}} onClearAll={() => {}} />,
  );
  expect(host.innerHTML).toBe("");
});

test("the phone button counts active filters and opens a section per column", async () => {
  const { store } = storeWith({ ci: ["red"] });
  const { host } = await mount(
    <PhoneFilterButton targets={[ci, title]} store={store} activeCount={1} />,
  );
  const button = host.querySelector("button")!;
  expect(button.textContent).toContain("Filters");
  expect(button.textContent).toContain("1");
  await click(button);
  const content = document.body.querySelector('[data-slot="popover-content"]')!;
  expect([...content.querySelectorAll("h3")].map((h) => h.textContent)).toEqual([
    "CI on head",
    "Title",
  ]);
  // Capped at the room beside the trigger, or a mid-screen button pushes the top off-screen.
  expect(content.className).toContain("var(--radix-popover-content-available-height)");
  expect(content.className).toContain("overflow-y-auto");
});

test("the store only notifies when the snapshot really changed", () => {
  const store = createFilterStore();
  let notified = 0;
  store.subscribe(() => notified++);
  store.update({ filters: { ci: ["red"] }, facets: {} });
  store.update({ filters: { ci: ["red"] }, facets: {} });
  store.update({ filters: {}, facets: {} });
  expect(notified).toBe(2);
});
