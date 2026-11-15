import { afterAll, afterEach, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, type ReactNode } from "react";

GlobalRegistrator.register();
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
afterAll(async () => GlobalRegistrator.unregister());

// Excalidraw and AG Grid are mocked; React, the views and useObject are real.
type Props = Record<string, any>;
let excalProps: Props | null = null;
let gridProps: Props | null = null;
const EXPORTED = ["viewBackgroundColor", "gridSize", "gridStep", "gridModeEnabled"];
const pick = (s: Props) => Object.fromEntries(EXPORTED.filter((k) => k in s).map((k) => [k, s[k]]));
mock.module("@excalidraw/excalidraw", () => ({
  Excalidraw: (p: Props) => {
    excalProps = p;
    return null;
  },
  CaptureUpdateAction: { NEVER: "NEVER" },
  hashElementsVersion: (e: unknown[]) => JSON.stringify(e),
  restoreElements: (e: unknown[]) => e,
  restoreAppState: (a: Props) => ({
    viewBackgroundColor: "#fff",
    gridSize: 20,
    gridStep: 5,
    gridModeEnabled: false,
    ...a,
  }),
  // Like the real "local" export: only the exported appState fields.
  serializeAsJSON: (elements: unknown[], appState: Props, files: unknown) =>
    JSON.stringify({ elements, appState: pick(appState), files }),
}));
mock.module("@excalidraw/excalidraw/index.css", () => ({}));
mock.module("@/components/ui/button", () => ({
  Button: ({ size: _s, variant: _v, ...p }: Props) => <button type="button" {...p} />,
}));
// ObjectEmbed's chrome; the alias resolves only through mocks here.
mock.module("@/components/shared/copy-value-button", () => ({ CopyValueButton: () => null }));
mock.module("@/components/ui/alert-callout", () => ({ AlertCallout: () => null }));
mock.module("@/components/ui/skeleton", () => ({ Skeleton: () => null }));
mock.module("@/components/shared/data-grid", () => ({
  DataGrid: (p: Props) => {
    gridProps = p;
    return null;
  },
}));

const { default: BoardView, AUTOSAVE_MS } = await import("./board-view");
const { default: SheetView } = await import("./sheet-view");
const { useObject } = await import("./use-object");
const { ObjectEmbed } = await import("./object-embed");
const { createRoot } = await import("react-dom/client");

type Root = ReturnType<typeof createRoot>;
const roots: Root[] = [];
afterEach(async () => {
  await act(async () => {
    for (const r of roots.splice(0)) r.unmount();
  });
  document.body.innerHTML = "";
  excalProps = null;
  gridProps = null;
});

async function mount(element: ReactNode) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  roots.push(root);
  await act(async () => root.render(element));
  return { root, host };
}

const object = { id: "obj", kind: "sheet", title: null, fileVersion: 1, link: null };

// ---------- SheetView: a range that names a tab pins it ----------

type Write = { op: string; range: string; values: unknown[][] };
function sheetHarness() {
  const writes: Write[] = [];
  const fetchFn = async (_path: string, init?: RequestInit) => {
    writes.push(JSON.parse(String(init?.body)));
    return Response.json({});
  };
  return { writes, fetchFn, refetch: async () => null };
}
const workbook = (version: number, ...names: string[]) => ({
  object,
  version,
  content: { tabs: names.map((name) => ({ name, cells: { B2: { v: `${name}-B2` } } })) },
});
/** Edit the first data cell (column B of the window's first row) through the grid's setter. */
async function editFirstCell(props: Props | null, value: string) {
  if (!props) throw new Error("no grid rendered");
  const setter = props.columnDefs[1].valueSetter;
  const data = props.rowData[0];
  await act(async () => setter({ data: { ...data }, newValue: value }));
}

test("a range pinned to a missing tab renders no grid and writes nothing", async () => {
  const h = sheetHarness();
  const { host } = await mount(
    <SheetView {...h} snapshot={workbook(1, "Other")} range="Missing!B2:D10" />,
  );
  expect(gridProps).toBeNull();
  expect(host.textContent).toContain("no tab “Missing”");
  expect(h.writes).toEqual([]);
});

