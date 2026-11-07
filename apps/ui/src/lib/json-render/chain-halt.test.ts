import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { join } from "node:path";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, createElement } from "react";

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
const { StateProvider, VisibilityProvider, ActionProvider, Renderer } = await import(
  "@json-render/react"
);
const { createSwarmActionHandlers } = await import("./swarm-actions");
const { haltChain, installChainHaltGuard, isChainHalt } = await import("./chain-halt");

afterAll(() => {
  GlobalRegistrator.unregister();
});

let container: HTMLElement;
let root: ReturnType<typeof createRoot>;
let toasts: string[];
let failures: string[];
let banner: (string | null)[];
let pressError: unknown;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  toasts = [];
  failures = [];
  banner = [];
  pressError = undefined;
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  container.remove();
});

/** A button that runs its `on.press` chain through json-render's own `emit`. */
const registry = {
  Btn: ({ emit }: { emit: (event: string) => unknown }) =>
    createElement(
      "button",
      {
        type: "button",
        "data-testid": "press",
        onClick: () => {
          Promise.resolve(emit("press")).catch((error: unknown) => {
            pressError = error;
          });
        },
      },
      "Go",
    ),
};

function fetchReturning(status: number): typeof fetch {
  return (async () => new Response(JSON.stringify({ ok: status < 400 }), { status })) as never;
}

async function pressChain(first: Record<string, unknown>, fetchImpl: typeof fetch) {
  const handlers = {
    ...createSwarmActionHandlers({
      fetchImpl,
      onResponse: () => {},
      onError: (message) => banner.push(message),
      onFailure: (message) => failures.push(message),
    }),
    // Mirrors the app runtime's `app.action`: a failed script action halts.
    "app.action": async (params: Record<string, unknown> | undefined) => {
      if (params?.name === "broken") haltChain("action broken failed", (m) => failures.push(m));
    },
    "ui.toast": async (params: Record<string, unknown> | undefined) => {
      toasts.push(String(params?.message));
    },
  };
  const spec = {
    root: "go",
    elements: {
      go: {
        type: "Btn",
        props: {},
        on: { press: [first, { action: "ui.toast", params: { message: "Saved" } }] },
      },
    },
  };
  await act(async () => {
    root.render(
      createElement(
        StateProvider,
        { initialState: {} },
        createElement(
          VisibilityProvider,
          null,
          createElement(
            ActionProvider,
            { handlers: handlers as never },
            createElement(Renderer, { spec: spec as never, registry: registry as never }),
          ),
        ),
      ),
    );
  });
  await act(async () => {
    container.querySelector<HTMLButtonElement>('[data-testid="press"]')?.click();
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
}

describe("chain halt", () => {
  test("a failed app.action skips the next ui.toast", async () => {
    await pressChain({ action: "app.action", params: { name: "broken" } }, fetchReturning(200));
    expect(toasts).toEqual([]);
    expect(failures).toEqual(["action broken failed"]);
    expect(isChainHalt(pressError)).toBe(true);
  });

  test("a non-2xx swarm.call halts and reports through onFailure, not the banner", async () => {
    const call = { action: "swarm.call", params: { method: "POST", endpoint: "/api/x" } };
    await pressChain(call, fetchReturning(500));
    expect(toasts).toEqual([]);
    expect(failures).toEqual(["swarm.call POST /api/x: 500"]);
    expect(banner).toEqual([null]);
  });

  test("a thrown swarm.call halts", async () => {
    const throwing = (async () => {
      throw new Error("network down");
    }) as never;
    await pressChain(
      { action: "swarm.call", params: { method: "GET", endpoint: "/api/x" } },
      throwing,
    );
    expect(toasts).toEqual([]);
    expect(failures).toEqual(["network down"]);
  });

  test("control: a successful step lets the toast run", async () => {
    await pressChain(
      { action: "swarm.call", params: { method: "GET", endpoint: "/api/x" } },
      fetchReturning(200),
    );
    expect(toasts).toEqual(["Saved"]);
    expect(failures).toEqual([]);
    expect(pressError).toBeUndefined();
  });

  test("onFailure defaults to onError (the pages renderer keeps its banner)", async () => {
    const reported: (string | null)[] = [];
    const { "swarm.call": call } = createSwarmActionHandlers({
      fetchImpl: fetchReturning(404),
      onResponse: () => {},
      onError: (message) => reported.push(message),
    });
    const error = await call({ method: "GET", endpoint: "/api/y" }).catch((e: unknown) => e);
    expect(isChainHalt(error)).toBe(true);
    expect(reported).toEqual([null, "swarm.call GET /api/y: 404"]);
  });
});

describe("installChainHaltGuard", () => {
  function rejection(reason: unknown) {
    const event = new Event("unhandledrejection", { cancelable: true });
    Object.assign(event, { reason });
    return event;
  }

  test("marks only ChainHaltError rejections handled, and uninstalls", () => {
    const uninstall = installChainHaltGuard(window as never);
    const halt = rejection(new (class extends Error {})("other"));
    window.dispatchEvent(halt);
    expect(halt.defaultPrevented).toBe(false);
    let thrown: unknown;
    try {
      haltChain("boom", () => {});
    } catch (e) {
      thrown = e;
    }
    const handled = rejection(thrown);
    window.dispatchEvent(handled);
    expect(handled.defaultPrevented).toBe(true);
    uninstall();
    const after = rejection(thrown);
    window.dispatchEvent(after);
    expect(after.defaultPrevented).toBe(false);
  });
});
