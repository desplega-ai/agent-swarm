import { afterAll, expect, mock, test } from "bun:test";
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
const { ActionProvider, createStateStore, StateProvider } = await import("@json-render/react");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { swarmComponents } = await import("./components");
const { tokenFilter } = await import("@/components/ui/searchable-select");

afterAll(async () => {
  await GlobalRegistrator.unregister();
});

type Renderable = (arg: { props: unknown; emit?: (event: string) => void }) => ReactNode;

function mountRoot() {
  const host = document.createElement("div");
  document.body.append(host);
  return createRoot(host);
}

test("OnEnter emits on mount and again only when deps change by value", async () => {
  const OnEnter = swarmComponents.OnEnter as Renderable;
  const events: string[] = [];
  const emit = (event: string) => events.push(event);
  const root = mountRoot();
  const render = (deps: unknown) =>
    act(async () => root.render(<OnEnter props={{ deps }} emit={emit} />));
  await render({ page: "trace", params: { id: "a" } });
  expect(events).toEqual(["enter"]);
  // A new object with the same content (a poll re-render) does not re-run it.
  await render({ page: "trace", params: { id: "a" } });
  expect(events).toEqual(["enter"]);
  await render({ page: "trace", params: { id: "b" } });
  expect(events).toEqual(["enter", "enter"]);
  await act(async () => root.unmount());
});

test("Form.initialValues prefills its fields and re-seeds when the bound row changes", async () => {
  const Form = swarmComponents.Form as Renderable;
  const store = createStateStore({});
  const root = mountRoot();
  const fields = [
    { name: "name", label: "Name" },
    { name: "threshold", label: "Threshold", kind: "number" },
  ];
  const render = (initialValues: Record<string, unknown>, resetKey = "a") =>
    act(async () =>
      root.render(
        <QueryClientProvider client={new QueryClient()}>
          <StateProvider store={store}>
            <ActionProvider handlers={{}}>
              <Form props={{ id: "edit", fields, initialValues, resetKey, onSubmit: [] }} />
            </ActionProvider>
          </StateProvider>
        </QueryClientProvider>,
      ),
    );
  await render({ name: "p95 latency", threshold: 500, ignored: true });
  expect(store.get("/forms/edit/name")).toBe("p95 latency");
  expect(store.get("/forms/edit/threshold")).toBe(500);
  expect(store.get("/forms/edit/ignored")).toBeUndefined();
  // Typing is kept across re-renders with the same prefill.
  await act(async () => store.set("/forms/edit/name", "typed"));
  await render({ name: "p95 latency", threshold: 500, ignored: true });
  expect(store.get("/forms/edit/name")).toBe("typed");
  // Another row re-seeds.
  await render({ name: "error rate", threshold: 5 }, "b");
  expect(store.get("/forms/edit/name")).toBe("error rate");
  await act(async () => root.unmount());
});

test("Form.initialValues: a same-row refresh keeps unsaved edits", async () => {
  const Form = swarmComponents.Form as Renderable;
  const store = createStateStore({});
  const root = mountRoot();
  const client = new QueryClient();
  const fields = [{ name: "name" }, { name: "threshold", kind: "number" }];
  const render = (initialValues: Record<string, unknown>, resetKey = "a") =>
    act(async () =>
      root.render(
        <QueryClientProvider client={client}>
          <StateProvider store={store}>
            <ActionProvider handlers={{}}>
              <Form props={{ id: "edit", fields, initialValues, resetKey, onSubmit: [] }} />
            </ActionProvider>
          </StateProvider>
        </QueryClientProvider>,
      ),
    );
  try {
    await render({ name: "original", threshold: 500 });
    await act(async () => store.set("/forms/edit/name", "my unsaved edit"));
    // The same row polls back with a new threshold: the edit stays, the
    // untouched threshold follows the row.
    await render({ name: "original", threshold: 501 });
    expect(store.get("/forms/edit/name")).toBe("my unsaved edit");
    expect(store.get("/forms/edit/threshold")).toBe(501);
    // An edited field that the next refresh leaves alone stays edited too.
    await act(async () => store.set("/forms/edit/threshold", 900));
    await render({ name: "original", threshold: 501, extra: 1 });
    expect(store.get("/forms/edit/threshold")).toBe(900);
    expect(store.get("/forms/edit/name")).toBe("my unsaved edit");
    // A refresh through `app.action` clears the bound result while it runs:
    // the empty pass neither blanks the fields nor turns the edit into a re-seed.
    await render({ name: undefined, threshold: undefined });
    expect(store.get("/forms/edit/name")).toBe("my unsaved edit");
    expect(store.get("/forms/edit/threshold")).toBe(900);
    await render({ name: "original", threshold: 501 });
    expect(store.get("/forms/edit/name")).toBe("my unsaved edit");
    expect(store.get("/forms/edit/threshold")).toBe(900);
    // The server changes the edited field itself: the edit still wins.
    await render({ name: "server changed name", threshold: 501 });
    expect(store.get("/forms/edit/name")).toBe("my unsaved edit");
    // Another row replaces both edits.
    await render({ name: "error rate", threshold: 5 }, "b");
    expect(store.get("/forms/edit/name")).toBe("error rate");
    expect(store.get("/forms/edit/threshold")).toBe(5);
  } finally {
    await act(async () => root.unmount());
  }
});

