/**
 * The small markdown subset the page kit renders. Everything is escaped first,
 * then a fixed set of patterns becomes markup, so no agent text can inject a
 * tag or an attribute. Links accept `https:` and in-page `#` targets only.
 */

export function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Inline markdown: `code`, **bold**, *italic* and [text](https://…). */
export function inlineMarkdown(md: unknown): string {
  let s = escapeHtml(md);
  s = s.replace(/`([^`]+)`/g, "<code>$1</code>");
  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/(^|[^*])\*([^*\s][^*]*)\*/g, "$1<em>$2</em>");
  s = s.replace(/\[([^\]]+)\]\(((?:https:\/\/|#)[^)\s]+)\)/g, '<a href="$2">$1</a>');
  return s;
}

/** Block markdown: paragraphs, `- ` and `1. ` lists, `> ` quotes and `### ` subheads. */
export function blockMarkdown(md: string): string {
  return md
    .trim()
    .split(/\n{2,}/)
    .map((block) => {
      const lines = block.split("\n");
      if (lines.every((l) => /^- /.test(l)))
        return `<ul>${lines.map((l) => `<li>${inlineMarkdown(l.slice(2))}</li>`).join("")}</ul>`;
      if (lines.every((l) => /^\d+\. /.test(l)))
        return `<ol>${lines.map((l) => `<li>${inlineMarkdown(l.replace(/^\d+\. /, ""))}</li>`).join("")}</ol>`;
      if (lines.every((l) => /^> ?/.test(l)))
        return `<blockquote><p>${inlineMarkdown(lines.map((l) => l.replace(/^> ?/, "")).join(" "))}</p></blockquote>`;
      if (/^### /.test(block)) return `<h3>${inlineMarkdown(block.slice(4))}</h3>`;
      return `<p>${inlineMarkdown(lines.join(" "))}</p>`;
    })
    .join("\n");
}

/** A URL fragment id from a title. */
export function slugId(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}
