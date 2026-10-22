// A one-line plain-text preview of markdown (LLM output): no fences, marks,
// link targets, or HTML. The full text still renders through Streamdown.

export function markdownPreview(markdown: string): string {
  return (
    markdown
      .replace(/```[^\n]*\n?/g, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
      .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+[.)])\s+/gm, "")
      // A mark counts only outside a word, so snake_case names stay whole.
      .replace(/(^|\W)(\*\*|__|\*|_|~~|`)(\S(?:.*?\S)?)\2(?=\W|$)/g, "$1$3")
      .replace(/\s+/g, " ")
      .trim()
  );
}
