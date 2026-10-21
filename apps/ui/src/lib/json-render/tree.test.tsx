import { afterAll, beforeEach, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { TREE_MAX_DEPTH, TREE_MAX_ROWS } from "./tree-model";

GlobalRegistrator.register();
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const { createRoot } = await import("react-dom/client");
const { StateProvider } = await import("@json-render/react");

mock.module("@/components/ui/card", () => require("../../components/ui/card"));
mock.module("@/components/ui/label", () => require("../../components/ui/label"));
mock.module("@/lib/utils", () => require("../../lib/utils"));

const { TreeComponent } = await import("./tree");
type TreeProps = Parameters<typeof TreeComponent>[0]["props"];

const nodes = {
  root: ["a", "d"],
  elements: {
    a: { type: "Stack", children: ["b", "c"] },
    b: { type: "Text" },
    c: { type: "Text" },
    d: { type: "Badge" },
  },
};

beforeEach(() => {
  document.body.innerHTML = "";
});

afterAll(async () => {
  await GlobalRegistrator.unregister();
});

type Change = { path: string; value: unknown };

async function mount(props: TreeProps, initialState: Record<string, unknown> = {}) {
  const changes: Change[] = [];
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const render = (next: TreeProps) =>
    act(async () =>
      root.render(
        <StateProvider
          initialState={initialState}
          onStateChange={(batch) => changes.push(...batch)}
        >
          <TreeComponent props={next} />
        </StateProvider>,
      ),
    );
  await render(props);
  return { host, changes, rerender: render, unmount: () => act(async () => root.unmount()) };
}

function rows(host: HTMLElement): HTMLButtonElement[] {
  return [...host.querySelectorAll<HTMLButtonElement>('button[data-slot="tree-row"]')];
}

function rowKeys(host: HTMLElement): string[] {
  return rows(host).map(
    (button) => button.querySelector('[data-slot="tree-row-key"]')?.textContent ?? "",
  );
}

function selectedKeys(host: HTMLElement): string[] {
  return rows(host)
    .filter((button) => button.getAttribute("aria-current") === "true")
    .map((button) => button.querySelector('[data-slot="tree-row-key"]')?.textContent ?? "");
}

function press(target: HTMLElement, key: string) {
  return act(async () => {
    target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
  });
}

test("clicking a row writes its key to /ui/<id>/value and the row renders selected", async () => {
  const { host, changes, unmount } = await mount({ id: "nodes", nodes });
  expect(rowKeys(host)).toEqual(["a", "b", "c", "d"]);
  expect(selectedKeys(host)).toEqual([]);

  await act(async () => rows(host)[1]?.click());
  expect(changes).toEqual([{ path: "/ui/nodes/value", value: "b" }]);
  expect(selectedKeys(host)).toEqual(["b"]);
  await unmount();
});

test("the row bound to an already-stored value starts selected", async () => {
  const { host, unmount } = await mount({ id: "nodes", nodes }, { ui: { nodes: { value: "d" } } });
  expect(selectedKeys(host)).toEqual(["d"]);
  await unmount();
});

test("a non-string stored value selects nothing", async () => {
  const { host, unmount } = await mount({ id: "nodes", nodes }, { ui: { nodes: { value: 42 } } });
  expect(rowKeys(host)).toEqual(["a", "b", "c", "d"]);
  expect(selectedKeys(host)).toEqual([]);
  await unmount();
});

test("the selection survives its key leaving the doc, without a write", async () => {
  const { host, changes, rerender, unmount } = await mount({ id: "nodes", nodes });
  await act(async () => rows(host)[1]?.click());
  expect(selectedKeys(host)).toEqual(["b"]);

  await rerender({
    id: "nodes",
    nodes: {
      root: ["a"],
      elements: { a: { type: "Stack", children: ["c"] }, c: { type: "Text" } },
    },
  });
  expect(rowKeys(host)).toEqual(["a", "c"]);
  expect(selectedKeys(host)).toEqual([]);
  expect(changes).toEqual([{ path: "/ui/nodes/value", value: "b" }]);
  await unmount();
});

test("a string root renders its rows", async () => {
  const { host, unmount } = await mount({ id: "nodes", nodes: { ...nodes, root: "a" } });
  expect(rowKeys(host)).toEqual(["a", "b", "c"]);
  await unmount();
});

test("a diamond renders the shared key twice and selects both occurrences", async () => {
  const diamond = {
    root: "a",
    elements: {
      a: { type: "Stack", children: ["b", "c"] },
      b: { type: "Stack", children: ["d"] },
      c: { type: "Stack", children: ["d"] },
      d: { type: "Text" },
    },
  };
  const { host, changes, unmount } = await mount({ id: "nodes", nodes: diamond });
  expect(rowKeys(host)).toEqual(["a", "b", "d", "c", "d"]);

  await act(async () => rows(host)[2]?.click());
  expect(changes).toEqual([{ path: "/ui/nodes/value", value: "d" }]);
  expect(selectedKeys(host)).toEqual(["d", "d"]);
  await unmount();
});

test("the chevron collapses and re-expands a branch, outside the Tab order", async () => {
  const { host, unmount } = await mount({ id: "nodes", nodes });
  const collapse = host.querySelector<HTMLButtonElement>('button[aria-label="Collapse"]');
  expect(collapse?.getAttribute("aria-expanded")).toBe("true");
  expect(collapse?.tabIndex).toBe(-1);
  await act(async () => collapse?.click());
  expect(rowKeys(host)).toEqual(["a", "d"]);

  const expand = host.querySelector<HTMLButtonElement>('button[aria-label="Expand"]');
  expect(expand?.getAttribute("aria-expanded")).toBe("false");
  await act(async () => expand?.click());
  expect(rowKeys(host)).toEqual(["a", "b", "c", "d"]);
  await unmount();
});

test("ArrowLeft collapses and ArrowRight expands the focused row", async () => {
  const { host, changes, unmount } = await mount({ id: "nodes", nodes });
  const a = rows(host)[0];
  a?.focus();
  await press(a as HTMLElement, "ArrowLeft");
  expect(rowKeys(host)).toEqual(["a", "d"]);
  await press(rows(host)[0] as HTMLElement, "ArrowLeft");
  expect(rowKeys(host)).toEqual(["a", "d"]);

  await press(rows(host)[0] as HTMLElement, "ArrowRight");
  expect(rowKeys(host)).toEqual(["a", "b", "c", "d"]);
  await press(rows(host)[0] as HTMLElement, "ArrowRight");
  expect(rowKeys(host)).toEqual(["a", "b", "c", "d"]);

  // A leaf ignores both keys; arrows never write a selection.
  await press(rows(host)[1] as HTMLElement, "ArrowLeft");
  expect(rowKeys(host)).toEqual(["a", "b", "c", "d"]);
  expect(changes).toEqual([]);
  await unmount();
});

test("a doc past the row cap renders the first rows plus a notice, and rows still select", async () => {
  const root = Array.from({ length: TREE_MAX_ROWS + 1 }, (_, i) => `k${i}`);
  const elements = Object.fromEntries(root.map((key) => [key, { type: "Text" }]));
  const { host, changes, unmount } = await mount({ id: "nodes", nodes: { root, elements } });
  expect(rows(host).length).toBe(TREE_MAX_ROWS);

  const notice = host.querySelector('li[data-slot="tree-truncated"]');
  expect(notice?.textContent).toBe(`Showing the first ${TREE_MAX_ROWS.toLocaleString()} rows`);
  expect(notice?.querySelector("button")).toBeNull();

  await act(async () => rows(host)[7]?.click());
  expect(changes).toEqual([{ path: "/ui/nodes/value", value: "k7" }]);
  expect(selectedKeys(host)).toEqual(["k7"]);
  await unmount();
});

test("a branch past the depth cap keeps a disabled chevron and shows no footer", async () => {
  const length = TREE_MAX_DEPTH + 8;
  const deep: Record<string, { type: string; children?: string[] }> = {};
  for (let i = 0; i < length; i++) {
    deep[`n${i}`] = { type: "Stack", children: i + 1 < length ? [`n${i + 1}`] : undefined };
  }
  const { host, changes, unmount } = await mount({
    id: "nodes",
    nodes: { root: "n0", elements: deep },
  });
  expect(rows(host).length).toBe(TREE_MAX_DEPTH + 1);
  expect(host.querySelector('li[data-slot="tree-truncated"]')).toBeNull();

  const last = rows(host).at(-1) as HTMLButtonElement;
  const chevron = last.parentElement?.querySelector<HTMLButtonElement>("button[aria-expanded]");
  expect(chevron?.disabled).toBe(true);
  expect(chevron?.getAttribute("aria-expanded")).toBe("false");
  expect(chevron?.getAttribute("title")).toBe("Depth limit reached");
  const first =
    rows(host)[0]?.parentElement?.querySelector<HTMLButtonElement>("button[aria-expanded]");
  expect(first?.disabled).toBe(false);
  expect(first?.hasAttribute("title")).toBe(false);

  await press(last, "ArrowRight");
  expect(rows(host).length).toBe(TREE_MAX_DEPTH + 1);

  await act(async () => last.click());
  expect(changes).toEqual([{ path: "/ui/nodes/value", value: `n${TREE_MAX_DEPTH}` }]);
  expect(selectedKeys(host)).toEqual([`n${TREE_MAX_DEPTH}`]);
  await unmount();
});

test("a normal doc renders no truncation notice", async () => {
  const { host, unmount } = await mount({ id: "nodes", nodes });
  expect(host.querySelector('li[data-slot="tree-truncated"]')).toBeNull();
  await unmount();
});

test("leaf rows have no chevron", async () => {
  const { host, unmount } = await mount({ id: "nodes", nodes });
  expect(host.querySelectorAll('button[aria-label="Collapse"]').length).toBe(1);
  await unmount();
});

test("a malformed nodes value renders the empty state", async () => {
  for (const bad of [undefined, null, "doc", ["a"], { root: 1 }, { root: [], elements: {} }]) {
    const { host, unmount } = await mount({ id: "nodes", nodes: bad });
    expect(rows(host)).toEqual([]);
    expect(host.textContent).toContain("No nodes to display.");
    await unmount();
  }
});

test("label renders and names the row list", async () => {
  const { host, unmount } = await mount({ id: "nodes", nodes, label: "Outline" });
  const label = host.querySelector("label");
  expect(label?.textContent).toBe("Outline");
  const list = host.querySelector("ul");
  expect(label?.id).toBeTruthy();
  expect(list?.getAttribute("aria-labelledby")).toBe(label?.id);
  await unmount();
});

test("without a label the list carries no dangling aria-labelledby", async () => {
  const { host, unmount } = await mount({ id: "nodes", nodes });
  expect(host.querySelector("label")).toBeNull();
  expect(host.querySelector("ul")?.hasAttribute("aria-labelledby")).toBe(false);
  await unmount();
});

test("maxHeight bounds the scroll box unless fill is set", async () => {
  const fixed = await mount({ id: "nodes", nodes, maxHeight: "200px" });
  const fixedBox = fixed.host.querySelector<HTMLElement>("ul")?.parentElement;
  expect(fixedBox?.style.maxHeight).toBe("200px");
  await fixed.unmount();

  const filled = await mount({ id: "nodes", nodes, maxHeight: "200px", fill: true });
  const filledBox = filled.host.querySelector<HTMLElement>("ul")?.parentElement;
  expect(filledBox?.style.maxHeight).toBe("");
  expect(filledBox?.className).toContain("flex-1");
  await filled.unmount();
});
