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
const { createStateStore, defineRegistry, JSONUIProvider, Renderer } = await import(
  "@json-render/react"
);
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { swarmComponents } = await import("./components");
const { swarmCatalog } = await import("./catalog");
const { expressionDirectives, evaluateExpression } = await import("./expressions");
const { resolveScopedValue } = await import("./action-params");
const { createFocusRegistry, createUiActionHandlers, isLocalStatePath } = await import(
  "./ui-actions"
);
const { FocusRegistryProvider } = await import("./primitives");
const { installChainHaltGuard } = await import("./chain-halt");

afterAll(() => {
  GlobalRegistrator.unregister();
});

/** The JSON examples of the apps skill, which these tests render. */
async function skillExample(heading: string) {
  const doc = await Bun.file(
    join(import.meta.dir, "../../../../../templates/skills/apps/content.md"),
  ).text();
  const start = doc.indexOf(`### Example: ${heading}`);
  const block = /```json\n([\s\S]*?)\n```/.exec(doc.slice(start));
  if (start < 0 || !block) throw new Error(`example "${heading}" not found`);
  return JSON.parse(block[1]!) as {
    defaultPage: string;
    pages: Record<string, { root: string; elements: object; state: Record<string, unknown> }>;
  };
}

async function renderPage(heading: string) {
  const definition = await skillExample(heading);
  const page = definition.pages[definition.defaultPage]!;
  const store = createStateStore({ local: structuredClone(page.state) });
  const focus = createFocusRegistry();
  const toasts: unknown[] = [];
  const handlers = {
    ...createUiActionHandlers({ getStore: () => store, focus, onError: (m) => toasts.push(m) }),
    "ui.toast": async (params: unknown) => {
      toasts.push(params);
    },
  };
  const { registry } = defineRegistry(swarmCatalog, { components: swarmComponents } as never);
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <QueryClientProvider client={new QueryClient()}>
        <JSONUIProvider
          registry={registry}
          store={store}
          handlers={handlers}
          directives={expressionDirectives}
        >
          <FocusRegistryProvider value={focus}>
            <Renderer
              spec={{ root: page.root, elements: page.elements } as never}
              registry={registry}
            />
          </FocusRegistryProvider>
        </JSONUIProvider>
      </QueryClientProvider>,
    );
  });
  const cleanup = async () => {
    await act(async () => root.unmount());
    container.remove();
  };
  return { container, store, toasts, cleanup };
}

