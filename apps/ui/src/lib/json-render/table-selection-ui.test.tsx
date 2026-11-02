import { afterAll, beforeEach, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";

GlobalRegistrator.register();
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const { createRoot } = await import("react-dom/client");

mock.module("@/lib/utils", () => require("../../lib/utils"));
mock.module("@/components/ui/button", () => require("../../components/ui/button"));
mock.module("@/components/ui/checkbox", () => require("../../components/ui/checkbox"));
mock.module("@/components/ui/skeleton", () => require("../../components/ui/skeleton"));

const { MobileListRow } = await import("../../components/shared/mobile-list");
const {
  BulkActionBar,
  SelectAllHeader,
  SelectCell,
  TableCheckbox,
  createSelectionStore,
  useBulkRunner,
} = await import("./table-selection-ui");

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

test("a phone row's checkbox sits beside the row button, never inside it", async () => {
  const changes: string[] = [];
  const opened: string[] = [];
  const { host } = await mount(
    <ul>
      <MobileListRow
        title="proxy#88"
        onClick={() => opened.push("row")}
        check={{
          checked: "indeterminate",
          label: "Select proxy#88",
          onChange: () => changes.push("x"),
        }}
      />
    </ul>,
  );
  const box = checkboxes(host)[0]!;
  expect(box.getAttribute("aria-label")).toBe("Select proxy#88");
  expect(box.getAttribute("aria-checked")).toBe("mixed");
  // A checkbox is a button: nesting it in the row's own button is invalid HTML.
  expect(box.closest("li > div > button")).toBeNull();

  await click(box);
  expect(changes).toEqual(["x"]);
  expect(opened).toEqual([]);
});

test("a phone row's editable columns render as real controls beside the row, not as text", async () => {
  const toggled: boolean[] = [];
  const opened: string[] = [];
  const { host } = await mount(
    <ul>
      <MobileListRow
        title="proxy#88"
        meta={["open"]}
        onClick={() => opened.push("row")}
        controls={[
          <TableCheckbox
            key="done"
            checked={false}
            label="Done: proxy#88"
            onToggle={() => toggled.push(true)}
          />,
        ]}
      />
    </ul>,
  );
  const box = checkboxes(host).find((b) => b.getAttribute("aria-label") === "Done: proxy#88")!;
  expect(box).toBeDefined();
  const rowButton = host.querySelector('li button:not([role="checkbox"])')!;
  expect(rowButton).not.toBeNull();
  // The control is a sibling of the row's button, never inside it.
  expect(rowButton.contains(box)).toBe(false);
  expect(rowButton.textContent).not.toContain("Done");

  await click(box);
  expect(toggled).toEqual([true]);
  expect(opened).toEqual([]);
});

test("a phone row's selection checkbox is disabled while a bulk chain runs", async () => {
  const { host } = await mount(
    <ul>
      <MobileListRow
        title="proxy#88"
        check={{ checked: false, label: "Select proxy#88", onChange: () => {}, disabled: true }}
      />
    </ul>,
  );
  expect(checkboxes(host)[0]!.hasAttribute("disabled")).toBe(true);
});

test("a locked store disables the select cell and the select-all header", async () => {
  const store = storeWith(["a"], ["a", "b"]);
  store.update({ selected: ["a"], visibleIds: ["a", "b"], locked: true });
  const calls: string[] = [];
  store.handlers = { toggleRow: (id) => calls.push(id), toggleAll: () => calls.push("all") };
  const api = { getDisplayedRowCount: () => 0, getDisplayedRowAtIndex: () => undefined } as never;
  const { host } = await mount(
    <>
      <SelectAllHeader store={store} />
      <SelectCell store={store} data={{ id: "a" }} api={api} />
    </>,
  );
  const boxes = checkboxes(host);
  expect(boxes.map((b) => b.hasAttribute("disabled"))).toEqual([true, true]);
  await click(boxes[0]!);
  await click(boxes[1]!);
  expect(calls).toEqual([]);
});

// ─── Bulk runner ────────────────────────────────────────────────────────────

type Binding = { action: string; params?: Record<string, unknown> };

/** A fake app runtime: a state map plus a scripted handler per step. */
function runtime(
  initial: string[],
  handler: (binding: Binding, state: Map<string, unknown>) => Promise<void> | void,
) {
  const state = new Map<string, unknown>([["/ui/t/selected", initial]]);
  const executed: Binding[] = [];
  let bulk!: ReturnType<typeof useBulkRunner>;
  const actions = [
    {
      label: "Go",
      actions: [
        { action: "app.mutate", params: { model: "pr", op: "update" } },
        { action: "app.action", params: { name: "after" } },
      ],
    },
  ];
  function Harness() {
    bulk = useBulkRunner({
      actions,
      selectionPath: "/ui/t/selected",
      outcomePath: "/ui/t/bulkOutcome",
      pollMs: 1,
      execute: async (binding) => {
        executed.push(binding);
        await handler(binding, state);
      },
      getSnapshot: () => Object.fromEntries(state),
      get: (path) => state.get(path),
      set: (path, value) => void state.set(path, value),
    });
    return <span data-testid="busy">{String(bulk.busy)}</span>;
  }
  const selected = () => state.get("/ui/t/selected") as string[];
  return { Harness, state, executed, selected, bulk: () => bulk };
}

const run = (rt: ReturnType<typeof runtime>) => act(async () => void (await rt.bulk().run(0)));
const mutateOk = (b: Binding, state: Map<string, unknown>) => {
  if (b.action === "app.mutate") state.set(b.params?.$outcome as string, { status: "ok" });
};

test("a failed app.mutate keeps the selection and stops the chain", async () => {
  const rt = runtime(["a", "b"], (b, state) => {
    if (b.action === "app.mutate") {
      state.set(b.params?.$outcome as string, { status: "error", error: "boom" });
    }
  });
  await mount(<rt.Harness />);
  await run(rt);
  expect(rt.selected()).toEqual(["a", "b"]);
  expect(rt.executed.map((b) => b.action)).toEqual(["app.mutate"]);
});

test("a task-backed action holds the selection until the task ends, and a later failure keeps it", async () => {
  let release!: () => void;
  const rt = runtime(["a", "b"], (b, state) => {
    mutateOk(b, state);
    if (b.params?.name === "after")
      state.set("/actions/after", { status: "running", taskId: "t1" });
  });
  const { host } = await mount(<rt.Harness />);
  const settled = new Promise<void>((resolve) => {
    release = resolve;
  });
  let running!: Promise<void>;
  await act(async () => {
    running = rt
      .bulk()
      .run(0)
      .then(() => release());
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  // The handler returned long ago, but the task has not: still busy, nothing cleared.
  expect(host.querySelector('[data-testid="busy"]')?.textContent).toBe("true");
  expect(rt.selected()).toEqual(["a", "b"]);

  await act(async () => {
    rt.state.set("/actions/after", { status: "error", taskId: "t1", error: "task failed" });
    await running;
    await settled;
  });
  expect(host.querySelector('[data-testid="busy"]')?.textContent).toBe("false");
  expect(rt.selected()).toEqual(["a", "b"]);
});

test("a task-backed action that completes clears the selection", async () => {
  const rt = runtime(["a"], (b, state) => {
    mutateOk(b, state);
    if (b.params?.name === "after")
      state.set("/actions/after", { status: "running", taskId: "t1" });
  });
  await mount(<rt.Harness />);
  let running!: Promise<void>;
  await act(async () => {
    running = rt.bulk().run(0);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(rt.selected()).toEqual(["a"]);
    rt.state.set("/actions/after", { status: "ok", taskId: "t1" });
    await running;
  });
  expect(rt.selected()).toEqual([]);
});

test("rows picked while the chain ran survive it; only the acted-on rows leave", async () => {
  const rt = runtime(["a"], (b, state) => {
    mutateOk(b, state);
    // A write that slipped past the UI lock (another component, a state binding).
    if (b.action === "app.mutate") state.set("/ui/t/selected", ["a", "late"]);
    if (b.params?.name === "after") state.set("/actions/after", { status: "ok" });
  });
  await mount(<rt.Harness />);
  await run(rt);
  expect(rt.selected()).toEqual(["late"]);
});

test("a second run while one is in flight is ignored", async () => {
  const rt = runtime(["a"], async (b, state) => {
    await new Promise((resolve) => setTimeout(resolve, 10));
    mutateOk(b, state);
    if (b.params?.name === "after") state.set("/actions/after", { status: "ok" });
  });
  await mount(<rt.Harness />);
  await act(async () => {
    const first = rt.bulk().run(0);
    expect(rt.bulk().busyRef.current).toBe(true);
    await rt.bulk().run(0);
    await first;
  });
  expect(rt.executed.filter((b) => b.action === "app.mutate")).toHaveLength(1);
  expect(rt.selected()).toEqual([]);
});

test("unmounting mid-task leaves the selection untouched", async () => {
  const rt = runtime(["a"], (b, state) => {
    mutateOk(b, state);
    if (b.params?.name === "after")
      state.set("/actions/after", { status: "running", taskId: "t1" });
  });
  const { root } = await mount(<rt.Harness />);
  let running!: Promise<void>;
  await act(async () => {
    running = rt.bulk().run(0);
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
  await act(async () => root.unmount());
  await running;
  expect(rt.selected()).toEqual(["a"]);
});
