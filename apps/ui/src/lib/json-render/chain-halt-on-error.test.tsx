import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
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

// `ui.toast` goes through sonner.
const shown: string[] = [];
let lastUndo: (() => void) | undefined;
const record = (tone: string) => (message: string, opts?: { action?: { onClick: () => void } }) => {
  shown.push(`${tone}: ${message}`);
  lastUndo = opts?.action?.onClick;
};
mock.module("sonner", () => ({
  toast: Object.assign(record("info"), {
    success: record("success"),
    error: record("error"),
    warning: record("warning"),
    info: record("info"),
  }),
  Toaster: () => null,
}));

GlobalRegistrator.register();
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const { createRoot } = await import("react-dom/client");
const { ActionProvider, createStateStore, Renderer, StateProvider, VisibilityProvider } =
  await import("@json-render/react");
const { createSwarmActionHandlers } = await import("./swarm-actions");
const { createToastActionHandler } = await import("./toast-action");
const { CHAIN_ON_ERROR_PARAM, withChainOnError, withChainOnErrorHandlers, isChainHalt } =
  await import("./chain-halt");

afterAll(() => {
  GlobalRegistrator.unregister();
});

let container: HTMLElement;
let root: ReturnType<typeof createRoot>;
let calls: string[];
let pressError: unknown;
let marks: string[];

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  shown.length = 0;
  calls = [];
  pressError = undefined;
  marks = [];
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  container.remove();
});

function fetchReturning(status: number): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    calls.push(String(input));
    return new Response(JSON.stringify({ ok: status < 400 }), { status });
  }) as never;
}

/**
 * A button that runs `on.press` through json-render's own `emit` loop. It
 * catches the rejection itself: bun fails a test on any unhandled rejection,
 * where the browser's `installChainHaltGuard` marks a reported halt handled.
 */
const registry = {
  Btn: ({ emit }: { emit: (event: string) => unknown }) => (
    <button
      type="button"
      onClick={() => {
        Promise.resolve(emit("press")).catch((error: unknown) => {
          pressError = error;
        });
      }}
    >
      Save
    </button>
  ),
  Txt: ({ element }: { element: { props: { text?: unknown } } }) => (
    <p data-testid="err">{String(element.props.text ?? "")}</p>
  ),
};

const failingCall = { action: "swarm.call", params: { method: "POST", endpoint: "/api/x" } };
const savedToast = { action: "ui.toast", params: { message: "Saved", tone: "success" } };

/** The production wiring of both surfaces (app-surface, json-page-renderer). */
async function renderAndPress(chain: unknown[], fetchImpl: typeof fetch) {
  const store = createStateStore({});
  const handlers = withChainOnErrorHandlers(
    {
      ...createSwarmActionHandlers({ fetchImpl, onResponse: () => {}, onError: () => {} }),
      ...createToastActionHandler({ getHandlers: () => null, onError: () => {} }),
      // A step that always succeeds: an `onError.action` target.
      mark: async () => {
        marks.push("onError ran");
      },
    } as Record<string, (params: Record<string, unknown>) => Promise<void>>,
    { set: (path, value) => store.set(path, value) },
  );
  const spec = withChainOnError({
    root: "stack",
    elements: {
      stack: { type: "Txt", props: { text: { $state: "/err" } }, children: [] },
      save: { type: "Btn", props: {}, on: { press: chain } },
    },
  });
  await act(async () => {
    root.render(
      <StateProvider store={store}>
        <VisibilityProvider>
          <ActionProvider handlers={handlers}>
            <Renderer spec={spec as never} registry={registry as never} />
            <Renderer spec={{ ...spec, root: "save" } as never} registry={registry as never} />
          </ActionProvider>
        </VisibilityProvider>
      </StateProvider>,
    );
  });
  await act(async () => {
    container.querySelector("button")?.click();
    await new Promise((resolve) => setTimeout(resolve, 30));
  });
}

const errText = () => container.querySelector('[data-testid="err"]')?.textContent ?? "";

describe("onError does not suppress the chain halt (real Renderer)", () => {
  test("a failed swarm.call with onError.set skips the next Saved toast", async () => {
    await renderAndPress(
      [{ ...failingCall, onError: { set: { "/err": "$error.message" } } }, savedToast],
      fetchReturning(500),
    );
    expect(shown).not.toContain("success: Saved");
    expect(isChainHalt(pressError)).toBe(true);
    // onError still ran: `$error.message` landed in state.
    expect(errText()).toBe("swarm.call POST /api/x: 500");
  });

  test("a failed swarm.call with a succeeding onError.action runs it, then halts", async () => {
    await renderAndPress(
      [{ ...failingCall, onError: { action: "mark" } }, savedToast],
      fetchReturning(500),
    );
    expect(marks).toEqual(["onError ran"]);
    expect(shown).not.toContain("success: Saved");
    expect(calls).toHaveLength(1);
    expect(isChainHalt(pressError)).toBe(true);
  });

  test("control: a successful step with onError lets the toast run", async () => {
    await renderAndPress(
      [{ ...failingCall, onError: { set: { "/err": "$error.message" } } }, savedToast],
      fetchReturning(200),
    );
    expect(shown).toContain("success: Saved");
    expect(errText()).toBe("");
    expect(pressError).toBeUndefined();
  });
});

