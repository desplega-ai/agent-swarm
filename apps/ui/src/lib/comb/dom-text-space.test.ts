import { afterAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register();
afterAll(async () => {
  await GlobalRegistrator.unregister();
});

const { anchorFromRange, buildDomTextSpace, isSkippedElement, withBlockLineEnd } = await import(
  "./dom-text-space"
);
const { resolveAnchor } = await import("./comment-anchor");

function mount(html: string): HTMLElement {
  const root = document.createElement("div");
  root.innerHTML = html;
  document.body.append(root);
  return root;
}

/** A text viewer row, as `TextLines` renders it (gutter, then one text span). */
function row(line: number, text: string): string {
  return `<div data-line-start="${line}" data-line-end="${line}" data-comb-row=""><span aria-hidden="true" data-comb-skip="">${line}</span><span>${text}</span></div>`;
}

/** Two text viewer rows, a skipped notice, a paragraph with a button, and Streamdown chrome. */
function renderPane(): HTMLElement {
  return mount(
    [
      '<div data-comb-skip=""><p>Showing the first 2 lines.</p></div>',
      row(1, "const a = 1;"),
      row(2, "const b = 2;"),
      '<p data-line-start="3" data-line-end="3">Hello <button>Copy</button>world</p>',
      '<div data-streamdown="code-block-header">ts</div>',
      '<span data-streamdown="image-fallback">Image not available</span>',
    ].join(""),
  );
}

/** The text node of a text viewer row. */
function rowText(root: HTMLElement, line: number): Text {
  const node = root.querySelector(`[data-line-start="${line}"] span:last-child`)?.firstChild;
  if (!(node instanceof Text)) throw new Error(`row ${line} has no text`);
  return node;
}

function rangeOf(start: [Node, number], end: [Node, number]): Range {
  const range = document.createRange();
  range.setStart(...start);
  range.setEnd(...end);
  return range;
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
    const text = rowText(root, 2);
    const anchor = anchorFromRange(
      buildDomTextSpace(root),
      rangeOf([text, "const ".length], [text, "const b = 2".length]),
    );
    expect(anchor?.quote).toEqual({
      exact: "b = 2",
      prefix: "const a = 1;\nconst ",
      suffix: ";\nHello world\n",
    });
    expect(anchor?.lineStart).toBe(2);
    expect(anchor?.lineEnd).toBe(2);
    expect(anchor?.quotedContent).toBe("b = 2");
  });

  test("text rows are the file's own text: blank lines stay, so a quote is verbatim", () => {
    const source = "const a = 1;\n\n  const b = 2;\n";
    const root = mount([row(1, "const a = 1;"), row(2, ""), row(3, "  const b = 2;")].join(""));
    const space = buildDomTextSpace(root);
    expect(space.text).toBe(source);
    const anchor = anchorFromRange(
      space,
      rangeOf([rowText(root, 1), 0], [rowText(root, 3), "  const b = 2;".length]),
    );
    expect(anchor?.quote?.exact).toBe("const a = 1;\n\n  const b = 2;");
    expect(source.includes(anchor?.quote?.exact ?? "missing")).toBe(true);
    expect([anchor?.lineStart, anchor?.lineEnd]).toEqual([1, 3]);
  });

  test("rows 1-2 selected give L1-2, also when the selection ends at the start of row 3", () => {
    const root = mount([row(1, "one"), row(2, "two"), row(3, "three")].join(""));
    const space = buildDomTextSpace(root);
    const exact = anchorFromRange(space, rangeOf([rowText(root, 1), 0], [rowText(root, 2), 3]));
    expect([exact?.lineStart, exact?.lineEnd, exact?.quote?.exact]).toEqual([1, 2, "one\ntwo"]);
    // Triple-click style: the end is the next row's element boundary.
    const row3 = root.querySelector('[data-line-start="3"]') as Element;
    const toNext = anchorFromRange(space, rangeOf([rowText(root, 1), 0], [row3, 0]));
    expect([toNext?.lineStart, toNext?.lineEnd, toNext?.quote?.exact]).toEqual([1, 2, "one\ntwo"]);
  });

  test("a whole multi-line paragraph gives its full line range", () => {
    const root = mount(
      [
        '<p data-line-start="1" data-line-end="1">Title</p>',
        '<p data-line-start="5" data-line-end="7">One paragraph over three source lines.</p>',
        '<p data-line-start="9" data-line-end="9">Next.</p>',
      ].join(""),
    );
    const space = buildDomTextSpace(root);
    const paragraph = root.querySelector('[data-line-start="5"]') as Element;
    const whole = document.createRange();
    whole.selectNodeContents(paragraph);
    const anchor = anchorFromRange(space, whole);
    expect([anchor?.lineStart, anchor?.lineEnd]).toEqual([5, 7]);
    expect(anchor?.quote?.exact).toBe("One paragraph over three source lines.");

    // Ending at the start of the next paragraph: still L5-7, not L5-9.
    const next = root.querySelector('[data-line-start="9"]')?.firstChild as Text;
    const toNext = anchorFromRange(space, rangeOf([paragraph.firstChild as Text, 0], [next, 0]));
    expect([toNext?.lineStart, toNext?.lineEnd]).toEqual([5, 7]);
  });

  test("a selection across blocks spans the first block's start to the last block's end", () => {
    const root = mount(
      [
        '<p data-line-start="1" data-line-end="2">First block.</p>',
        '<ul data-line-start="4" data-line-end="6"><li data-line-start="4" data-line-end="4">item one</li><li data-line-start="5" data-line-end="6">item two</li></ul>',
      ].join(""),
    );
    const space = buildDomTextSpace(root);
    const first = root.querySelector("p")?.firstChild as Text;
    const last = root.querySelectorAll("li")[1].firstChild as Text;
    const anchor = anchorFromRange(space, rangeOf([first, "First ".length], [last, 4]));
    expect(anchor?.quote?.exact).toBe("block.\nitem one\nitem");
    expect([anchor?.lineStart, anchor?.lineEnd]).toEqual([1, 6]);
  });

  test("an element boundary maps to the first document text after it", () => {
    const root = renderPane();
    const space = buildDomTextSpace(root);
    // Row 2 starts with its gutter ("2"), which is not document text.
    const row2 = root.querySelector('[data-line-start="2"]') as Element;
    expect(space.pointToOffset(row2, 0)).toBe(space.text.indexOf("const b"));
    expect(space.pointToOffset(root, root.childNodes.length)).toBe(space.text.length);
  });

  test("toRange and pointToOffset round-trip, within a block and across blocks", () => {
    const root = renderPane();
    const space = buildDomTextSpace(root);
    const cases: Array<[number, number]> = [
      [space.text.indexOf("b = 2"), space.text.indexOf("b = 2") + 5],
      [space.text.indexOf("a = 1"), space.text.indexOf("world") + 5],
      [0, space.text.indexOf("\n")],
    ];
    for (const [start, end] of cases) {
      const range = space.toRange(start, end);
      if (!range) throw new Error("no range");
      expect(space.pointToOffset(range.startContainer, range.startOffset)).toBe(start);
      expect(space.pointToOffset(range.endContainer, range.endOffset)).toBe(end);
    }
    // A range from a selection maps back to the same quote.
    const anchor = anchorFromRange(space, space.toRange(cases[1][0], cases[1][1]) as Range);
    expect(anchor?.quote?.exact).toBe("a = 1;\nconst b = 2;\nHello world");
  });

  test("a resolved quote over a multi-line block reports the block's end line", () => {
    const root = mount(
      [
        '<p data-line-start="1" data-line-end="1">Title</p>',
        '<p data-line-start="3" data-line-end="5">One paragraph over three source lines.</p>',
      ].join(""),
    );
    const space = buildDomTextSpace(root);
    const quote = { exact: "One paragraph over three source lines." };
    const live = resolveAnchor(space, { quote, lineStart: 3, lineEnd: 5 });
    // live/'s own answer: the start line twice.
    expect([live.lineStart, live.lineEnd]).toEqual([3, 3]);
    const fixed = withBlockLineEnd(space, live);
    expect([fixed.status, fixed.lineStart, fixed.lineEnd]).toEqual(["anchored", 3, 5]);
    // A line-placed resolution keeps its own range.
    const byLines = {
      status: "moved" as const,
      method: "lines" as const,
      start: 0,
      end: 5,
      lineStart: 1,
      lineEnd: 1,
    };
    expect(withBlockLineEnd(space, byLines)).toBe(byLines);
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

// Syntax highlighting (`code-tokens.tsx`) splits a line into one text node per
// token: a colored token is a span, a plain token is bare text. `tok` marks a
// colored token, a bare string is plain.
const tok = (text: string) => ({ text });
type Part = string | { text: string };

const SOURCE = ["const s = z.object({", "  ids: z.array(z.string()),", "});"];
const TOKENS: Part[][] = [
  [tok("const"), " s ", tok("="), " z", tok("."), tok("object"), tok("("), tok("{")],
  [
    "  ids",
    tok(":"),
    " z",
    tok("."),
    tok("array"),
    tok("("),
    "z",
    tok("."),
    tok("string"),
    tok("("),
    tok(")"),
    tok(")"),
    tok(","),
  ],
  [tok("}"), tok(")"), tok(";")],
];

function tokenHtml(parts: Part[]): string {
  return parts
    .map((p) =>
      typeof p === "string" ? p : `<span style="color: rgb(86, 156, 214)">${p.text}</span>`,
    )
    .join("");
}

/** A highlighted text viewer row: gutter, then the line's token spans and bare text. */
function tokenRow(line: number, parts: Part[]): string {
  return `<div data-line-start="${line}" data-line-end="${line}" data-comb-row=""><span aria-hidden="true" data-comb-skip="">${line}</span><span>${tokenHtml(parts)}</span></div>`;
}

const plainPane = () => mount(SOURCE.map((text, i) => row(i + 1, text)).join(""));
const tokenPane = () => mount(TOKENS.map((parts, i) => tokenRow(i + 1, parts)).join(""));

/** The text node that holds `text` in row `line` (the `nth` match, 0-based). */
function textNode(root: HTMLElement, line: number, text: string, nth = 0): Text {
  const walker = document.createTreeWalker(
    root.querySelector(`[data-line-start="${line}"] > span:last-child`) as Node,
    NodeFilter.SHOW_TEXT,
  );
  let seen = 0;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if ((node as Text).data === text && seen++ === nth) return node as Text;
  }
  throw new Error(`row ${line} has no text node "${text}"`);
}

describe("dom-text-space over highlighted code (one text node per token)", () => {
  test("the token rows read as the file's own text, line by line", () => {
    for (const [i, parts] of TOKENS.entries()) {
      expect(parts.map((p) => (typeof p === "string" ? p : p.text)).join("")).toBe(SOURCE[i]);
    }
    const space = buildDomTextSpace(tokenPane());
    expect(space.text).toBe(`${SOURCE.join("\n")}\n`);
    expect(space.text).toBe(buildDomTextSpace(plainPane()).text);
    expect(space.offsetToLine(space.text.indexOf("array"))).toBe(2);
    const [start, end] = space.lineRangeToOffsets(2, 2) ?? [0, 0];
    expect(space.text.slice(start, end)).toBe(SOURCE[1]);
  });

  test("a selection across tokens gives the same anchor as on the plain rows", () => {
    const tokens = tokenPane();
    // From inside "array" to inside "string": five text nodes in between.
    const onTokens = anchorFromRange(
      buildDomTextSpace(tokens),
      rangeOf([textNode(tokens, 2, "array"), 2], [textNode(tokens, 2, "string"), 3]),
    );
    const plain = plainPane();
    const line = rowText(plain, 2);
    const onPlain = anchorFromRange(
      buildDomTextSpace(plain),
      rangeOf([line, SOURCE[1].indexOf("array") + 2], [line, SOURCE[1].indexOf("string") + 3]),
    );
    expect(onTokens?.quote?.exact).toBe("ray(z.str");
    expect(onTokens).toEqual(onPlain);
    expect([onTokens?.lineStart, onTokens?.lineEnd]).toEqual([2, 2]);
  });

  test("a selection across highlighted rows spans their lines", () => {
    const root = tokenPane();
    const anchor = anchorFromRange(
      buildDomTextSpace(root),
      rangeOf([textNode(root, 1, "object"), 0], [textNode(root, 3, ")"), 1]),
    );
    expect(anchor?.quote?.exact).toBe("object({\n  ids: z.array(z.string()),\n})");
    expect([anchor?.lineStart, anchor?.lineEnd]).toEqual([1, 3]);
  });

  test("an anchor made on plain rows paints the same passage on token rows", () => {
    const plain = plainPane();
    const created = anchorFromRange(
      buildDomTextSpace(plain),
      rangeOf([rowText(plain, 2), 7], [rowText(plain, 2), SOURCE[1].length - 1]),
    );
    if (!created?.quote) throw new Error("no anchor");
    expect(created.quote.exact).toBe("z.array(z.string())");

    const tokens = tokenPane();
    const space = buildDomTextSpace(tokens);
    const resolved = resolveAnchor(space, {
      quote: created.quote,
      lineStart: created.lineStart,
      lineEnd: created.lineEnd,
    });
    expect(resolved.status).toBe("anchored");
    if (resolved.start == null || resolved.end == null) throw new Error("not placed");
    const range = space.toRange(resolved.start, resolved.end);
    // The painted range starts in the " z" text node and ends in the ")" token.
    expect(range?.startContainer).toBe(textNode(tokens, 2, " z"));
    expect(range?.startOffset).toBe(1);
    expect(range?.endContainer).toBe(textNode(tokens, 2, ")", 1));
    expect(range?.toString()).toBe("z.array(z.string())");
  });

  test("at a token boundary a range starts in the next token and ends in the previous one", () => {
    const root = tokenPane();
    const space = buildDomTextSpace(root);
    const boundary = "const".length;
    const range = space.toRange(boundary, boundary + " s ".length);
    expect(range?.startContainer).toBe(textNode(root, 1, " s "));
    expect(range?.startOffset).toBe(0);
    expect(range?.endContainer).toBe(textNode(root, 1, " s "));
    expect(range?.endOffset).toBe(3);
    const tail = space.toRange(0, boundary);
    expect(tail?.endContainer).toBe(textNode(root, 1, "const"));
    expect(tail?.endOffset).toBe(5);
  });

  test("element boundaries inside token rows map to the first text after them", () => {
    const root = tokenPane();
    const space = buildDomTextSpace(root);
    const line2 = root.querySelector('[data-line-start="2"] > span:last-child') as Element;
    const line2Start = space.text.indexOf(SOURCE[1]);
    // Before each child of the line: the offset where that child's text starts.
    let offset = line2Start;
    for (const [i, part] of TOKENS[1].entries()) {
      expect([i, space.pointToOffset(line2, i)]).toEqual([i, offset]);
      offset += (typeof part === "string" ? part : part.text).length;
    }
    // After the last child: the next row's first text (past the row's "\n").
    expect(space.pointToOffset(line2, line2.childNodes.length)).toBe(space.text.indexOf(SOURCE[2]));
    expect(space.pointToOffset(root, root.childNodes.length)).toBe(space.text.length);
  });

  test("many token rows: every row boundary and token node maps to its offset", () => {
    const lines = Array.from({ length: 120 }, (_, i) => `let v${i} = f(${i}, "s${i}");`);
    const parts = (i: number): Part[] => [
      tok("let"),
      ` v${i} `,
      tok("="),
      " ",
      tok("f"),
      tok("("),
      tok(String(i)),
      tok(","),
      " ",
      tok(`"s${i}"`),
      tok(")"),
      tok(";"),
    ];
    const root = mount(lines.map((_, i) => tokenRow(i + 1, parts(i))).join(""));
    const space = buildDomTextSpace(root);
    expect(space.text).toBe(`${lines.join("\n")}\n`);
    let lineStart = 0;
    for (const [i, line] of lines.entries()) {
      // The row's first child is the skipped gutter: the text starts after it.
      expect(space.pointToOffset(root.children[i], 0)).toBe(lineStart);
      const number = textNode(root, i + 1, String(i));
      expect(space.pointToOffset(number, 1)).toBe(lineStart + line.indexOf(`(${i}`) + 2);
      lineStart += line.length + 1;
    }
  });

  test("a highlighted markdown fence keeps its text, its line stamps, and its anchors", () => {
    const fence = (body: string) =>
      [
        '<p data-line-start="1" data-line-end="1">Intro.</p>',
        `<pre data-line-start="3" data-line-end="6"><code class="language-ts">${body}</code></pre>`,
        '<p data-line-start="8" data-line-end="8">After.</p>',
      ].join("");
    const plain = mount(fence("const a = 1;\nlet b;\n"));
    const tokens = mount(
      fence(
        `${tokenHtml([tok("const"), " a ", tok("="), " ", tok("1"), tok(";")])}\n${tokenHtml([tok("let"), " b", tok(";")])}\n`,
      ),
    );
    const space = buildDomTextSpace(tokens);
    expect(space.text).toBe(buildDomTextSpace(plain).text);
    expect(space.text).toBe("Intro.\nconst a = 1;\nlet b;\nAfter.\n");

    // From inside "= 1" on the first code line to inside "let" on the second.
    const code = tokens.querySelector("code") as Element;
    const walker = document.createTreeWalker(code, NodeFilter.SHOW_TEXT);
    const nodes: Text[] = [];
    for (let n = walker.nextNode(); n; n = walker.nextNode()) nodes.push(n as Text);
    const one = nodes.find((n) => n.data === "1") as Text;
    const let_ = nodes.find((n) => n.data === "let") as Text;
    const anchor = anchorFromRange(space, rangeOf([one, 0], [let_, 2]));
    expect(anchor?.quote?.exact).toBe("1;\nle");
    expect([anchor?.lineStart, anchor?.lineEnd]).toEqual([3, 6]);

    const plainCode = plain.querySelector("code")?.firstChild as Text;
    const onPlain = anchorFromRange(
      buildDomTextSpace(plain),
      rangeOf([plainCode, "const a = ".length], [plainCode, "const a = 1;\nle".length]),
    );
    expect(anchor).toEqual(onPlain);
    const resolved = resolveAnchor(space, { quote: onPlain?.quote });
    expect(space.toRange(resolved.start ?? 0, resolved.end ?? 0)?.toString()).toBe("1;\nle");
  });
});
