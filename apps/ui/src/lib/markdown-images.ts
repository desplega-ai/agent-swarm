// Inline images for markdown rendered with Streamdown. A bare image URL in the
// text (autolinked by GFM into `<a href=url>url</a>`) becomes an `<img>`, so a
// pasted render link shows the picture instead of a long presigned URL.

interface HastNode {
  type: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
}

/** http(s) URL whose path ends in an image extension; a query or hash is allowed. */
const IMAGE_URL = /^https?:\/\/[^\s?#]+\.(?:png|jpe?g|gif|webp)(?:[?#]\S*)?$/i;

export function isImageUrl(url: string): boolean {
  return IMAGE_URL.test(url.trim());
}

function textOf(node: HastNode): string {
  if (node.type === "text") return node.value ?? "";
  return (node.children ?? []).map(textOf).join("");
}

/**
 * Rehype plugin: replace an autolinked bare image URL with an `<img>`. Only
 * links whose visible text is the URL itself qualify, so `[a chart](x.png)`
 * stays a link. Code is never touched: GFM does not autolink inside it.
 */
export function rehypeBareImageLinks() {
  return (tree: HastNode) => {
    const visit = (node: HastNode) => {
      if (!node.children) return;
      node.children = node.children.map((child) => {
        const href = child.properties?.href;
        if (
          child.type === "element" &&
          child.tagName === "a" &&
          typeof href === "string" &&
          isImageUrl(href) &&
          textOf(child).trim() === href
        ) {
          return {
            type: "element",
            tagName: "img",
            properties: { src: href, alt: "" },
            children: [],
          };
        }
        visit(child);
        return child;
      });
    };
    visit(tree);
  };
}
