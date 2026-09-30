// Ported from agent-fs `live/src/lib/dom-text-space.ts` (`rehypeSourceLines`,
// v0.14.0). Comb renders the whole document at once (Streamdown
// `mode="static"`), so positions are document-absolute and there is no
// frontmatter offset.

interface HastNode {
  type: string;
  tagName?: string;
  properties?: Record<string, unknown>;
  position?: { start: { line: number }; end: { line: number } };
  children?: HastNode[];
}

const LINE_TAGS = new Set([
  "p",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "li",
  "blockquote",
  "pre",
  "tr",
  "table",
  "hr",
]);

/**
 * Rehype plugin: stamp block elements with the source lines they came from
 * (`data-line-start` / `data-line-end`), so comments map to and from source
 * line ranges.
 */
export function rehypeSourceLines() {
  return (tree: HastNode) => {
    const visit = (node: HastNode) => {
      if (node.type === "element" && node.tagName && LINE_TAGS.has(node.tagName) && node.position) {
        node.properties = {
          ...node.properties,
          dataLineStart: node.position.start.line,
          dataLineEnd: node.position.end.line,
        };
      }
      node.children?.forEach(visit);
    };
    visit(tree);
  };
}
