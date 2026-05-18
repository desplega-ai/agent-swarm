/**
 * Smoke tests for the `<swarm-diff>` custom element shipped inside
 * `SWARM_UI_JS`. Existing browser-side tests in this repo are pure string-
 * content checks against the SDK constant; we don't have happy-dom or jsdom
 * in deps. To still verify the element produces sane DOM output, we evaluate
 * the JS in a hand-rolled stub `window` / `HTMLElement` / `customElements`
 * scaffold — minimal but enough to assert structural properties (row counts,
 * anchor ids, severity badges) without dragging in a real DOM lib.
 */
import { describe, expect, test } from "bun:test";
import { SWARM_UI_JS } from "../artifact-sdk/browser-sdk";

const EXAMPLE_HUNK = {
  hunks: [
    {
      old_start: 10,
      old_lines: 3,
      new_start: 10,
      new_lines: 4,
      lines: [
        { type: "context", text: "  const x = 1;" },
        { type: "del", text: "- console.log(x);" },
        { type: "add", text: "+ logger.info({ x });" },
        { type: "add", text: "+ return x;" },
      ],
      annotations: [{ line: 12, severity: "warn", text: "Avoid raw console.log" }],
    },
  ],
};

type StubInstance = {
  innerHTML: string;
  textContent: string;
  isConnected: boolean;
  connectedCallback?: () => void;
  dispatchEvent: (evt: unknown) => boolean;
};

/**
 * Build a minimal stub window with just enough surface area to load
 * SWARM_UI_JS, register the custom element, and exercise the render path.
 *
 * Returns both the element constructor and a microtask-flush helper so
 * callers can simulate the real-browser parse-order race
 * (`connectedCallback` fires → children get appended → microtask drains).
 */
function makeRig(): {
  Ctor: new () => StubInstance;
  setText: (el: StubInstance, attrs: Record<string, string>, text: string) => void;
  flushMicrotasks: () => Promise<void>;
} {
  const registry = new Map<string, new () => StubInstance>();

  class StubHTMLElement {
    innerHTML = "";
    textContent = "";
    isConnected = true;
    _attrs: Record<string, string> = {};
    getAttribute(name: string): string | null {
      return this._attrs[name] ?? null;
    }
    setAttribute(name: string, value: string): void {
      this._attrs[name] = value;
    }
    connectedCallback?(): void;
    closest(_selector: string): null {
      return null;
    }
    querySelectorAll(_selector: string): unknown[] {
      return [];
    }
    dispatchEvent(_evt: unknown): boolean {
      return true;
    }
  }

  const customElements = {
    define(name: string, ctor: new () => StubInstance) {
      registry.set(name, ctor);
    },
    get(name: string) {
      return registry.get(name);
    },
  };

  const win = {
    customElements,
    swarmUi: undefined as { renderDiff?: (rootEl: unknown, data: unknown) => void } | undefined,
    HTMLElement: StubHTMLElement,
    CustomEvent: class {
      constructor(
        public type: string,
        public init?: { bubbles?: boolean; detail?: unknown },
      ) {}
    },
  };

  // Provide `document` stubs the jump-list path uses.
  const doc = {
    querySelectorAll: () => [],
    addEventListener: () => {},
    removeEventListener: () => {},
  };

  // Evaluate SWARM_UI_JS with our stubs in scope. The IIFE inside the
  // constant captures `window`, `customElements`, `document`, `HTMLElement`,
  // `CustomEvent`, and `queueMicrotask` — provide each as a free variable.
  const factory = new Function(
    "window",
    "customElements",
    "document",
    "HTMLElement",
    "CustomEvent",
    "queueMicrotask",
    "console",
    `${SWARM_UI_JS}\nreturn window.customElements.get('swarm-diff');`,
  );
  const Ctor = factory(
    win,
    customElements,
    doc,
    StubHTMLElement,
    win.CustomEvent,
    queueMicrotask,
    console,
  ) as (new () => StubInstance) | undefined;
  if (!Ctor) throw new Error("custom element did not register");

  return {
    Ctor,
    setText(el, attrs, text) {
      (el as unknown as { _attrs: Record<string, string> })._attrs = attrs;
      el.textContent = text;
    },
    async flushMicrotasks() {
      // Two yields: one drains the connectedCallback microtask, the next one
      // drains anything queued by the render path itself.
      await Promise.resolve();
      await Promise.resolve();
    },
  };
}

/**
 * Convenience wrapper for the existing "happy path" tests: build the rig,
 * pre-set textContent + attrs, fire connectedCallback, flush microtasks,
 * return innerHTML.
 */
async function renderViaStub(text: string, attrs: Record<string, string>): Promise<string> {
  const rig = makeRig();
  const el = new rig.Ctor();
  rig.setText(el, attrs, text);
  if (typeof el.connectedCallback === "function") el.connectedCallback();
  await rig.flushMicrotasks();
  return el.innerHTML;
}

describe("SWARM_UI_JS", () => {
  test("is a non-empty string", () => {
    expect(typeof SWARM_UI_JS).toBe("string");
    expect(SWARM_UI_JS.length).toBeGreaterThan(500);
  });

  test("defines swarm-diff + swarm-diff-jumps custom elements", () => {
    expect(SWARM_UI_JS).toContain("customElements.define('swarm-diff'");
    expect(SWARM_UI_JS).toContain("customElements.define('swarm-diff-jumps'");
  });

  test("exposes window.swarmUi.renderDiff as a programmatic entry point", () => {
    expect(SWARM_UI_JS).toContain("window.swarmUi");
    expect(SWARM_UI_JS).toContain("renderDiff");
  });
});