test("a data cell paints its text in a truncating span titled with the full text", async () => {
  const h = sheetHarness();
  await mount(<SheetView {...h} snapshot={workbook(1, "Main")} />);
  const CellText = gridProps?.columnDefs[1].cellRenderer;
  const { host } = await mount(<CellText valueFormatted="a long cell value" />);
  const span = host.querySelector("span");
  expect(span?.className).toContain("truncate");
  expect(span?.getAttribute("title")).toBe("a long cell value");
  const empty = await mount(<CellText valueFormatted="" />);
  expect(empty.host.querySelector("span")?.hasAttribute("title")).toBe(false);
});

test("a range that does not parse renders no grid instead of the first tab", async () => {
  const h = sheetHarness();
  const { host } = await mount(<SheetView {...h} snapshot={workbook(1, "Other")} range="Nope!" />);
  expect(gridProps).toBeNull();
  expect(host.textContent).toContain("not a sheet range");
});

test("a poll that removes the pinned tab drops the grid and refuses its late edits", async () => {
  const h = sheetHarness();
  const { root } = await mount(
    <SheetView {...h} snapshot={workbook(1, "Pinned", "Other")} range="Pinned!B2:C3" />,
  );
  const before = gridProps;
  await editFirstCell(before, "1");
  expect(h.writes.map((w) => w.range)).toEqual(["'Pinned'!B2"]);

  gridProps = null;
  await act(async () =>
    root.render(<SheetView {...h} snapshot={workbook(2, "Other")} range="Pinned!B2:C3" />),
  );
  expect(gridProps).toBeNull();
  // An editor from the old grid commits after the poll: nothing goes out.
  await editFirstCell(before, "2");
  expect(h.writes).toHaveLength(1);
});

test("a changed range pins the new tab, and the old grid's edits are refused", async () => {
  const h = sheetHarness();
  const { root, host } = await mount(
    <SheetView {...h} snapshot={workbook(1, "Present", "Other")} range="Present!B2:C3" />,
  );
  const presentGrid = gridProps;
  await act(async () =>
    root.render(
      <SheetView {...h} snapshot={workbook(1, "Present", "Other")} range="Other!B2:C3" />,
    ),
  );
  await editFirstCell(gridProps, "x");
  expect(h.writes.map((w) => w.range)).toEqual(["'Other'!B2"]);
  await editFirstCell(presentGrid, "late");
  expect(h.writes).toHaveLength(1);
  expect(host.textContent).toContain("no longer shown");

  gridProps = null;
  await act(async () =>
    root.render(
      <SheetView {...h} snapshot={workbook(1, "Present", "Other")} range="Missing!B2:C3" />,
    ),
  );
  expect(gridProps).toBeNull();
});

test("control: without a pinned tab, `tab` and clicks pick and a missing pick falls back", async () => {
  const h = sheetHarness();
  const { root, host } = await mount(
    <SheetView {...h} snapshot={workbook(1, "A", "B")} tab="B" range="B2:C3" />,
  );
  await editFirstCell(gridProps, "1");
  await act(async () =>
    root.render(<SheetView {...h} snapshot={workbook(1, "A", "B")} tab="Gone" />),
  );
  const tabA = [...host.querySelectorAll("[role=tab]")].find((b) => b.textContent === "A");
  await act(async () => (tabA as HTMLButtonElement).click());
  await editFirstCell(gridProps, "2");

  const h2 = sheetHarness();
  await mount(<SheetView {...h2} snapshot={workbook(1, "A", "B")} tab="Gone" />);
  await editFirstCell(gridProps, "3");
  expect(h.writes.map((w) => w.range)).toEqual(["'B'!B2", "'A'!A1"]);
  expect(h2.writes.map((w) => w.range)).toEqual(["'A'!A1"]);
});

// ---------- BoardView: board settings are part of the saved scene ----------

