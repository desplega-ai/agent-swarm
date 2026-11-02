import { afterAll, beforeEach, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { ColDef } from "ag-grid-community";
import { act } from "react";

GlobalRegistrator.register();
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const { createRoot } = await import("react-dom/client");

let isMobile = false;
const gridProps: Record<string, unknown>[] = [];

// The grid itself is AG Grid (needs layout); what ListView owns is everything around it.
mock.module("@/lib/utils", () => require("../../lib/utils"));
mock.module("@/components/ui/skeleton", () => require("../ui/skeleton"));
mock.module("@/hooks/use-mobile", () => ({ useIsMobile: () => isMobile }));
mock.module("@/lib/grid-row-click", () => ({ isRowNavigationSuppressed: () => false }));
mock.module("@/components/shared/data-grid", () => ({
  DataGrid: (props: { rowData: { id: string }[] }) => {
    gridProps.push(props as unknown as Record<string, unknown>);
    return (
      <ul data-testid="grid">
        {/* Stands in for the header filter input that lives inside the real grid. */}
        <input data-testid="header-filter" aria-label="Filter" />
        {props.rowData.map((row) => (
          <li key={row.id}>{row.id}</li>
        ))}
      </ul>
    );
  },
}));
mock.module("@/components/shared/mobile-list", () => ({
  MobileList: ({ children }: { children: React.ReactNode }) => (
    <ul data-testid="mobile">{children}</ul>
  ),
  MobileListRow: ({ title }: { title: React.ReactNode }) => <li>{title}</li>,
}));

const { ListView } = await import("./list-view");

beforeEach(() => {
  document.body.innerHTML = "";
  gridProps.length = 0;
  isMobile = false;
});

afterAll(async () => {
  await GlobalRegistrator.unregister();
});

async function mount(node: React.ReactNode) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(node));
  return { host, rerender: (next: React.ReactNode) => act(async () => root.render(next)) };
}

const columnDefs: ColDef<{ id: string }>[] = [
  { colId: "__select", headerName: "", width: 44 },
  { colId: "title", headerName: "Title", flex: 1, minWidth: 200 },
  { colId: "ci", headerName: "CI on head", width: 120 },
  { colId: "hidden", headerName: "Hidden", hide: true },
];

const base = {
  label: "Rows",
  emptyMessage: "No rows",
  rowId: (row: { id: string }) => row.id,
  columnDefs,
};

test("first load renders the table's shape: its header labels over placeholder rows", async () => {
  const { host } = await mount(<ListView {...base} rows={[]} loading skeletonRows={4} />);
  const skeleton = host.querySelector('[data-testid="list-view-skeleton"]')!;
  expect(skeleton.getAttribute("aria-label")).toBe("Loading rows");
  expect(skeleton.textContent).toContain("Title");
  expect(skeleton.textContent).toContain("CI on head");
  expect(skeleton.textContent).not.toContain("Hidden");
  // One header row plus four placeholder rows, three visible columns each.
  const rows = [...skeleton.querySelectorAll("div[style*='grid-template-columns']")];
  expect(rows).toHaveLength(5);
  expect(rows[0]!.querySelectorAll("span")).toHaveLength(3);
  expect(rows[1]!.querySelectorAll("[data-slot='skeleton']")).toHaveLength(3);
  expect(host.querySelector('[data-testid="grid"]')).toBeNull();
});

test("first load on a phone is a stack of card placeholders", async () => {
  isMobile = true;
  const { host } = await mount(
    <ListView {...base} rows={[]} loading mobileRow={() => ({ title: "x" })} skeletonRows={3} />,
  );
  const skeleton = host.querySelector('[data-testid="list-view-skeleton"]')!;
  expect(skeleton.querySelectorAll("[data-slot='skeleton']")).toHaveLength(3);
  expect(skeleton.querySelector("div[style*='grid-template-columns']")).toBeNull();
});

