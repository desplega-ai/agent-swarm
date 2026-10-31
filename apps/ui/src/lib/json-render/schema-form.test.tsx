import { afterAll, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";

GlobalRegistrator.register();
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const { createRoot } = await import("react-dom/client");
const { StateProvider, ActionProvider } = await import("@json-render/react");

mock.module("@/components/ui/input", () => require("../../components/ui/input"));
mock.module("@/components/ui/label", () => require("../../components/ui/label"));
mock.module("@/components/ui/settings-row", () => require("../../components/ui/settings-row"));
mock.module("@/components/ui/switch", () => require("../../components/ui/switch"));
mock.module("@/lib/utils", () => require("../../lib/utils"));
// Radix Select is not exercised here (no enum property), so a stub is enough.
mock.module("@/components/ui/select", () => {
  const Stub = ({ children }: { children?: unknown }) => children ?? null;
  return {
    Select: Stub,
    SelectContent: Stub,
    SelectItem: Stub,
    SelectTrigger: Stub,
    SelectValue: Stub,
  };
});

const { SchemaFormComponent } = await import("./schema-form");
type FormProps = Parameters<typeof SchemaFormComponent>[0]["props"];

const schema = {
  properties: { title: { type: "string" }, count: { type: "number" }, on: { type: "boolean" } },
};

const baseDoc = {
  root: "a",
  elements: {
    a: { type: "Text", props: { title: "A" } },
    b: { type: "Text", props: { title: "B" } },
  },
};

beforeEach(() => {
  document.body.innerHTML = "";
});

afterAll(async () => {
  await GlobalRegistrator.unregister();
});

type Change = { path: string; value: unknown };
type Call = Record<string, unknown>;

async function mount(props: Partial<FormProps>, handler?: (params: Call) => Promise<void> | void) {
  const changes: Change[] = [];
  const calls: Call[] = [];
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const render = (next: Partial<FormProps>) =>
    act(async () =>
      root.render(
        <StateProvider initialState={{}} onStateChange={(batch) => changes.push(...batch)}>
          <ActionProvider
            handlers={{
              record: async (params) => {
                calls.push(params as Call);
                await handler?.(params as Call);
              },
            }}
          >
            <SchemaFormComponent
              props={
                {
                  id: "f",
                  schema,
                  onChange: [{ action: "record", params: { v: { $form: "" } } }],
                  ...next,
                } as FormProps
              }
            />
          </ActionProvider>
        </StateProvider>,
      ),
    );
  await render(props);
  return { host, changes, calls, rerender: render, unmount: () => act(async () => root.unmount()) };
}

function input(host: HTMLElement, key: string): HTMLInputElement {
  return host.querySelector<HTMLInputElement>(`#schemaform-f-${key}`)!;
}

async function type(el: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

const blur = (el: HTMLElement) =>
  act(async () => {
    el.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
  });

const last = (changes: Change[]) => changes[changes.length - 1]?.value as Record<string, unknown>;

test("renders one control per schema property", async () => {
  const { host, unmount } = await mount({});
  expect(input(host, "title")?.type).toBe("text");
  expect(input(host, "count")?.type).toBe("number");
  expect(host.querySelector("#schemaform-f-on")?.getAttribute("role")).toBe("switch");
  await unmount();
});

test("an unsafe id renders a notice and no controls", async () => {
  const { host, unmount } = await mount({ id: "../x" });
  expect(host.querySelector("input")).toBeNull();
  expect(host.textContent).toContain("Invalid SchemaForm id");
  await unmount();
});

test("a commit writes the draft to /ui/<id>/value and runs onChange with $form", async () => {
  const { host, changes, calls, unmount } = await mount({});
  await type(input(host, "title"), "hi");
  await blur(input(host, "title"));
  expect(changes.at(-1)?.path).toBe("/ui/f/value");
  expect(last(changes).title).toBe("hi");
  expect(calls).toEqual([{ v: expect.objectContaining({ title: "hi" }) }]);
  await unmount();
});

test("two quick commits on different nodes both survive a stale baseDoc", async () => {
  const { host, changes, rerender, unmount } = await mount({ baseDoc, nodeKey: "a" });
  await type(input(host, "title"), "A2");
  await blur(input(host, "title"));
  await rerender({ baseDoc, nodeKey: "b" });
  await type(input(host, "title"), "B2");
  await blur(input(host, "title"));
  const merged = changes.at(-1)?.value as typeof baseDoc;
  expect(merged.elements.a.props.title).toBe("A2");
  expect(merged.elements.b.props.title).toBe("B2");
  await unmount();
});

test("a failing onChange chain is logged and does not block the next commit", async () => {
  const error = spyOn(console, "error").mockImplementation(() => undefined);
  let n = 0;
  const { host, calls, unmount } = await mount({}, () => {
    if (n++ === 0) throw new Error("boom");
  });
  await type(input(host, "title"), "one");
  await blur(input(host, "title"));
  await type(input(host, "title"), "two");
  await blur(input(host, "title"));
  expect(calls).toHaveLength(2);
  expect(error).toHaveBeenCalled();
  error.mockRestore();
  await unmount();
});
