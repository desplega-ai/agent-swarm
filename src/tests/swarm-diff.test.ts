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
  style: { cssText: string; transform: string };
  children: StubInstance[];
  hasAttribute?: (name: string) => boolean;
  connectedCallback?: () => void;
  disconnectedCallback?: () => void;
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
function makeRig(
  swarmSdk?: unknown,
  readyState = "complete",
  sdkConstructor?: new () => { room: (name?: string, options?: unknown) => Promise<unknown> },
): {
  Ctor: new () => StubInstance;
  CursorsCtor: new () => StubInstance;
  SdkCtor?: new () => { room: (name?: string, options?: unknown) => Promise<unknown> };
  body: StubInstance;
  setText: (el: StubInstance, attrs: Record<string, string>, text: string) => void;
  fireDocumentEvent: (name: string, event: unknown) => void;
  fireNextFrame: () => void;
  flushMicrotasks: () => Promise<void>;
} {
  const registry = new Map<string, new () => StubInstance>();
  const documentListeners = new Map<string, ((event: unknown) => void)[]>();
  const animationFrames = new Map<number, (time: number) => void>();
  let nextAnimationFrame = 1;

  class StubHTMLElement {
    innerHTML = "";
    textContent = "";
    isConnected = true;
    style = { cssText: "", transform: "" };
    parentNode: StubHTMLElement | null = null;
    children: StubHTMLElement[] = [];
    _attrs: Record<string, string> = {};
    getAttribute(name: string): string | null {
      return this._attrs[name] ?? null;
    }
    hasAttribute(name: string): boolean {
      return Object.hasOwn(this._attrs, name);
    }
    setAttribute(name: string, value: string): void {
      this._attrs[name] = value;
    }
    appendChild(child: StubHTMLElement): StubHTMLElement {
      child.parentNode = this;
      this.children.push(child);
      return child;
    }
    removeChild(child: StubHTMLElement): StubHTMLElement {
      this.children = this.children.filter((item) => item !== child);
      child.parentNode = null;
      return child;
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
    swarmSdk: swarmSdk as
      | { room?: (name: string, options?: unknown) => Promise<unknown> }
      | undefined,
    SwarmSDK: sdkConstructor,
    innerWidth: 1000,
    innerHeight: 500,
    scrollX: 0,
    scrollY: 0,
    requestAnimationFrame: (callback: (time: number) => void) => {
      const id = nextAnimationFrame++;
      animationFrames.set(id, callback);
      return id;
    },
    cancelAnimationFrame: (id: number) => animationFrames.delete(id),
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
  const body = new StubHTMLElement();
  const doc = {
    readyState,
    documentElement: { scrollWidth: 1000, scrollHeight: 500, clientWidth: 1000, clientHeight: 500 },
    body,
    createElement: () => new StubHTMLElement(),
    querySelectorAll: () => [],
    addEventListener: (name: string, handler: (event: unknown) => void) => {
      const handlers = documentListeners.get(name) ?? [];
      handlers.push(handler);
      documentListeners.set(name, handlers);
    },
    removeEventListener: (name: string, handler: (event: unknown) => void) => {
      documentListeners.set(
        name,
        (documentListeners.get(name) ?? []).filter((item) => item !== handler),
      );
    },
    fireEvent: (name: string, event: unknown) => {
      for (const handler of documentListeners.get(name) ?? []) handler(event);
    },
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
    `${SWARM_UI_JS}\nreturn { diff: window.customElements.get('swarm-diff'), cursors: window.customElements.get('swarm-cursors'), sdk: window.SwarmSDK };`,
  );
  const constructors = factory(
    win,
    customElements,
    doc,
    StubHTMLElement,
    win.CustomEvent,
    queueMicrotask,
    console,
  ) as {
    diff?: new () => StubInstance;
    cursors?: new () => StubInstance;
    sdk?: new () => { room: (name?: string, options?: unknown) => Promise<unknown> };
  };
  const Ctor = constructors.diff;
  if (!Ctor) throw new Error("custom element did not register");
  const CursorsCtor = constructors.cursors;
  if (!CursorsCtor) throw new Error("swarm-cursors custom element did not register");

  return {
    Ctor,
    CursorsCtor,
    SdkCtor: constructors.sdk,
    body,
    setText(el, attrs, text) {
      (el as unknown as { _attrs: Record<string, string> })._attrs = attrs;
      el.textContent = text;
    },
    fireDocumentEvent(name, event) {
      doc.fireEvent(name, event);
    },
    fireNextFrame() {
      const next = animationFrames.entries().next().value as
        | [number, (time: number) => void]
        | undefined;
      if (!next) return;
      animationFrames.delete(next[0]);
      next[1](0);
    },
    async flushMicrotasks() {
      // Drain the chained async room-open and render callbacks.
      for (let i = 0; i < 5; i++) await Promise.resolve();
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
    expect(SWARM_UI_JS).toContain("customElements.define('swarm-cursors'");
  });

  test("exposes window.swarmUi.renderDiff as a programmatic entry point", () => {
    expect(SWARM_UI_JS).toContain("window.swarmUi");
    expect(SWARM_UI_JS).toContain("renderDiff");
  });
});

describe("<swarm-cursors> presence merge", () => {
  test("reuses a page room's schema and preserves page presence fields", async () => {
    const sent: unknown[] = [];
    const roomOptions: unknown[] = [];
    const roomHandlers = new Map<string, (value: unknown) => void>();
    let closeCount = 0;
    const room = {
      me: { userId: "self" },
      presence: {
        peers: [] as unknown[],
        set(data: unknown) {
          sent.push(structuredClone(data));
        },
      },
      on(name: string, handler: (value: unknown) => void) {
        roomHandlers.set(name, handler);
        return () => roomHandlers.delete(name);
      },
      async close() {
        closeCount++;
      },
    };
    let pageRoomSchema: number | undefined;
    class PageSdk {
      async room(_name?: string, options?: unknown) {
        const requestedSchema =
          (options as { schemaVersion?: number } | undefined)?.schemaVersion ?? 1;
        if (pageRoomSchema !== undefined && requestedSchema !== pageRoomSchema)
          throw new Error("Room already opened with a different schema version");
        pageRoomSchema = requestedSchema;
        roomOptions.push(options);
        return room;
      }
    }
    const swarmSdk = new PageSdk();
    const rig = makeRig(swarmSdk, "loading", PageSdk);
    if (!rig.SdkCtor) throw new Error("SDK constructor was not wrapped");
    expect(swarmSdk).toBeInstanceOf(rig.SdkCtor);
    const pageSdk = new rig.SdkCtor();

    // Page code may set its data before the cursor element connects.
    const board = (await pageSdk.room(undefined, { schemaVersion: 2 })) as typeof room;
    const mismatchedOpens = await Promise.allSettled([
      pageSdk.room(undefined, { schemaVersion: 3 }),
      pageSdk.room(undefined, { schemaVersion: 4 }),
    ]);
    expect(mismatchedOpens.map(({ status }) => status)).toEqual(["rejected", "rejected"]);
    board.presence.set({ selectedCard: "card-1" });

    const cursors = new rig.CursorsCtor();
    rig.setText(cursors, { room: "default" }, "");
    cursors.connectedCallback?.();
    rig.fireDocumentEvent("DOMContentLoaded", undefined);
    await rig.flushMicrotasks();
    rig.fireDocumentEvent("pointermove", { pageX: 250, pageY: 125, clientX: 250, clientY: 125 });

    expect(sent.at(-1)).toEqual({ selectedCard: "card-1", __cursor: { x: 0.25, y: 0.25 } });

    // Later page updates also keep the active cursor in the replacement payload.
    board.presence.set({ selectedCard: "card-2", tool: "pen" });
    expect(sent.at(-1)).toEqual({
      selectedCard: "card-2",
      tool: "pen",
      __cursor: { x: 0.25, y: 0.25 },
    });
    rig.fireDocumentEvent("pointerleave", undefined);
    expect(sent.at(-1)).toEqual({ selectedCard: "card-2", tool: "pen" });
    cursors.disconnectedCallback?.();
    await rig.flushMicrotasks();
    expect(roomOptions).toEqual([{ schemaVersion: 2 }]);
    expect(closeCount).toBe(0);
  });

  test("closes a cursor-only room when the element disconnects", async () => {
    let closeCount = 0;
    const room = {
      me: { userId: "self" },
      presence: { peers: [], set: () => {} },
      on: () => () => {},
      async close() {
        closeCount++;
      },
    };
    const rig = makeRig({ room: async () => room });
    const cursors = new rig.CursorsCtor();
    rig.setText(cursors, { room: "cursor-only" }, "");
    cursors.connectedCallback?.();
    await rig.flushMicrotasks();

    cursors.disconnectedCallback?.();
    await rig.flushMicrotasks();
    expect(closeCount).toBe(1);
  });

  test("keeps a shared cursor active while another cursor element remains", async () => {
    const sent: unknown[] = [];
    let closeCount = 0;
    const room = {
      me: { userId: "self" },
      presence: {
        peers: [],
        set(data: unknown) {
          sent.push(structuredClone(data));
        },
      },
      on: () => () => {},
      async close() {
        closeCount++;
      },
    };
    const rig = makeRig({ room: async () => room });
    const first = new rig.CursorsCtor();
    const second = new rig.CursorsCtor();
    rig.setText(first, { room: "shared" }, "");
    rig.setText(second, { room: "shared" }, "");
    first.connectedCallback?.();
    await rig.flushMicrotasks();

    rig.fireDocumentEvent("pointermove", { pageX: 100, pageY: 100, clientX: 100, clientY: 100 });
    second.connectedCallback?.();
    await rig.flushMicrotasks();
    first.disconnectedCallback?.();
    expect(sent.at(-1)).toEqual({ __cursor: { x: 0.1, y: 0.2 } });
    expect(closeCount).toBe(0);

    second.disconnectedCallback?.();
    await rig.flushMicrotasks();
    expect(sent.at(-1)).toEqual({});
    expect(closeCount).toBe(1);
  });

  test("uses a page room reopened after close", async () => {
    const firstSent: unknown[] = [];
    const reopenedSent: unknown[] = [];
    let firstCloseCount = 0;
    let reopenedCloseCount = 0;
    const makeRoom = (sent: unknown[], onClose: () => void) => ({
      me: { userId: "self" },
      presence: {
        peers: [],
        set(data: unknown) {
          sent.push(structuredClone(data));
        },
      },
      on: () => () => {},
      async close() {
        onClose();
      },
    });
    const firstRoom = makeRoom(firstSent, () => firstCloseCount++);
    const reopenedRoom = makeRoom(reopenedSent, () => reopenedCloseCount++);
    let roomOpens = 0;
    const swarmSdk = {
      room: async (_name?: string) => (roomOpens++ === 0 ? firstRoom : reopenedRoom),
    };
    const rig = makeRig(swarmSdk);
    const board = await swarmSdk.room("board");
    await board.close();
    await swarmSdk.room("board");

    const cursors = new rig.CursorsCtor();
    rig.setText(cursors, { room: "board" }, "");
    cursors.connectedCallback?.();
    await rig.flushMicrotasks();
    rig.fireDocumentEvent("pointermove", { pageX: 300, pageY: 100, clientX: 300, clientY: 100 });

    expect(roomOpens).toBe(2);
    expect(firstSent).toHaveLength(0);
    expect(reopenedSent.at(-1)).toEqual({ __cursor: { x: 0.3, y: 0.2 } });
    cursors.disconnectedCallback?.();
    expect(reopenedCloseCount).toBe(0);
  });

  test("renders remote people and removes an unchanged cursor after idle", async () => {
    const roomHandlers = new Map<string, (value: unknown) => void>();
    const room = {
      me: { userId: "self" },
      presence: { peers: [], set: () => {} },
      on(name: string, handler: (value: unknown) => void) {
        roomHandlers.set(name, handler);
        return () => roomHandlers.delete(name);
      },
      async close() {},
    };
    const rig = makeRig({ room: async () => room });
    const cursors = new rig.CursorsCtor();
    rig.setText(cursors, { room: "board" }, "");
    cursors.connectedCallback?.();

    const realNow = Date.now;
    let now = 1000;
    Date.now = () => now;
    try {
      await rig.flushMicrotasks();
      const peers = [
        { userId: "self", name: "Self", kind: "human", data: { __cursor: { x: 0.1, y: 0.1 } } },
        { userId: "agent-1", name: "Agent", kind: "agent", data: { __cursor: { x: 0.9, y: 0.9 } } },
        {
          userId: "person-1",
          name: "Avery",
          kind: "human",
          data: { __cursor: { x: 0.25, y: 0.5 } },
        },
      ];
      roomHandlers.get("presence")?.(peers);

      const overlay = rig.body.children[0] as StubInstance;
      expect(overlay.children).toHaveLength(1);
      expect(overlay.children[0]?.innerHTML).toContain("Avery");
      expect(overlay.children[0]?.innerHTML).toContain("<svg");
      rig.fireNextFrame();
      expect(overlay.children[0]?.style.transform).toBe("translate3d(250px,250px,0)");

      now = 5000;
      roomHandlers.get("presence")?.(peers);
      expect(overlay.children).toHaveLength(0);
    } finally {
      Date.now = realNow;
      cursors.disconnectedCallback?.();
    }
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
