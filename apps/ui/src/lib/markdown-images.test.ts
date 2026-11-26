import { describe, expect, test } from "bun:test";
import { markdownMediaKind, rehypeMediaLinks } from "./markdown-images";

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
  rehypeMediaLinks()(tree);
  return tree.children?.[0]?.children ?? [];
}

describe("markdownMediaKind", () => {
  test("reads the URL path extension, with or without a query string", () => {
    expect(markdownMediaKind("https://x.dev/card.png")).toBe("image");
    expect(markdownMediaKind("https://x.dev/a/b.JPEG")).toBe("image");
    expect(markdownMediaKind("http://x.dev/c.gif#top")).toBe("image");
    expect(
      markdownMediaKind(
        "https://bucket.t3.storage.dev/og.webp?X-Amz-Expires=3600&X-Amz-Signature=ab",
      ),
    ).toBe("image");
    expect(markdownMediaKind("https://x.dev/run/demo.mp4")).toBe("video");
    expect(markdownMediaKind("https://x.dev/clip.WEBM?v=2")).toBe("video");
  });

  test("falls back to a label that is a file name, for extensionless share URLs", () => {
    const raw = "https://fs.dev/share/e6SRjHLp/raw";
    expect(markdownMediaKind(raw)).toBeNull();
    expect(markdownMediaKind(raw, "demo.mp4")).toBe("video");
    expect(markdownMediaKind(raw, "frame.jpg")).toBe("image");
    expect(markdownMediaKind(raw, "the clip")).toBeNull();
  });

  test("rejects non-media paths and non-http schemes", () => {
    expect(markdownMediaKind("https://x.dev/card.png.html")).toBeNull();
    expect(markdownMediaKind("https://x.dev/page?file=card.png")).toBeNull();
    expect(markdownMediaKind("https://github.com/desplega-ai/agent-swarm")).toBeNull();
    expect(markdownMediaKind("javascript:alert(1)//.png")).toBeNull();
    expect(markdownMediaKind("javascript:alert(1)", "demo.mp4")).toBeNull();
    expect(markdownMediaKind("/file/~/org/drive/demo.mp4")).toBeNull();
  });
});

describe("rehypeMediaLinks", () => {
  test("turns an autolinked bare image URL into an img", () => {
    const url = "https://x.dev/og.png?X-Amz-Expires=3600";
    expect(run(paragraph(link(url)))).toEqual([
      { type: "element", tagName: "img", properties: { src: url, alt: "" }, children: [] },
    ]);
  });

  test("turns labelled media links into an img with the label as alt", () => {
    const sheet = "https://x.dev/run/contact-sheet.jpg";
    const share = "https://fs.dev/share/e6SRjHLp/raw";
    expect(run(paragraph(link(sheet, "contact sheet"), link(share, "demo.mp4")))).toEqual([
      {
        type: "element",
        tagName: "img",
        properties: { src: sheet, alt: "contact sheet" },
        children: [],
      },
      {
        type: "element",
        tagName: "img",
        properties: { src: share, alt: "demo.mp4" },
        children: [],
      },
    ]);
  });

  test("keeps other links as links", () => {
    const pr = link("https://github.com/desplega-ai/agent-swarm/pull/3717", "PR");
    const share = link("https://fs.dev/share/e6SRjHLp/raw");
    const page = link("https://github.com/desplega-ai/agent-swarm");
    expect(run(paragraph(pr, share, page))).toEqual([pr, share, page]);
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
    rehypeMediaLinks()(tree);
    expect(tree.children?.[0]?.children?.[0]?.children?.[0]?.tagName).toBe("img");
  });
});
