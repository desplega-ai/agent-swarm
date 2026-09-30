import { afterAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register();
afterAll(async () => {
  await GlobalRegistrator.unregister();
});

const { anchorFromRange, buildDomTextSpace, isSkippedElement } = await import("./dom-text-space");

/** Two text viewer rows, a skipped notice, a paragraph with a button, and Streamdown chrome. */
function renderPane(): HTMLElement {
  const root = document.createElement("div");
  root.innerHTML = [
    '<div data-comb-skip=""><p>Showing the first 2 lines.</p></div>',
    '<div data-line-start="1" data-line-end="1"><span aria-hidden="true" data-comb-skip="">1</span><span>const a = 1;</span></div>',
    '<div data-line-start="2" data-line-end="2"><span data-comb-skip="">2</span><span>const b = 2;</span></div>',
    '<p data-line-start="3" data-line-end="3">Hello <button>Copy</button>world</p>',
    '<div data-streamdown="code-block-header">ts</div>',
    '<span data-streamdown="image-fallback">Image not available</span>',
  ].join("");
  document.body.append(root);
  return root;
}

describe("dom-text-space", () => {
  test("data-comb-skip content, buttons, and Streamdown chrome are not document text", () => {
    const space = buildDomTextSpace(renderPane());
    expect(space.text).toBe("const a = 1;\nconst b = 2;\nHello world\n");
  });

  test("offsets map to the stamped source lines", () => {
    const space = buildDomTextSpace(renderPane());
    expect(space.offsetToLine(space.text.indexOf("b = 2"))).toBe(2);
    expect(space.offsetToLine(space.text.indexOf("world"))).toBe(3);
    const [start, end] = space.lineRangeToOffsets(2, 2) ?? [0, 0];
    expect(space.text.slice(start, end)).toBe("const b = 2;");
  });

  test("a selection becomes a quote with context and a line range", () => {
    const root = renderPane();
    const row = root.querySelector('[data-line-start="2"] span:last-child')?.firstChild;
    if (!row) throw new Error("missing row text");
    const range = document.createRange();
    range.setStart(row, "const ".length);
    range.setEnd(row, "const b = 2".length);
    const anchor = anchorFromRange(root, range);
    expect(anchor?.quote).toEqual({
      exact: "b = 2",
      prefix: "const a = 1;\nconst ",
      suffix: ";\nHello world\n",
    });
    expect(anchor?.lineStart).toBe(2);
    expect(anchor?.lineEnd).toBe(2);
    expect(anchor?.quotedContent).toBe("b = 2");
  });

  test("the skip rule", () => {
    const el = (html: string) => {
      const host = document.createElement("div");
      host.innerHTML = html;
      return host.firstElementChild as Element;
    };
    expect(isSkippedElement(el("<span data-comb-skip></span>"))).toBe(true);
    expect(isSkippedElement(el('<div data-streamdown="table-fullscreen"></div>'))).toBe(true);
    expect(isSkippedElement(el('<div data-streamdown="table-wrapper"></div>'))).toBe(false);
    expect(isSkippedElement(el('<p aria-hidden="true"></p>'))).toBe(true);
    expect(isSkippedElement(el("<p></p>"))).toBe(false);
  });
});