test("Form.resetKey: a row switch drops the edit even when the new row shares the seeded value", async () => {
  const Form = swarmComponents.Form as Renderable;
  const store = createStateStore({});
  const root = mountRoot();
  const client = new QueryClient();
  const fields = [{ name: "name" }, { name: "threshold", kind: "number" }];
  const render = (initialValues: Record<string, unknown>, resetKey: string) =>
    act(async () =>
      root.render(
        <QueryClientProvider client={client}>
          <StateProvider store={store}>
            <ActionProvider handlers={{}}>
              <Form props={{ id: "edit", fields, initialValues, resetKey, onSubmit: [] }} />
            </ActionProvider>
          </StateProvider>
        </QueryClientProvider>,
      ),
    );
  try {
    await render({ name: "original", threshold: 500 }, "a");
    await act(async () => store.set("/forms/edit/name", "my unsaved edit"));
    await render({ name: "original", threshold: 5 }, "b");
    expect(store.get("/forms/edit/name")).toBe("original");
    expect(store.get("/forms/edit/threshold")).toBe(5);
  } finally {
    await act(async () => root.unmount());
  }
});

test("Select search ranks token matches first and keeps fuzzy matches", () => {
  expect(tokenFilter("anything", "")).toBe(1);
  const token = tokenFilter("task timeline", "time");
  const fuzzy = tokenFilter("task timeline", "tmln");
  expect(fuzzy).toBeGreaterThan(0);
  expect(token).toBeGreaterThan(fuzzy);
  expect(tokenFilter("lead worker", "lea worker")).toBeGreaterThan(0.5);
  expect(tokenFilter("traces", "zzqxj")).toBe(0);
});

test("OnEnter.everyMs re-runs the chain on an interval while the tab is visible", async () => {
  const OnEnter = swarmComponents.OnEnter as Renderable;
  const events: string[] = [];
  const root = mountRoot();
  await act(async () =>
    root.render(<OnEnter props={{ everyMs: 1000 }} emit={(event) => events.push(event)} />),
  );
  expect(events).toEqual(["enter"]);
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 1150));
  });
  expect(events).toEqual(["enter", "enter"]);
  await act(async () => root.unmount());
});

test("OnEnter.everyMs starts no timer for a non-numeric or sub-second value", async () => {
  const OnEnter = swarmComponents.OnEnter as Renderable;
  const realSetInterval = globalThis.setInterval;
  const delays: unknown[] = [];
  globalThis.setInterval = ((_fn: () => void, ms?: unknown) => {
    delays.push(ms);
    return 1;
  }) as never;
  const root = mountRoot();
  try {
    for (const everyMs of ["fast", "5000", Number.NaN, Number.POSITIVE_INFINITY, 999, { n: 1 }]) {
      await act(async () => root.render(<OnEnter props={{ everyMs }} emit={() => {}} />));
    }
    expect(delays).toEqual([]);
    await act(async () => root.render(<OnEnter props={{ everyMs: 1000 }} emit={() => {}} />));
    expect(delays).toEqual([1000]);
  } finally {
    await act(async () => root.unmount());
    globalThis.setInterval = realSetInterval;
  }
});

// Each case: which pending runs settle (by start index) before the tick, and
// whether that tick may start a new run.
const tickGateCases: Array<{ name: string; settle: number[]; deps: string[]; ticks: boolean }> = [
  { name: "slow chain still pending", settle: [], deps: ["1h"], ticks: false },
  { name: "slow chain settled", settle: [0], deps: ["1h"], ticks: true },
  {
    name: "older run settles first, newer pending",
    settle: [0],
    deps: ["1h", "24h"],
    ticks: false,
  },
  {
    name: "newer run settles first, older pending",
    settle: [1],
    deps: ["1h", "24h"],
    ticks: false,
  },
  { name: "both runs settled", settle: [1, 0], deps: ["1h", "24h"], ticks: true },
];

for (const c of tickGateCases) {
  test(`OnEnter.everyMs tick gate: ${c.name}`, async () => {
    const OnEnter = swarmComponents.OnEnter as Renderable;
    const root = mountRoot();
    const resolvers: Array<() => void> = [];
    let runs = 0;
    let tick: () => void = () => {};
    const realSetInterval = globalThis.setInterval;
    const realClearInterval = globalThis.clearInterval;
    globalThis.setInterval = ((fn: () => void) => {
      tick = fn;
      return 1;
    }) as never;
    globalThis.clearInterval = (() => {}) as never;
    const emit = () => {
      runs++;
      return new Promise<void>((resolve) => resolvers.push(resolve));
    };
    try {
      for (const deps of c.deps) {
        await act(async () => root.render(<OnEnter props={{ deps, everyMs: 1000 }} emit={emit} />));
      }
      expect(runs).toBe(c.deps.length);
      for (const index of c.settle) await act(async () => resolvers[index]?.());
      await act(async () => tick());
      expect(runs).toBe(c.deps.length + (c.ticks ? 1 : 0));
    } finally {
      await act(async () => {
        for (const resolve of resolvers) resolve();
      });
      await act(async () => root.unmount());
      globalThis.setInterval = realSetInterval;
      globalThis.clearInterval = realClearInterval;
    }
  });
}

test("ui.set writes app-wide /app/<name> state as well as /local", async () => {
  const { isLocalStatePath } = await import("./ui-actions");
  expect(isLocalStatePath("/app/window")).toBe(true);
  expect(isLocalStatePath("/app/__proto__")).toBe(false);
  expect(isLocalStatePath("/apps/x")).toBe(false);
});