type Put = { content: { elements: unknown[]; appState: Props }; ifMatch: number };
function boardHarness(appState: Props) {
  const state = { elements: [] as Props[], appState: { ...appState } };
  const updates: Props[] = [];
  const api = {
    getSceneElements: () => state.elements,
    getAppState: () => state.appState,
    getFiles: () => ({}),
    refresh: () => {},
    addFiles: () => {},
    updateScene: (s: Props) => {
      updates.push(s);
      state.elements = s.elements;
      if (s.appState) state.appState = { ...state.appState, ...s.appState };
    },
  };
  const puts: Put[] = [];
  let nextVersion = 2;
  let latest: Props | null = null;
  const props: {
    fetchFn: (path: string, init?: RequestInit) => Promise<Response>;
    refetch: () => Promise<never>;
    markVersion: (v: number | null) => void;
  } = {
    fetchFn: async (_path: string, init?: RequestInit) => {
      puts.push(JSON.parse(String(init?.body)));
      return Response.json({ version: nextVersion++ });
    },
    refetch: async () => latest as never,
    markVersion: () => {},
  };
  return {
    state,
    api,
    updates,
    puts,
    props,
    setLatest: (s: Props) => {
      latest = s;
    },
  };
}
const board = (version: number, content: Props) => ({
  object: { ...object, kind: "board" },
  version,
  content,
});

/** Fire Excalidraw's onChange and return the autosave callbacks it scheduled. */
async function change(h: ReturnType<typeof boardHarness>) {
  const saves: (() => void)[] = [];
  const real = globalThis.setTimeout;
  globalThis.setTimeout = ((fn: () => void, ms?: number, ...rest: unknown[]) => {
    if (ms === AUTOSAVE_MS) saves.push(fn);
    return real(fn, ms === AUTOSAVE_MS ? 1e9 : ms, ...rest);
  }) as typeof setTimeout;
  try {
    await act(async () => excalProps?.onChange(h.state.elements, h.state.appState));
  } finally {
    globalThis.setTimeout = real;
  }
  return saves;
}
async function runSave(saves: (() => void)[]) {
  const fn = saves.at(-1);
  if (!fn) throw new Error("no autosave scheduled");
  await act(async () => {
    fn();
    await new Promise((r) => setTimeout(r, 0));
  });
}
async function mountBoard(h: ReturnType<typeof boardHarness>, snapshot: Props) {
  const view = await mount(<BoardView {...h.props} snapshot={snapshot as never} />);
  await act(async () => excalProps?.excalidrawAPI(h.api));
  await change(h); // the loaded scene: the baseline
  return view;
}

test("a background-only change autosaves the new background", async () => {
  const h = boardHarness({ viewBackgroundColor: "#fff" });
  await mountBoard(h, board(1, { elements: [], appState: { viewBackgroundColor: "#fff" } }));
  h.state.appState = { ...h.state.appState, viewBackgroundColor: "#f00" };
  await runSave(await change(h));
  expect(h.puts).toHaveLength(1);
  expect(h.puts[0]?.ifMatch).toBe(1);
  expect(h.puts[0]?.content.appState.viewBackgroundColor).toBe("#f00");
});

test("a save that returns after the board unmounted marks no version", async () => {
  const h = boardHarness({ viewBackgroundColor: "#fff" });
  const marked: unknown[] = [];
  let finish!: (r: Response) => void;
  h.props.fetchFn = () => new Promise<Response>((r) => (finish = r));
  h.props.markVersion = (v: unknown) => void marked.push(v);
  const { root } = await mountBoard(
    h,
    board(1, { elements: [], appState: { viewBackgroundColor: "#fff" } }),
  );
  h.state.elements = [{ id: "mine", version: 1 }];
  await runSave(await change(h));
  await act(async () => root.unmount());
  await act(async () => finish(Response.json({ version: 2 })));
  expect(marked).toEqual([]);
});

test("generated iframe HTML is dropped on load and on a polled update", async () => {
  const frame = (v: number) => ({
    id: "f",
    type: "iframe",
    version: v,
    customData: { keep: 1, generationData: { status: "done", html: "<script>x</script>" } },
  });
  const h = boardHarness({ viewBackgroundColor: "#fff" });
  const { root } = await mountBoard(h, board(1, { elements: [frame(1)] }));
  expect(excalProps?.initialData.elements).toEqual([
    { id: "f", type: "iframe", version: 1, customData: { keep: 1 } },
  ]);
  await act(async () =>
    root.render(<BoardView {...h.props} snapshot={board(2, { elements: [frame(2)] }) as never} />),
  );
  expect(h.updates.at(-1)?.elements).toEqual([
    { id: "f", type: "iframe", version: 2, customData: { keep: 1 } },
  ]);
});

