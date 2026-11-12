// The composer's text format. `ComposerDock` keeps a plain string `value`;
// its editor shows `@` and `/` picks as chips. A chip is sent as a markdown
// link to the entity's dashboard route, `[@Researcher](/agents/<id>)` or
// `[/pr-review](/skills/<id>)`, which the thread already renders as a chip
// (`parseSwarmLink`). A mention never routes the task: the lead reads it.
//
// Relative imports only: `bun:test` runs this from the repo root.

export type MentionChar = "@" | "/";

/** A chip: its trigger, label, and dashboard href (stored as the node `id`). */
export interface MentionAttrs {
  char: MentionChar;
  label: string;
  href: string;
}

/** A Tiptap JSON doc of paragraphs holding text and mention nodes. */
export interface ComposerDocJson {
  type: "doc";
  content: Array<{
    type: "paragraph";
    content?: Array<
      | { type: "text"; text: string }
      | {
          type: "mention";
          attrs: { id: string; label: string; mentionSuggestionChar: MentionChar };
        }
    >;
  }>;
}

const escapeLabel = (label: string) => label.replace(/[\\[\]]/g, "\\$&");
const unescapeLabel = (label: string) => label.replace(/\\([\\[\]])/g, "$1");

/** A chip as the text the composer sends. */
export function mentionMarkdown({ char, label, href }: MentionAttrs): string {
  // A space or paren would end a bare destination early.
  const dest = /[\s()<>]/.test(href) ? `<${href}>` : href;
  return `[${char}${escapeLabel(label)}](${dest})`;
}

// `[@label](/route)` or `[/label](<route with spaces>)`. Only root-relative
// hrefs: a link the user typed to another site stays text.
const MENTION_LINK = /\[([@/])((?:\\[\\[\]]|[^\\[\]\n])+)\]\((?:<(\/[^<>\n]*)>|(\/[^\s()<>]*))\)/g;

/** Splits one line into text and mention parts. */
export function parseMentions(line: string): Array<string | MentionAttrs> {
  const parts: Array<string | MentionAttrs> = [];
  let last = 0;
  for (const match of line.matchAll(MENTION_LINK)) {
    if (match.index > last) parts.push(line.slice(last, match.index));
    parts.push({
      char: match[1] as MentionChar,
      label: unescapeLabel(match[2]),
      href: match[3] ?? match[4],
    });
    last = match.index + match[0].length;
  }
  if (last < line.length) parts.push(line.slice(last));
  return parts;
}

/** The composer's string as an editor doc: one paragraph per line, links as chips. */
export function composerTextToDoc(text: string): ComposerDocJson {
  return {
    type: "doc",
    content: text.split(/\r\n?|\n/).map((line) => {
      const content = parseMentions(line).map((part) =>
        typeof part === "string"
          ? { type: "text" as const, text: part }
          : {
              type: "mention" as const,
              attrs: { id: part.href, label: part.label, mentionSuggestionChar: part.char },
            },
      );
      return content.length > 0
        ? { type: "paragraph" as const, content }
        : { type: "paragraph" as const };
    }),
  };
}

/** The editor doc as the composer's string: lines joined by "\n", chips as links. */
export function composerDocToText(doc: {
  content?: Array<{
    content?: Array<{ type: string; text?: string; attrs?: Record<string, unknown> }>;
  }>;
}): string {
  return (doc.content ?? [])
    .map((block) =>
      (block.content ?? [])
        .map((node) => {
          if (node.type === "text") return node.text ?? "";
          if (node.type === "hardBreak") return "\n";
          if (node.type !== "mention") return "";
          const attrs = node.attrs ?? {};
          return mentionMarkdown({
            char: attrs.mentionSuggestionChar === "/" ? "/" : "@",
            label: String(attrs.label ?? attrs.id ?? ""),
            href: String(attrs.id ?? ""),
          });
        })
        .join(""),
    )
    .join("\n");
}
