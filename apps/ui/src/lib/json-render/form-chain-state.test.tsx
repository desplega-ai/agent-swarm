import { afterAll, expect, mock, test } from "bun:test";
import { join } from "node:path";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";

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

afterAll(() => {
  GlobalRegistrator.unregister();
});

test("a Form chain step binds state an earlier step of the same submit wrote", async () => {
  const store = createStateStore({});
  const seen: unknown[] = [];
  const handlers = {
    // Stands in for `app.mutate` create, which writes the new row's id.
    create: async () => {
      store.set("/mutations/project/rowId", "row-1");
    },
    send: async (params: Record<string, unknown>) => {
      seen.push(params);
    },
  };
  const Form = swarmComponents.Form as (input: { props: unknown }) => React.ReactNode;
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <QueryClientProvider client={new QueryClient()}>
        <StateProvider store={store}>
          <ActionProvider handlers={handlers}>
            <Form
              props={{
                id: "newProject",
                fields: [],
                onSubmit: [
                  { action: "create" },
                  {
                    action: "send",
                    params: { session: { key: { $state: "/mutations/project/rowId" } } },
                  },
                ],
              }}
            />
          </ActionProvider>
        </StateProvider>
      </QueryClientProvider>,
    );
  });
  const form = container.querySelector("form");
  if (!form) throw new Error("form did not render");
  await act(async () => {
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
  expect(seen).toEqual([{ session: { key: "row-1" } }]);
  await act(async () => {
    root.unmount();
  });
  container.remove();
});
