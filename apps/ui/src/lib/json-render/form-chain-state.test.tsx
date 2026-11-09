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
const { OUTCOME_PARAM } = await import("./assemble");

afterAll(() => {
  GlobalRegistrator.unregister();
});

/** Renders a Form whose submit runs `onSubmit` through `handlers`, and submits it. */
async function submitForm(
  onSubmit: unknown[],
  handlers: Record<string, (params: Record<string, unknown>) => Promise<void>>,
  store: ReturnType<typeof createStateStore>,
): Promise<void> {
  const Form = swarmComponents.Form as (input: { props: unknown }) => React.ReactNode;
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <QueryClientProvider client={new QueryClient()}>
        <StateProvider store={store}>
          <ActionProvider handlers={handlers}>
            <Form props={{ id: "newProject", fields: [], onSubmit }} />
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
  await act(async () => {
    root.unmount();
  });
  container.remove();
}

const sessionStep = {
  action: "send",
  params: { session: { key: { $chain: "createdRowId" } } },
};

test("$chain.createdRowId carries the row a create step made to later steps", async () => {
  const store = createStateStore({});
  const seen: unknown[] = [];
  await submitForm(
    [{ action: "app.mutate", params: { model: "project", op: "create" } }, sessionStep],
    {
      // Stands in for the app runtime's `app.mutate`: a create reports the
      // new row's id to the outcome slot the Form names.
      "app.mutate": async (params) => {
        expect(params.formId).toBe("newProject");
        store.set(String(params[OUTCOME_PARAM]), { status: "ok", rowId: "row-1" });
      },
      send: async (params) => {
        seen.push(params);
      },
    },
    store,
  );
  expect(seen).toEqual([{ session: { key: "row-1" } }]);
});

test("with no create before it, the $chain key is dropped (the app.action guard rejects it)", async () => {
  const store = createStateStore({});
  const seen: unknown[] = [];
  await submitForm(
    [sessionStep],
    {
      send: async (params) => {
        seen.push(params);
      },
    },
    store,
  );
  expect(seen).toEqual([{ session: {} }]);
});
