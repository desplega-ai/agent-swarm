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
  const render = (initialValues: Record<string, unknown>) =>
    act(async () =>
      root.render(
        <QueryClientProvider client={new QueryClient()}>
          <StateProvider store={store}>
            <ActionProvider handlers={{}}>
              <Form props={{ id: "edit", fields, initialValues, onSubmit: [] }} />
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
  await render({ name: "error rate", threshold: 5 });
  expect(store.get("/forms/edit/name")).toBe("error rate");
  await act(async () => root.unmount());
});

test("Form.initialValues: a refresh of another field keeps an unsaved edit", async () => {
  const Form = swarmComponents.Form as Renderable;
  const store = createStateStore({});
  const root = mountRoot();
  const client = new QueryClient();
  const fields = [{ name: "name" }, { name: "threshold", kind: "number" }];
  const render = (initialValues: Record<string, unknown>) =>
    act(async () =>
      root.render(
        <QueryClientProvider client={client}>
          <StateProvider store={store}>
            <ActionProvider handlers={{}}>
              <Form props={{ id: "edit", fields, initialValues, onSubmit: [] }} />
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
    // Another row replaces both edits.
    await render({ name: "error rate", threshold: 5 });
    expect(store.get("/forms/edit/name")).toBe("error rate");
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
