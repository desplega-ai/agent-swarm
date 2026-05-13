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

/**
 * Build a minimal stub window with just enough surface area to load
 * SWARM_UI_JS, register the custom element, and exercise the render path.
 * Returns the captured `<swarm-diff>` element's `innerHTML` after the
 * element's `connectedCallback` fires.
 */
function renderViaStub(text: string, attrs: Record<string, string>): string {
  const registry = new Map<string, typeof StubHTMLElement>();

  class StubHTMLElement {
    innerHTML = "";
    textContent = text;
    private _attrs: Record<string, string> = attrs;
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
  }

  const customElements = {
    define(name: string, ctor: typeof StubHTMLElement) {
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
  };

  // Provide `document` stubs the jump-list path uses (we don't exercise it
  // here, but keep it safe).
  const doc = {
    querySelectorAll: () => [],
  };

  // Evaluate SWARM_UI_JS with our stubs in scope. The IIFE inside the
  // constant captures `window`, `customElements`, `document`, and
  // `HTMLElement` — provide each as a free variable.
  const factory = new Function(
    "window",
    "customElements",
    "document",
    "HTMLElement",
    "console",
    `${SWARM_UI_JS}\nreturn window.customElements.get('swarm-diff');`,
  );
  const Ctor = factory(win, customElements, doc, StubHTMLElement, console) as
    | typeof StubHTMLElement
    | undefined;
  if (!Ctor) throw new Error("custom element did not register");

  const el = new Ctor();
  // The IIFE assigns class via window.customElements.define; the element
  // class has prototype connectedCallback. Invoke it manually since we don't
  // run a real DOM.
  if (typeof el.connectedCallback === "function") el.connectedCallback();
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
  test("constructs and renders without throwing on the example input", () => {
    const html = renderViaStub(JSON.stringify(EXAMPLE_HUNK), {
      file: "src/foo.ts",
      "base-sha": "abc123",
      "head-sha": "def456",
    });
    expect(html.length).toBeGreaterThan(0);
  });

  test("renders one <tr> per line in each hunk", () => {
    const html = renderViaStub(JSON.stringify(EXAMPLE_HUNK), { file: "src/foo.ts" });
    // 4 lines in the example hunk → 4 <tr> rows.
    const trMatches = html.match(/<tr\b/g) || [];
    expect(trMatches.length).toBe(4);
  });

  test("renders file header and SHA range", () => {
    const html = renderViaStub(JSON.stringify(EXAMPLE_HUNK), {
      file: "src/foo.ts",
      "base-sha": "abc123",
      "head-sha": "def456",
    });
    expect(html).toContain("src/foo.ts");
    expect(html).toContain("abc123");
    expect(html).toContain("def456");
  });

  test("renders deterministic anchor id per hunk", () => {
    const html = renderViaStub(JSON.stringify(EXAMPLE_HUNK), { file: "src/foo.ts" });
    expect(html).toContain('id="swarm-diff-src-foo-ts-10"');
  });

  test("renders severity annotation badge on annotated line", () => {
    const html = renderViaStub(JSON.stringify(EXAMPLE_HUNK), { file: "src/foo.ts" });
    expect(html).toContain("WARN");
    expect(html).toContain("Avoid raw console.log");
  });

  test("handles empty/missing JSON body gracefully (no rows, no throw)", () => {
    const html = renderViaStub("", { file: "empty.ts" });
    // Should still render an outer container with the file name.
    expect(html).toContain("empty.ts");
    // But no <tr> rows.
    expect(html.match(/<tr\b/g) ?? []).toHaveLength(0);
  });

  test("escapes user-controlled text content to prevent injection", () => {
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
    const html = renderViaStub(JSON.stringify(xssHunk), { file: "<bad>" });
    expect(html).not.toContain("<script>alert(");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("&lt;bad&gt;");
  });
});