test("control: a selection or scroll change schedules no save", async () => {
  const h = boardHarness({ viewBackgroundColor: "#fff" });
  await mountBoard(h, board(1, { elements: [], appState: { viewBackgroundColor: "#fff" } }));
  h.state.appState = { ...h.state.appState, selectedElementIds: { a: true }, scrollX: 40 };
  expect(await change(h)).toEqual([]);
});

test("a clean poll applies the remote background, and the next drawing save keeps it", async () => {
  const h = boardHarness({ viewBackgroundColor: "#fff" });
  const { root } = await mountBoard(
    h,
    board(1, { elements: [], appState: { viewBackgroundColor: "#fff" } }),
  );
  await act(async () =>
    root.render(
      <BoardView
        {...h.props}
        snapshot={board(2, { elements: [], appState: { viewBackgroundColor: "#0f0" } }) as never}
      />,
    ),
  );
  expect(h.updates.at(-1)?.appState?.viewBackgroundColor).toBe("#0f0");
  // The applied scene is the new baseline: its own onChange saves nothing.
  expect(await change(h)).toEqual([]);

  h.state.elements = [{ id: "mine", version: 1 }];
  await runSave(await change(h));
  expect(h.puts[0]?.ifMatch).toBe(2);
  expect(h.puts[0]?.content.appState.viewBackgroundColor).toBe("#0f0");
});

test("a polled scene with no background resets it to the default", async () => {
  const h = boardHarness({ viewBackgroundColor: "#f00" });
  const { root } = await mountBoard(
    h,
    board(1, { elements: [], appState: { viewBackgroundColor: "#f00" } }),
  );
  await act(async () =>
    root.render(<BoardView {...h.props} snapshot={board(2, { elements: [] }) as never} />),
  );
  expect(h.state.appState.viewBackgroundColor).toBe("#fff");
});

test("an unsaved local background meets a remote poll: conflict, then Take theirs applies it", async () => {
  const h = boardHarness({ viewBackgroundColor: "#fff" });
  const { root, host } = await mountBoard(
    h,
    board(1, { elements: [], appState: { viewBackgroundColor: "#fff" } }),
  );
  h.state.appState = { ...h.state.appState, viewBackgroundColor: "#f00" };
  await change(h); // save scheduled, not run yet
  const remote = board(2, { elements: [], appState: { viewBackgroundColor: "#0f0" } });
  await act(async () => root.render(<BoardView {...h.props} snapshot={remote as never} />));
  expect(host.querySelector("[role=alert]")?.textContent).toContain("Someone else changed");
  expect(h.updates).toEqual([]);
  expect(h.state.appState.viewBackgroundColor).toBe("#f00");

  h.setLatest(remote);
  const take = [...host.querySelectorAll("button")].find((b) => b.textContent === "Take theirs");
  await act(async () => (take as HTMLButtonElement).click());
  expect(h.state.appState.viewBackgroundColor).toBe("#0f0");
  expect(host.querySelector("[role=alert]")).toBeNull();
});

// ---------- useObject: only the newest read counts ----------

type Pending = { path: string; signal?: AbortSignal; resolve: (r: Response) => void };
function deferredFetch() {
  const calls: Pending[] = [];
  const fetchFn = (path: string, init?: RequestInit) =>
    new Promise<Response>((resolve) => {
      calls.push({ path, signal: init?.signal ?? undefined, resolve });
    });
  return { calls, fetchFn };
}
const read = (id: string, version: number) =>
  Response.json({
    object: { ...object, id, kind: "board" },
    version,
    unchanged: false,
    content: { elements: [{ id: `${id}-v${version}` }] },
  });

