import { describe, expect, test } from "bun:test";
import { rehypeSourceLines } from "./rehype-source-lines";

// The plugin alone, on a hand-built hast tree. The rendered markdown (plugin
// order, raw HTML, sanitize) is covered by
// `components/comb/viewers/comb-markdown.test.tsx`.

const at = (start: number, end: number) => ({ start: { line: start }, end: { line: end } });

function tree() {
  return {
    type: "root",
    children: [
      { type: "element", tagName: "h1", properties: { id: "t" }, position: at(1, 1), children: [] },
      {
        type: "element",
        tagName: "table",
        position: at(3, 5),
        children: [
          {
            type: "element",
            tagName: "tr",
            position: at(3, 3),
            children: [{ type: "element", tagName: "td", position: at(3, 3), children: [] }],
          },
        ],
      },
      { type: "element", tagName: "span", position: at(7, 7), children: [] },
      { type: "element", tagName: "p", children: [] },
    ],
  };
}

describe("rehypeSourceLines", () => {
  test("stamps block elements with their source lines and keeps other properties", () => {
    const root = tree();
    rehypeSourceLines()(root);
    const [h1, table, span, p] = root.children;
    expect(h1?.properties).toEqual({ id: "t", dataLineStart: 1, dataLineEnd: 1 });
    expect(table?.properties).toEqual({ dataLineStart: 3, dataLineEnd: 5 });
    expect(table?.children[0]?.properties).toEqual({ dataLineStart: 3, dataLineEnd: 3 });
    // Cells, inline elements, and nodes without a position get no stamp.
    expect(table?.children[0]?.children[0]).not.toHaveProperty("properties");
    expect(span).not.toHaveProperty("properties");
    expect(p).not.toHaveProperty("properties");
  });
});