describe("<swarm-diff> render", () => {
  test("constructs and renders without throwing on the example input", async () => {
    const html = await renderViaStub(JSON.stringify(EXAMPLE_HUNK), {
      file: "src/foo.ts",
      "base-sha": "abc123",
      "head-sha": "def456",
    });
    expect(html.length).toBeGreaterThan(0);
  });

  test("renders one <tr> per line in each hunk", async () => {
    const html = await renderViaStub(JSON.stringify(EXAMPLE_HUNK), { file: "src/foo.ts" });
    // 4 lines in the example hunk → 4 <tr> rows.
    const trMatches = html.match(/<tr\b/g) || [];
    expect(trMatches.length).toBe(4);
  });

  test("renders file header and SHA range", async () => {
    const html = await renderViaStub(JSON.stringify(EXAMPLE_HUNK), {
      file: "src/foo.ts",
      "base-sha": "abc123",
      "head-sha": "def456",
    });
    expect(html).toContain("src/foo.ts");
    expect(html).toContain("abc123");
    expect(html).toContain("def456");
  });

  test("renders deterministic anchor id per hunk", async () => {
    const html = await renderViaStub(JSON.stringify(EXAMPLE_HUNK), { file: "src/foo.ts" });
    expect(html).toContain('id="swarm-diff-src-foo-ts-10"');
  });

  test("renders severity annotation badge on annotated line", async () => {
    const html = await renderViaStub(JSON.stringify(EXAMPLE_HUNK), { file: "src/foo.ts" });
    expect(html).toContain("WARN");
    expect(html).toContain("Avoid raw console.log");
  });

  test("handles empty/missing JSON body gracefully (no rows, no throw)", async () => {
    const html = await renderViaStub("", { file: "empty.ts" });
    // Should still render an outer container with the file name.
    expect(html).toContain("empty.ts");
    // But no <tr> rows.
    expect(html.match(/<tr\b/g) ?? []).toHaveLength(0);
  });

  test("escapes user-controlled text content to prevent injection", async () => {
    const xssHunk = {
      hunks: [
        {
          old_start: 1,
          old_lines: 1,
          new_start: 1,
          new_lines: 1,
          lines: [{ type: "add", text: "<script>alert('xss')</script>" }],
          annotations: [],
        },
      ],
    };
    const html = await renderViaStub(JSON.stringify(xssHunk), { file: "<bad>" });
    expect(html).not.toContain("<script>alert(");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("&lt;bad&gt;");
  });
});

describe("<swarm-diff> parse-order regression (Bug #479-1)", () => {
  // Real browsers fire connectedCallback when the parser sees the opening
  // tag, BEFORE the JSON text children are parsed. The element MUST defer
  // its parseHunks/render so it reads textContent AFTER the parser appends
  // the children. Without the queueMicrotask defer in connectedCallback,
  // the element renders an empty header and the JSON stays visible as
  // orphan text — that's the production bug PR #479 shipped initially.

  test("does NOT render synchronously inside connectedCallback (defer required)", () => {
    const rig = makeRig();
    const el = new rig.Ctor();
    // Simulate the real-browser parse order: connectedCallback fires while
    // textContent is still empty. The element must NOT have rendered yet
    // — if it does, it's reading textContent too early.
    rig.setText(el, { file: "src/foo.ts" }, "");
    if (typeof el.connectedCallback === "function") el.connectedCallback();
    expect(el.innerHTML).toBe("");
  });

  test("renders correctly when textContent is appended AFTER connectedCallback but BEFORE microtask drain", async () => {
    const rig = makeRig();
    const el = new rig.Ctor();
    // Parse order: connectedCallback fires with empty textContent, children
    // get appended, then microtask drains.
    rig.setText(el, { file: "src/foo.ts" }, "");
    if (typeof el.connectedCallback === "function") el.connectedCallback();
    // Parser would now append JSON children. Simulate by setting textContent.
    el.textContent = JSON.stringify(EXAMPLE_HUNK);
    await rig.flushMicrotasks();
    // After the microtask drains, the element must have rendered against
    // the post-callback textContent.
    expect(el.innerHTML).toContain("src/foo.ts");
    expect(el.innerHTML.match(/<tr\b/g) ?? []).toHaveLength(4);
    expect(el.innerHTML).toContain("WARN");
  });

  test("re-renders cleanly on reconnection (connectedCallback fires again)", async () => {
    const rig = makeRig();
    const el = new rig.Ctor();
    rig.setText(el, { file: "src/foo.ts" }, JSON.stringify(EXAMPLE_HUNK));
    if (typeof el.connectedCallback === "function") el.connectedCallback();
    await rig.flushMicrotasks();
    const firstRender = el.innerHTML;
    expect(firstRender).toContain("src/foo.ts");
    // Re-fire (element was moved or detached + reattached).
    if (typeof el.connectedCallback === "function") el.connectedCallback();
    await rig.flushMicrotasks();
    expect(el.innerHTML).toContain("src/foo.ts");
    expect(el.innerHTML.match(/<tr\b/g) ?? []).toHaveLength(4);
  });

  test("aborts render if element disconnected before microtask drains", async () => {
    const rig = makeRig();
    const el = new rig.Ctor();
    rig.setText(el, { file: "src/foo.ts" }, JSON.stringify(EXAMPLE_HUNK));
    if (typeof el.connectedCallback === "function") el.connectedCallback();
    // Element gets removed from the DOM before our microtask runs.
    el.isConnected = false;
    await rig.flushMicrotasks();
    expect(el.innerHTML).toBe("");
  });
});
