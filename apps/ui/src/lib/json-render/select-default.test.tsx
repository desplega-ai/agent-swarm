import { afterAll, afterEach, expect, mock, test } from "bun:test";
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
const { StateProvider, useStateStore } = await import("@json-render/react");
const { swarmComponents } = await import("./components");

type Renderable = (arg: { props: unknown }) => ReactNode;
const Select = swarmComponents.Select as Renderable;

let store: ReturnType<typeof useStateStore> | undefined;
function Probe() {
  store = useStateStore();
  return null;
}

const roots: { render(node: ReactNode): void; unmount(): void }[] = [];
afterEach(async () => {
  await act(async () => {
    for (const root of roots.splice(0)) root.unmount();
  });
});
afterAll(async () => {
  await GlobalRegistrator.unregister();
});

/** Mounts a Select and returns a rerender that swaps its props, like a query resolving. */
async function mount(props: Record<string, unknown>) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  roots.push(root);
  const render = (next: Record<string, unknown>) =>
    act(async () =>
      root.render(
        <StateProvider initialState={{}}>
          <Probe />
          <Select props={next} />
        </StateProvider>,
      ),
    );
  await render(props);
  return render;
}

const options = ["alpha", "beta", "gamma"];
const value = (id: string) => store?.get(`/ui/${id}/value`);

test("a defaultValue that arrives after mount (a query loading) seeds once", async () => {
  const rerender = await mount({ id: "late", options });
  expect(value("late")).toBeNull();
  await rerender({ id: "late", options, defaultValue: "beta" });
  expect(value("late")).toBe("beta");
  // Seeds once: a later change of the bound value does not override.
  await rerender({ id: "late", options, defaultValue: "gamma" });
  expect(value("late")).toBe("beta");
});

test("a pick made before the bound defaultValue arrives is kept", async () => {
  const rerender = await mount({ id: "picked", options });
  await act(async () => store?.set("/ui/picked/value", "alpha"));
  await rerender({ id: "picked", options, defaultValue: "beta" });
  expect(value("picked")).toBe("alpha");
});

test("multiple: a late defaultValue seeds a one-entry array", async () => {
  const rerender = await mount({ id: "multi", options, multiple: true });
  expect(value("multi")).toEqual([]);
  await rerender({ id: "multi", options, multiple: true, defaultValue: "gamma" });
  expect(value("multi")).toEqual(["gamma"]);
});

test("a literal defaultValue seeds on mount", async () => {
  await mount({ id: "literal", options, defaultValue: "alpha" });
  expect(value("literal")).toBe("alpha");
});