const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
async function type(input: HTMLInputElement, text: string) {
  await act(async () => {
    valueSetter.call(input, text);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function press(input: HTMLInputElement, key: string) {
  await act(async () => {
    input.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
  });
}
async function paste(input: HTMLInputElement, text: string) {
  await act(async () => {
    const event = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", { value: { getData: () => text } });
    input.dispatchEvent(event);
  });
}

test("expressions: arithmetic, min/max, split/join/length", () => {
  expect(evaluateExpression("$add", [1, 2, "3"])).toBe(6);
  expect(evaluateExpression("$sub", [10, 4])).toBe(6);
  expect(evaluateExpression("$mul", [2, 3, 4])).toBe(24);
  expect(evaluateExpression("$div", [9, 3])).toBe(3);
  expect(evaluateExpression("$div", [1, 0])).toBeUndefined();
  expect(evaluateExpression("$min", [4, 2, 8])).toBe(2);
  expect(evaluateExpression("$max", [4, 2, 8])).toBe(8);
  expect(evaluateExpression("$add", [1, "x"])).toBeUndefined();
  expect(evaluateExpression("$split", ["123456", "", 3])).toEqual(["1", "2", "3"]);
  expect(evaluateExpression("$join", [["a", null, "b"], "-"])).toBe("a--b");
  expect(evaluateExpression("$length", ["abc"])).toBe(3);
  expect(evaluateExpression("$length", [null])).toBe(0);
});

test("an expression over a $chain operand waits for the chain runner", () => {
  const deferred = evaluateExpression("$split", [{ $chain: "text" }, ""]);
  expect(deferred).toEqual({ $split: [{ $chain: "text" }, ""] });
  expect(resolveScopedValue(deferred, { chain: { text: "42" } })).toEqual(["4", "2"]);
  expect(
    resolveScopedValue(
      { $length: [{ $join: [{ $state: "/local/otp" }, ""] }] },
      {
        state: { local: { otp: ["1", "", "3"] } },
      },
    ),
  ).toBe(2);
});

test("ui.set writes only /local paths; ui.when halts on a mismatch", async () => {
  expect(isLocalStatePath("/local/otp/0")).toBe(true);
  expect(isLocalStatePath("/queries/x")).toBe(false);
  expect(isLocalStatePath("/local/__proto__/x")).toBe(false);
  const store = createStateStore({});
  const errors: string[] = [];
  const handlers = createUiActionHandlers({
    getStore: () => store,
    focus: createFocusRegistry(),
    onError: (message) => errors.push(message),
  });
  await handlers["ui.set"]({ path: "/local/code", value: "1" });
  expect(store.get("/local/code")).toBe("1");
  await expect(handlers["ui.set"]({ path: "/queries/x", value: 1 })).rejects.toThrow();
  expect(errors).toHaveLength(1);
  await expect(handlers["ui.when"]({ value: 5, eq: 6 })).rejects.toThrow();
  await handlers["ui.when"]({ value: 6, eq: 6 });
  await handlers["ui.when"]({ value: "x" });
});

test("OTP example: auto-advance, backspace-back, paste-fill, submit at 6", async () => {
  const uninstall = installChainHaltGuard();
  const { container, store, toasts, cleanup } = await renderPage("6-cell code input");
  const cells = () => [...container.querySelectorAll("input")] as HTMLInputElement[];
  expect(cells()).toHaveLength(6);

  await type(cells()[0]!, "4");
  expect(store.get("/local/otp")).toEqual(["4", "", "", "", "", ""]);
  expect(document.activeElement).toBe(cells()[1]!);

  await type(cells()[1]!, "2");
  await press(cells()[1]!, "Backspace");
  expect(store.get("/local/otp/1")).toBe("");
  expect(document.activeElement).toBe(cells()[0]!);
  expect(toasts).toHaveLength(0);

  await paste(cells()[0]!, "123456");
  expect(store.get("/local/otp")).toEqual(["1", "2", "3", "4", "5", "6"]);
  expect(
    cells()
      .map((cell) => cell.value)
      .join(""),
  ).toBe("123456");
  expect(document.activeElement).toBe(cells()[5]!);
  // The watch saw all 6 cells filled and submitted once.
  expect(store.get("/local/code")).toBe("123456");
  expect(toasts).toEqual([{ message: "Code submitted", tone: "success" }]);

  // A partial paste is ignored by the `ui.when` guard.
  await paste(cells()[0]!, "99");
  expect(store.get("/local/otp/0")).toBe("1");
  await cleanup();
  uninstall();
});

test("Gantt example: bars and labels computed from the repeated list", async () => {
  const { container, cleanup } = await renderPage("Gantt timeline");
  const svg = container.querySelector("svg");
  expect(svg?.getAttribute("viewBox")).toBe("0 0 640 200");
  const bars = [...container.querySelectorAll("rect")];
  expect(bars.map((bar) => bar.getAttribute("x"))).toEqual(["100", "172", "268", "412", "508"]);
  expect(bars.map((bar) => bar.getAttribute("width"))).toEqual(["96", "120", "192", "96", "48"]);
  expect(bars.map((bar) => bar.getAttribute("y"))).toEqual(["14", "48", "82", "116", "150"]);
  expect([...container.querySelectorAll("text")].map((text) => text.textContent)).toEqual([
    "Research",
    "Design",
    "Build",
    "QA",
    "Launch",
  ]);
  const today = container.querySelectorAll("line")[1];
  expect(today?.getAttribute("x1")).toBe(String(100 + (12 - 3) * 24));
  await cleanup();
});

test("Path refuses data that is not path commands and numbers", async () => {
  const { PathComponent } = await import("./primitives");
  const container = document.createElement("div");
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <svg aria-label="paths" role="img">
        <PathComponent props={{ d: 'M0 0"/><script>' }} />
        <PathComponent props={{ d: "M0 0 L10 10 Z" }} />
      </svg>,
    );
  });
  expect(container.querySelectorAll("path")).toHaveLength(1);
  await act(async () => root.unmount());
});
