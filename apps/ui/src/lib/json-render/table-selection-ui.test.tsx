import { afterAll, beforeEach, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";

GlobalRegistrator.register();
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const { createRoot } = await import("react-dom/client");

mock.module("@/lib/utils", () => require("../../lib/utils"));
mock.module("@/components/ui/button", () => require("../../components/ui/button"));
mock.module("@/components/ui/checkbox", () => require("../../components/ui/checkbox"));

const { BulkActionBar, SelectAllHeader, SelectCell, TableCheckbox, createSelectionStore } =
  await import("./table-selection-ui");

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
  await act(async () => root.render(node));
  return { host, root, rerender: (next: React.ReactNode) => act(async () => root.render(next)) };
}

const checkboxes = (host: HTMLElement) => [
  ...host.querySelectorAll<HTMLButtonElement>('button[role="checkbox"]'),
];

function click(el: Element, init: MouseEventInit = {}) {
  return act(async () => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, ...init }));
  });
}

test("TableCheckbox reports shift, shows all three states, and keeps the click off the row", async () => {
  const seen: boolean[] = [];
  let rowClicks = 0;
  const { host, rerender } = await mount(
    <div onClick={() => rowClicks++}>
      <TableCheckbox checked={false} label="Pick" onToggle={(e) => seen.push(e.shiftKey)} />
    </div>,
  );
  const box = checkboxes(host)[0]!;
  expect(box.getAttribute("aria-label")).toBe("Pick");
  expect(box.getAttribute("aria-checked")).toBe("false");

  await click(box);
  await click(box, { shiftKey: true });
  expect(seen).toEqual([false, true]);
  expect(rowClicks).toBe(0);

  await rerender(<TableCheckbox checked="indeterminate" label="Pick" onToggle={() => {}} />);
  expect(checkboxes(host)[0]!.getAttribute("aria-checked")).toBe("mixed");
  await rerender(<TableCheckbox checked label="Pick" onToggle={() => {}} />);
  expect(checkboxes(host)[0]!.getAttribute("aria-checked")).toBe("true");
});

function storeWith(selected: string[], visibleIds: string[]) {
  const store = createSelectionStore();
  store.rowId = (row) => String(row.id);
  store.rowLabel = (row) => `Select ${row.id}`;
  store.update({ selected, visibleIds });
  return store;
}

test("the select cell mirrors the store and sends a toggle (with display order on shift)", async () => {
  const store = storeWith(["b"], ["a", "b", "c"]);
  const calls: unknown[] = [];
  store.handlers = {
    toggleRow: (id, checked, order) => calls.push([id, checked, order]),
    toggleAll: () => {},
  };
  const shown = ["c", "b", "a"];
  const api = {
    getDisplayedRowCount: () => shown.length,
    getDisplayedRowAtIndex: (index: number) => ({ data: { id: shown[index] } }),
  };
  const cell = (id: string) => <SelectCell store={store} data={{ id }} api={api as never} />;
  const { host } = await mount(
    <>
      {cell("a")}
      {cell("b")}
    </>,
  );
  const [a, b] = checkboxes(host);
  expect(a!.getAttribute("aria-checked")).toBe("false");
  expect(a!.getAttribute("aria-label")).toBe("Select a");
  expect(b!.getAttribute("aria-checked")).toBe("true");

  await click(a!);
  await click(b!, { shiftKey: true });
  expect(calls).toEqual([
    ["a", true, null],
    ["b", false, ["c", "b", "a"]],
  ]);
});

test("a store update re-renders subscribed cells without new props", async () => {
  const store = storeWith([], ["a"]);
  const { host } = await mount(<SelectCell store={store} data={{ id: "a" }} api={{} as never} />);
  expect(checkboxes(host)[0]!.getAttribute("aria-checked")).toBe("false");
  await act(async () => store.update({ selected: ["a"], visibleIds: ["a"] }));
  expect(checkboxes(host)[0]!.getAttribute("aria-checked")).toBe("true");
});

test("the select-all header is tri-state over the visible rows and calls toggleAll", async () => {
  const store = storeWith(["a"], ["a", "b"]);
  let all = 0;
  store.handlers = { toggleRow: () => {}, toggleAll: () => all++ };
  const { host } = await mount(<SelectAllHeader store={store} />);
  const box = () => checkboxes(host)[0]!;
  expect(box().getAttribute("aria-label")).toBe("Select all rows");
  expect(box().getAttribute("aria-checked")).toBe("mixed");

  await click(box());
  expect(all).toBe(1);

  await act(async () => store.update({ selected: ["a", "b"], visibleIds: ["a", "b"] }));
  expect(box().getAttribute("aria-checked")).toBe("true");

  // A filter that hides every row leaves nothing to select.
  await act(async () => store.update({ selected: ["a"], visibleIds: [] }));
  expect(box().hasAttribute("disabled")).toBe(true);
});

test("the store notifies only when the selection or the visible rows really changed", () => {
  const store = storeWith(["a"], ["a", "b"]);
  let notified = 0;
  store.subscribe(() => notified++);
  store.update({ selected: ["a"], visibleIds: ["a", "b"] });
  expect(notified).toBe(0);
  store.update({ selected: ["a", "b"], visibleIds: ["a", "b"] });
  expect(notified).toBe(1);
});

test("the bulk bar shows the count, hidden rows, the actions and Clear", async () => {
  const ran: number[] = [];
  let cleared = 0;
  const actions = [
    { label: "Add to MQ", icon: "git-pull-request" as const, actions: [{ action: "app.refresh" }] },
    { label: "Delete", variant: "destructive" as const, actions: [{ action: "app.refresh" }] },
  ];
  const { host, rerender } = await mount(
    <BulkActionBar
      count={3}
      hidden={1}
      actions={actions}
      onRun={(i) => ran.push(i)}
      onClear={() => cleared++}
    />,
  );
  const bar = host.querySelector('[data-testid="table-bulk-bar"]')!;
  expect(bar.textContent).toContain("3 selected");
  expect(bar.textContent).toContain("(1 hidden)");
  const buttons = [...bar.querySelectorAll("button")];
  expect(buttons.map((b) => b.textContent?.trim())).toEqual(["Add to MQ", "Delete", "Clear"]);

  await click(buttons[1]!);
  await click(buttons[2]!);
  expect(ran).toEqual([1]);
  expect(cleared).toBe(1);

  await rerender(
    <BulkActionBar
      count={1}
      hidden={0}
      actions={actions}
      busy
      onRun={() => {}}
      onClear={() => {}}
    />,
  );
  const busy = [...host.querySelectorAll("button")];
  expect(busy.every((b) => b.hasAttribute("disabled"))).toBe(true);
  expect(host.textContent).not.toContain("hidden");
});