test("a refetch keeps every row, adds the progress bar, and never hands AG Grid the loading overlay", async () => {
  const rows = [{ id: "a" }, { id: "b" }];
  const { host, rerender } = await mount(<ListView {...base} rows={rows} />);
  expect(host.querySelector('[data-testid="list-view-refreshing"]')).toBeNull();

  await rerender(<ListView {...base} rows={rows} loading refreshing />);
  expect([...host.querySelectorAll("li")].map((li) => li.textContent)).toEqual(["a", "b"]);
  const bar = host.querySelector('[data-testid="list-view-refreshing"]')!;
  expect(bar.getAttribute("aria-label")).toBe("Refreshing");
  expect(host.querySelector('[data-testid="list-view-skeleton"]')).toBeNull();
  expect(gridProps.every((props) => props.loading === false)).toBe(true);

  await rerender(<ListView {...base} rows={rows} />);
  expect(host.querySelector('[data-testid="list-view-refreshing"]')).toBeNull();
});

test("loading with rows already in hand is not a first load", async () => {
  const { host } = await mount(<ListView {...base} rows={[{ id: "a" }]} loading />);
  expect(host.querySelector('[data-testid="list-view-skeleton"]')).toBeNull();
  expect(host.querySelectorAll("li")).toHaveLength(1);
});

test("no rows shows the empty node, not the grid", async () => {
  const { host } = await mount(<ListView {...base} rows={[]} empty={<p>Nothing here</p>} />);
  expect(host.textContent).toBe("Nothing here");
});

const phoneRow = (row: { id: string }) => ({ title: row.id });

test("a refetch on a phone list shows the progress bar over the cards", async () => {
  isMobile = true;
  const rows = [{ id: "a" }, { id: "b" }];
  const { host, rerender } = await mount(<ListView {...base} rows={rows} mobileRow={phoneRow} />);
  expect(host.querySelector('[data-testid="list-view-refreshing"]')).toBeNull();

  await rerender(<ListView {...base} rows={rows} mobileRow={phoneRow} refreshing />);
  const bar = host.querySelector('[data-testid="list-view-refreshing"]')!;
  expect(bar.getAttribute("aria-label")).toBe("Refreshing");
  expect([...host.querySelectorAll("li")].map((li) => li.textContent)).toEqual(["a", "b"]);

  await rerender(<ListView {...base} rows={rows} mobileRow={phoneRow} />);
  expect(host.querySelector('[data-testid="list-view-refreshing"]')).toBeNull();
});

test("a refetch over an empty result still shows the bar next to the empty node", async () => {
  const { host } = await mount(
    <ListView {...base} rows={[]} empty={<p>Nothing here</p>} refreshing />,
  );
  expect(host.querySelector('[data-testid="list-view-refreshing"]')).not.toBeNull();
  expect(host.textContent).toContain("Nothing here");
});

test("keepGridWhenEmpty keeps the same grid, and the input being typed in, through zero matches", async () => {
  const rows = [{ id: "a" }, { id: "b" }];
  const hint = <p>2 rows are hidden</p>;
  const { host, rerender } = await mount(
    <ListView {...base} rows={rows} empty={hint} keepGridWhenEmpty />,
  );
  const input = host.querySelector<HTMLInputElement>('[data-testid="header-filter"]')!;
  input.focus();
  expect(document.activeElement).toBe(input);

  await rerender(<ListView {...base} rows={[]} empty={hint} keepGridWhenEmpty />);
  expect(host.querySelector('[data-testid="header-filter"]')).toBe(input);
  expect(document.activeElement).toBe(input);
  expect(host.textContent).toContain("2 rows are hidden");

  await rerender(<ListView {...base} rows={rows} empty={hint} keepGridWhenEmpty />);
  expect(host.querySelector('[data-testid="header-filter"]')).toBe(input);
  expect(host.textContent).not.toContain("hidden");
});

test("without keepGridWhenEmpty, zero rows still replaces the grid", async () => {
  const { host } = await mount(<ListView {...base} rows={[]} empty={<p>Nothing here</p>} />);
  expect(host.querySelector('[data-testid="grid"]')).toBeNull();
});

test("on a phone list keepGridWhenEmpty does not apply: the empty node replaces the cards", async () => {
  isMobile = true;
  const { host } = await mount(
    <ListView
      {...base}
      rows={[]}
      mobileRow={phoneRow}
      empty={<p>Nothing here</p>}
      keepGridWhenEmpty
    />,
  );
  expect(host.querySelector('[data-testid="grid"]')).toBeNull();
  expect(host.textContent).toBe("Nothing here");
});
