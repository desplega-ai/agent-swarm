// Inline media for markdown rendered with Streamdown. A link to an image or a
// video becomes an `<img>`, which `MarkdownImage` shows as a picture or a
// `<video>` player, so a pasted render link shows the media instead of a URL.
//
// The signal is a file extension, read from the URL path or, when the URL has
// none (an agent-fs share `/raw` URL), from the link label or image alt:
//   https://x.dev/clip.mp4                  bare URL with an extension
//   [contact sheet](https://x.dev/cs.jpg)   link whose URL path has one
//   [demo.mp4](https://fs.dev/share/t/raw)  link whose label is a file name
//   ![demo.mp4](https://fs.dev/share/t/raw) image syntax, same rule on the alt
// Any other link stays a link.

interface HastNode {
  type: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
}

export type MarkdownMediaKind = "image" | "video";

const IMAGE_EXT = /\.(?:png|jpe?g|gif|webp)$/i;
const VIDEO_EXT = /\.(?:mp4|webm|mov|m4v)$/i;

function kindOfName(name: string): MarkdownMediaKind | null {
  if (IMAGE_EXT.test(name)) return "image";
  if (VIDEO_EXT.test(name)) return "video";
  return null;
}

/** The media an http(s) URL shows: its path's extension, else the label's. Null for anything else. */
export function markdownMediaKind(src: string, label = ""): MarkdownMediaKind | null {
  let url: URL;
  try {
    url = new URL(src.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  return kindOfName(url.pathname) ?? kindOfName(label.trim());
}

function textOf(node: HastNode): string {
  if (node.type === "text") return node.value ?? "";
  return (node.children ?? []).map(textOf).join("");
}

/**
 * Rehype plugin: replace a link to media ({@link markdownMediaKind}) with an
 * `<img>` whose alt is the link label ("" for a bare URL). Code is never
 * touched: GFM does not autolink inside it.
 */
export function rehypeMediaLinks() {
  return (tree: HastNode) => {
    const visit = (node: HastNode) => {
      if (!node.children) return;
      node.children = node.children.map((child) => {
        const href = child.properties?.href;
        if (child.type === "element" && child.tagName === "a" && typeof href === "string") {
          const label = textOf(child).trim();
          if (markdownMediaKind(href, label)) {
            return {
              type: "element",
              tagName: "img",
              properties: { src: href, alt: label === href ? "" : label },
              children: [],
            };
          }
        }
        visit(child);
        return child;
      });
    };
    visit(tree);
  };
}