describe("withChainOnError", () => {
  test("moves onError into params everywhere a chain can live", () => {
    const onError = { set: { "/err": "$error.message" } };
    const spec = {
      root: "t",
      elements: {
        t: {
          type: "Table",
          props: {
            rowActions: [{ label: "Go", actions: [{ action: "app.action", onError }] }],
          },
          on: {
            press: [
              { action: "swarm.call", params: { endpoint: "/a" }, onError },
              {
                action: "ui.toast",
                params: {
                  message: "Saved",
                  undo: { actions: [{ action: "app.mutate", onError }] },
                },
              },
            ],
          },
        },
      },
    };
    const out = withChainOnError(spec);
    const t = out.elements.t as unknown as {
      props: { rowActions: { actions: Record<string, unknown>[] }[] };
      on: {
        press: {
          params: Record<string, unknown> & { undo?: { actions: Record<string, unknown>[] } };
        }[];
      };
    };
    expect(t.props.rowActions[0]?.actions[0]).toEqual({
      action: "app.action",
      params: { [CHAIN_ON_ERROR_PARAM]: onError },
    });
    expect(t.on.press[0]).toEqual({
      action: "swarm.call",
      params: { endpoint: "/a", [CHAIN_ON_ERROR_PARAM]: onError },
    });
    expect(t.on.press[1]?.params.undo?.actions[0]).toEqual({
      action: "app.mutate",
      params: { [CHAIN_ON_ERROR_PARAM]: onError },
    });
    // Input untouched, output identity-stable.
    expect("onError" in spec.elements.t.on.press[0]).toBe(true);
    expect(withChainOnError(spec)).toBe(out);
  });

  test("a spec without onError comes back as the same object", () => {
    const spec = { root: "a", elements: { a: { type: "Text", props: { text: "x" } } } };
    expect(withChainOnError(spec)).toBe(spec);
  });
});

describe("withChainOnErrorHandlers", () => {
  test("a non-halting throw with onError still halts, after onError ran", async () => {
    const writes: [string, unknown][] = [];
    const wrapped = withChainOnErrorHandlers(
      {
        boom: async () => {
          throw new Error("kaput");
        },
      },
      { set: (path, value) => writes.push([path, value]) },
    );
    const error = await Promise.resolve(
      wrapped.boom({
        [CHAIN_ON_ERROR_PARAM]: { set: { "/err": "$error.message", "/busy": false } },
      }),
    ).catch((e: unknown) => e);
    expect(isChainHalt(error)).toBe(true);
    expect(writes).toEqual([
      ["/err", "kaput"],
      ["/busy", false],
    ]);
  });

  test("the reserved param never reaches the handler; no onError passes through unchanged", async () => {
    const seen: unknown[] = [];
    const wrapped = withChainOnErrorHandlers(
      {
        ok: async (params: Record<string, unknown>) => {
          seen.push(params);
        },
        boom: async () => {
          throw new Error("plain");
        },
      },
      { set: () => {} },
    );
    await wrapped.ok({ a: 1, [CHAIN_ON_ERROR_PARAM]: { set: {} } });
    expect(seen).toEqual([{ a: 1 }]);
    const error = await Promise.resolve(wrapped.boom({ a: 1 })).catch((e: unknown) => e);
    expect(isChainHalt(error)).toBe(false);
    expect((error as Error).message).toBe("plain");
  });
});

describe("ui.toast Undo", () => {
  test("a halted undo step with onError is not reported a second time", async () => {
    const banner: string[] = [];
    const writes: [string, unknown][] = [];
    let handlers: Record<string, (params: Record<string, unknown>) => Promise<void>> = {};
    const toastHandler = createToastActionHandler({
      getHandlers: () => handlers,
      onError: (message) => banner.push(message),
    });
    handlers = withChainOnErrorHandlers(
      {
        ...createSwarmActionHandlers({
          fetchImpl: fetchReturning(500),
          onResponse: () => {},
          onError: () => {},
        }),
        ...toastHandler,
      } as typeof handlers,
      { set: (path, value) => writes.push([path, value]) },
    );
    const spec = withChainOnError({
      root: "a",
      elements: {
        a: {
          type: "Btn",
          props: {},
          on: {
            press: {
              action: "ui.toast",
              params: {
                message: "Deleted",
                undo: {
                  actions: [{ ...failingCall, onError: { set: { "/err": "$error.message" } } }],
                },
              },
            },
          },
        },
      },
    });
    const binding = (spec.elements.a.on.press as { params: Record<string, unknown> }).params;
    await handlers["ui.toast"]?.(binding);
    lastUndo?.();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(writes).toEqual([["/err", "swarm.call POST /api/x: 500"]]);
    expect(banner).toEqual([]);
  });
});
