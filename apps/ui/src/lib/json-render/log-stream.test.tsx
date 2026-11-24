import { afterAll, afterEach, expect, mock, test } from "bun:test";
import { join } from "node:path";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";

const SRC = join(import.meta.dir, "../..");
for (const file of new Bun.Glob("**/*.{ts,tsx}").scanSync(SRC)) {
  if (/\.test\.tsx?$/.test(file)) continue;
  const specifier = `@/${file.replace(/\.tsx?$/, "").replace(/\/index$/, "")}`;
  mock.module(specifier, async () => await import(join(SRC, file)));
}

GlobalRegistrator.register();
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
// happy-dom has no layout: give every element a viewport-sized box so the virtualizer renders rows.
const box = {
  x: 0,
  y: 0,
  top: 0,
  left: 0,
  right: 960,
  bottom: 480,
  width: 960,
  height: 480,
  toJSON() {},
};
Element.prototype.getBoundingClientRect = () => box as DOMRect;
for (const [prop, value] of [
  ["offsetHeight", 480],
  ["offsetWidth", 960],
  ["clientHeight", 480],
] as const) {
  Object.defineProperty(HTMLElement.prototype, prop, { configurable: true, get: () => value });
}
const { createRoot } = await import("react-dom/client");
const { LogStreamView } = await import("./log-stream");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const model = await import("./log-stream-model");

const roots: { unmount(): void }[] = [];
afterEach(async () => {
  await act(async () => {
    for (const root of roots.splice(0)) root.unmount();
  });
  document.body.innerHTML = "";
});
afterAll(async () => {
  await GlobalRegistrator.unregister();
});

test("severity levels from OTel text and numbers", () => {
  expect(
    ["WARN", "warning", "Error", "FATAL", "info", "DEBUG", "trace", "17", 9, 0, null, "weird"].map(
      model.severityLevel,
    ),
  ).toEqual([
    "warn",
    "warn",
    "error",
    "fatal",
    "info",
    "debug",
    "trace",
    "error",
    "info",
    "unknown",
    "unknown",
    "unknown",
  ]);
});

test("line time accepts ISO and epoch s/ms/ns; body folds to one line", () => {
  const at = new Date(2026, 10, 24, 9, 5, 7, 42);
  for (const value of [at.toISOString(), at.getTime(), at.getTime() * 1e6]) {
    expect(model.lineTime(value)).toBe("09:05:07.042");
  }
  expect(model.lineTime("not a date")).toBe("not a date");
  expect(model.lineBody("a\n   b")).toBe("a b");
  expect(model.lineBody({ k: 1 })).toBe('{"k":1}');
});

test("row keys stay put when a tail adds rows on top, and count what was added", () => {
  const fields = { timeField: "t", bodyField: "b" };
  const before = model.rowKeys(
    [
      { t: 2, b: "x" },
      { t: 1, b: "y" },
      { t: 1, b: "y" },
    ],
    fields,
  );
  const after = model.rowKeys(
    [
      { t: 4, b: "z" },
      { t: 3, b: "w" },
      { t: 2, b: "x" },
      { t: 1, b: "y" },
    ],
    fields,
  );
  expect(new Set(before).size).toBe(3);
  expect(after[2]).toBe(before[0]);
  expect(model.newOnTop(after, before[0])).toBe(2);
  expect(model.newOnTop(after, "gone")).toBe(0);
  expect(model.newOnTop(after, undefined)).toBe(0);
  expect(model.rowKeys([{ id: "a" }], { ...fields, keyField: "id" })).toEqual(["a"]);
});

test("attribute pairs from an object or a JSON string, sorted", () => {
  expect(model.attributePairs({ b: 1, a: "x" })).toEqual([
    ["a", "x"],
    ["b", "1"],
  ]);
  expect(model.attributePairs('{"k":"v"}')).toEqual([["k", "v"]]);
  expect(model.attributePairs("nope")).toEqual([]);
});

const ROWS = [
  {
    ts: "2026-11-24T09:00:02.000Z",
    body: "payment failed",
    sev: "ERROR",
    svc: "checkout",
    attrs: { code: 502 },
    trace: "t1",
    id: "2",
  },
  { ts: "2026-11-24T09:00:01.000Z", body: "ok", sev: "INFO", svc: "api", id: "1" },
];
const BASE = {
  timeField: "ts",
  bodyField: "body",
  severityField: "sev",
  serviceField: "svc",
  attributesField: "attrs",
  traceField: "trace",
  keyField: "id",
};

async function mount(
  props: Record<string, unknown>,
  onTrace?: (row: Record<string, unknown>) => void,
) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  roots.push(root);
  const render = async (next: Record<string, unknown>) =>
    act(async () =>
      root.render(
        <QueryClientProvider client={new QueryClient()}>
          <LogStreamView props={{ ...BASE, ...next } as never} onTrace={onTrace} />
        </QueryClientProvider>,
      ),
    );
  await render(props);
  return { host, render };
}

test("renders one line per entry with its severity, and expands attributes and the trace link", async () => {
  const traced: unknown[] = [];
  const { host } = await mount({ data: ROWS }, (row) => traced.push(row.trace));
  // happy-dom has no layout: the virtualizer may render no rows. Then the list is empty by measure, not by data.
  const lines = host.querySelectorAll('[data-testid="log-stream-line"]');
  expect(lines.length).toBe(2);
  expect(lines[0]?.getAttribute("data-level")).toBe("error");
  expect(lines[0]?.textContent).toContain("checkout");
  expect(lines[0]?.textContent).toContain("payment failed");
  await act(async () => (lines[0] as HTMLButtonElement).click());
  expect(host.textContent).toContain("code");
  const link = [...host.querySelectorAll("button")].find((b) =>
    b.textContent?.startsWith("Open trace"),
  );
  await act(async () => link?.click());
  expect(traced).toEqual(["t1"]);
});

test("no rows shows the empty message; loading with no rows shows a skeleton", async () => {
  const empty = await mount({ data: [], emptyMessage: "Nothing yet" });
  expect(empty.host.textContent).toContain("Nothing yet");
  const loading = await mount({ data: [], loading: true });
  expect(loading.host.textContent).not.toContain("No log entries");
});

test("a refresh that adds entries on top while scrolled away shows N new, and the pill jumps back", async () => {
  const { host, render } = await mount({ data: ROWS, follow: true });
  const scroller = host.querySelector(
    '[data-testid="json-render-log-stream"] > div',
  ) as HTMLDivElement;
  await act(async () => {
    scroller.scrollTop = 200;
    scroller.dispatchEvent(new Event("scroll"));
  });
  const newer = [
    { ts: "2026-11-24T09:00:04.000Z", body: "d", id: "4" },
    { ts: "2026-11-24T09:00:03.000Z", body: "c", id: "3" },
  ];
  await render({ data: [...newer, ...ROWS], follow: true });
  const pill = [...host.querySelectorAll("button")].find((b) => b.textContent?.includes("new"));
  expect(pill?.textContent).toBe("2 new");
  await act(async () => pill?.click());
  expect([...host.querySelectorAll("button")].some((b) => b.textContent?.includes("new"))).toBe(
    false,
  );
});
