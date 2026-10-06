/** A full task id (UUID), or a hex run of 8 or more characters (a short id). */
const ID = "[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}|[0-9a-f]{8,}";

/**
 * The parts of a markdown line, in one pass. Code spans, links and URLs are
 * matched first, so an id inside a link or a URL is never touched. An id
 * stands alone: no word character, `/`, `-` or `.` on either side.
 */
const PARTS = new RegExp(
  [
    "(?<code>(?<ticks>`+)(?<body>[^`\\n]+?)\\k<ticks>(?!`))",
    "(?<link>!?\\[[^\\]\\n]*\\]\\([^)\\n]*\\))",
    "(?<url><[a-z][a-z0-9+.-]*:[^>\\s]*>|\\bhttps?:\\/\\/[^\\s<>()]+)",
    `(?<id>(?<![\\w/.#-])#?(?:${ID}))(?![\\w-]|\\.\\w)`,
  ].join("|"),
  "gi",
);

const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const LINK_DEFINITION = /^ {0,3}\[[^\]]+\]:\s/;

/** The one known id that starts with `token`, or null (unknown or ambiguous). */
function resolveId(token: string, ids: readonly string[]): string | null {
  const prefix = token.replace(/^#/, "").toLowerCase();
  if (prefix.length < 8) return null;
  const matches = new Set(ids.filter((id) => id.toLowerCase().startsWith(prefix)));
  return matches.size === 1 ? [...matches][0] : null;
}

function linkLine(line: string, ids: readonly string[]): string {
  return line.replace(PARTS, (match, ...args) => {
    const groups = args.at(-1) as Record<string, string | undefined>;
    if (groups.code !== undefined) {
      const body = (groups.body ?? "").trim();
      if (!new RegExp(`^#?(?:${ID})$`, "i").test(body)) return match;
      const id = resolveId(body, ids);
      return id ? `[${match}](/tasks/${id})` : match;
    }
    if (groups.id !== undefined) {
      const id = resolveId(groups.id, ids);
      return id ? `[${match}](/tasks/${id})` : match;
    }
    // A link, an image or a URL stays as it is.
    return match;
  });
}

/**
 * Turns task ids in markdown into links to `/tasks/{fullId}`. Only `ids` are
 * linked: a short id (8 or more hex characters, with or without `#`) links
 * when exactly one known id starts with it. It works inside and outside
 * inline code. Fenced code blocks, links, URLs and longer hex strings (commit
 * SHAs) stay as they are.
 */
export function linkTaskIds(markdown: string, ids: readonly string[]): string {
  if (ids.length === 0 || markdown.length === 0) return markdown;
  let fence: string | null = null;
  return markdown
    .split("\n")
    .map((line) => {
      const opener = FENCE.exec(line)?.[1];
      if (fence) {
        // A fence closes on a run of the same character, at least as long.
        if (opener && opener[0] === fence[0] && opener.length >= fence.length) fence = null;
        return line;
      }
      if (opener) {
        fence = opener;
        return line;
      }
      return LINK_DEFINITION.test(line) ? line : linkLine(line, ids);
    })
    .join("\n");
}
