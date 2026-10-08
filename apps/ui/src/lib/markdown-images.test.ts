import { describe, expect, test } from "bun:test";
import { isImageUrl, rehypeBareImageLinks } from "./markdown-images";

type Node = {
  type: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: Node[];
};

const link = (href: string, text = href): Node => ({
  type: "element",
  tagName: "a",
  properties: { href },
  children: [{ type: "text", value: text }],
});

const paragraph = (...children: Node[]): Node => ({
  type: "root",
  children: [{ type: "element", tagName: "p", properties: {}, children }],
});

function run(tree: Node): Node[] {
  rehypeBareImageLinks()(tree);
  return tree.children?.[0]?.children ?? [];
}

describe("isImageUrl", () => {
  test("accepts image extensions, with or without a query string", () => {
    expect(isImageUrl("https://x.dev/card.png")).toBe(true);
    expect(isImageUrl("https://x.dev/a/b.JPEG")).toBe(true);
    expect(isImageUrl("http://x.dev/c.gif#top")).toBe(true);
    expect(
      isImageUrl("https://bucket.t3.storage.dev/og.webp?X-Amz-Expires=3600&X-Amz-Signature=ab"),
    ).toBe(true);
  });

  test("rejects non-image paths and non-http schemes", () => {
    expect(isImageUrl("https://x.dev/card.png.html")).toBe(false);
    expect(isImageUrl("https://x.dev/page?file=card.png")).toBe(false);
    expect(isImageUrl("https://github.com/desplega-ai/agent-swarm")).toBe(false);
    expect(isImageUrl("javascript:alert(1)//.png")).toBe(false);
  });
});

describe("rehypeBareImageLinks", () => {
  test("turns an autolinked bare image URL into an img", () => {
    const url = "https://x.dev/og.png?X-Amz-Expires=3600";
    expect(run(paragraph(link(url)))).toEqual([
      { type: "element", tagName: "img", properties: { src: url, alt: "" }, children: [] },
    ]);
  });

  test("keeps a labelled link and a non-image autolink as links", () => {
    const labelled = link("https://x.dev/og.png", "the card");
    const page = link("https://github.com/desplega-ai/agent-swarm");
    expect(run(paragraph(labelled, page))).toEqual([labelled, page]);
  });

  test("finds bare image links nested in lists", () => {
    const url = "https://x.dev/og.jpg";
    const tree: Node = {
      type: "root",
      children: [
        {
          type: "element",
          tagName: "ul",
          children: [{ type: "element", tagName: "li", children: [link(url)] }],
        },
      ],
    };
    rehypeBareImageLinks()(tree);
    expect(tree.children?.[0]?.children?.[0]?.children?.[0]?.tagName).toBe("img");
  });
});