let view: ReturnType<typeof useObject>;
function Probe({
  id,
  fetchFn,
}: {
  id: string;
  fetchFn: (p: string, i?: RequestInit) => Promise<Response>;
}) {
  view = useObject(id, fetchFn);
  return null;
}

test("a read of the previous object that lands after the switch is dropped and aborted", async () => {
  const f = deferredFetch();
  const { root } = await mount(<Probe id="A" fetchFn={f.fetchFn} />);
  await act(async () => root.render(<Probe id="B" fetchFn={f.fetchFn} />));
  const [a, b] = f.calls;
  expect(a?.path).toBe("/api/objects/A");
  expect(a?.signal?.aborted).toBe(true);
  await act(async () => b?.resolve(read("B", 1)));
  await act(async () => a?.resolve(read("A", 1)));
  expect(view.snapshot?.object.id).toBe("B");
  expect(view.error).toBeNull();
});

test("a refetch kept from the previous object reads nothing into the current one", async () => {
  const f = deferredFetch();
  const { root } = await mount(<Probe id="A" fetchFn={f.fetchFn} />);
  await act(async () => f.calls[0]?.resolve(read("A", 1)));
  const refetchA = view.refetch; // e.g. a sheet write on A that lands after the switch
  await act(async () => root.render(<Probe id="B" fetchFn={f.fetchFn} />));
  await act(async () => f.calls[1]?.resolve(read("B", 1)));
  await act(async () => void refetchA());
  await act(async () => f.calls[2]?.resolve(read("A", 2)));
  expect(view.snapshot?.object.id).toBe("B");
});

test("an error from the previous object does not show on the current one", async () => {
  const f = deferredFetch();
  const { root } = await mount(<Probe id="A" fetchFn={f.fetchFn} />);
  await act(async () => root.render(<Probe id="B" fetchFn={f.fetchFn} />));
  const [a, b] = f.calls;
  await act(async () => b?.resolve(read("B", 1)));
  await act(async () => a?.resolve(Response.json({ error: "gone" }, { status: 404 })));
  expect(view.error).toBeNull();
  expect(view.snapshot?.object.id).toBe("B");
});

test("overlapping reads of one object: an older response cannot regress the version", async () => {
  const f = deferredFetch();
  await mount(<Probe id="A" fetchFn={f.fetchFn} />);
  await act(async () => f.calls[0]?.resolve(read("A", 1)));
  let first: Promise<unknown> = Promise.resolve();
  await act(async () => {
    first = view.refetch();
    void view.refetch();
  });
  const [, older, newer] = f.calls;
  await act(async () => newer?.resolve(read("A", 3)));
  await act(async () => older?.resolve(read("A", 2)));
  expect(view.snapshot?.version).toBe(3);
  // The overtaken refetch resolves with what is on screen, not its own body.
  expect(((await first) as { version: number }).version).toBe(3);
});

test("a read sent before this viewer's save cannot bring back the pre-save version", async () => {
  const f = deferredFetch();
  await mount(<Probe id="A" fetchFn={f.fetchFn} />);
  await act(async () => f.calls[0]?.resolve(read("A", 1)));
  await act(async () => void view.refetch());
  // This viewer saves v3 while the read is out; the read then brings v2.
  await act(async () => view.markVersion(3));
  await act(async () => f.calls[1]?.resolve(read("A", 2)));
  expect(view.snapshot?.version).toBe(1);
  expect(view.snapshot?.content).toEqual({ elements: [{ id: "A-v1" }] });
});

// ---------- ObjectEmbed: the read-only hint ----------

test("a read-only embed shows a Read-only label; an editable one does not", async () => {
  const fetchFn = async () => Response.json({ ...workbook(1, "Main"), unchanged: false });
  const locked = await mount(<ObjectEmbed objectId="obj" fetch={fetchFn} readOnly />);
  await act(async () => {});
  expect(locked.host.querySelector("[data-object-readonly]")?.textContent).toBe("Read-only");
  const open = await mount(<ObjectEmbed objectId="obj" fetch={fetchFn} />);
  await act(async () => {});
  expect(open.host.querySelector("[data-object-kind]")).not.toBeNull();
  expect(open.host.querySelector("[data-object-readonly]")).toBeNull();
});
