// The outline of a markdown file: its h1 to h4 headings, each with the source
// line of its text. The viewer stamps the same line on the rendered heading
// (`data-line-start`, see `rehype-source-lines.ts`), so a line finds its
// heading in the page.
//
// A line scanner, not a full parser. It knows fenced and indented code, ATX
// and setext headings, thematic breaks, and paragraphs. It skips block
// quotes, list item lines, and HTML blocks (a heading there is rare).
//
// Relative imports only: `bun:test` runs this from the repo root.

export interface OutlineHeading {
  /** 1 to 4. A `=` underline is 1, a `-` underline is 2. */
  level: number;
  /** The heading as plain text (inline markdown removed). */
  text: string;
  /** 1-based source line of the heading text (the first text line of a setext heading). */
  line: number;
}

/** Deeper headings stay out of the outline. */
export const OUTLINE_MAX_LEVEL = 4;

/** A file with fewer headings than this has no outline. */
export const OUTLINE_MIN_HEADINGS = 2;

const BLANK = /^[ \t]*$/;
const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const ATX = /^ {0,3}(#{1,6})(?=[ \t]|$)(.*)$/;
const SETEXT_UNDERLINE = /^ {0,3}(=+|-+)[ \t]*$/;
const THEMATIC_BREAK = /^ {0,3}(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$/;
const INDENTED_CODE = /^(?: {4}|\t)/;
const BLOCK_QUOTE = /^ {0,3}>/;
const LIST_ITEM = /^ {0,3}(?:[-+*]|\d{1,9}[.)])(?:[ \t]|$)/;
// A list item that can end a paragraph: a bullet or "1." with content.
const INTERRUPTING_LIST_ITEM = /^ {0,3}(?:[-+*]|1[.)])[ \t]+\S/;
const HTML_BLOCK = /^ {0,3}<[a-zA-Z/!?]/;

/** The h1 to h4 headings of a markdown document, in order. */
export function extractOutline(markdown: string): OutlineHeading[] {
  const headings: OutlineHeading[] = [];
  const lines = markdown.split(/\r\n|\r|\n/);
  // The open fence (its character and length), or null outside code.
  let fence: { char: string; length: number } | null = null;
  // The paragraph that a setext underline turns into a heading.
  let paragraph: { line: number; text: string[] } | null = null;
  // Inside a list item, a block quote, or an HTML block: until a blank line,
  // its lines never start a paragraph.
  let container = false;

  const push = (level: number, raw: string, line: number) => {
    const text = plainHeadingText(raw);
    if (level <= OUTLINE_MAX_LEVEL && text) headings.push({ level, text, line });
  };

  for (const [index, line] of lines.entries()) {
    const lineNumber = index + 1;
    if (fence) {
      const close = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(line);
      if (close?.[1] && close[1][0] === fence.char && close[1].length >= fence.length) {
        fence = null;
      }
      continue;
    }
    if (BLANK.test(line)) {
      paragraph = null;
      container = false;
      continue;
    }
    const open = FENCE_OPEN.exec(line);
    // A backtick fence's info string has no backticks.
    if (open?.[1] && !(open[1][0] === "`" && open[2]?.includes("`"))) {
      fence = { char: open[1][0] as string, length: open[1].length };
      paragraph = null;
      continue;
    }
    if (paragraph) {
      const underline = SETEXT_UNDERLINE.exec(line);
      if (underline?.[1]) {
        push(underline[1][0] === "=" ? 1 : 2, paragraph.text.join(" "), paragraph.line);
        paragraph = null;
        continue;
      }
    }
    const atx = ATX.exec(line);
    if (atx?.[1]) {
      push(atx[1].length, stripClosingHashes(atx[2] ?? ""), lineNumber);
      paragraph = null;
      continue;
    }
    if (THEMATIC_BREAK.test(line)) {
      paragraph = null;
      container = false;
      continue;
    }
    if (paragraph && (BLOCK_QUOTE.test(line) || INTERRUPTING_LIST_ITEM.test(line))) {
      // A block quote or a list ends the paragraph: a `---` after it is a rule.
      paragraph = null;
      container = true;
      continue;
    }
    if (paragraph) {
      // A continuation line, lazy or not.
      paragraph.text.push(line.trim());
      continue;
    }
    if (BLOCK_QUOTE.test(line) || LIST_ITEM.test(line) || HTML_BLOCK.test(line)) {
      container = true;
      continue;
    }
    if (container || INDENTED_CODE.test(line)) continue;
    paragraph = { line: lineNumber, text: [line.trim()] };
  }
  return headings;
}

/** `## Title ##` has the text "Title". `# C#` keeps its "#": the closing run needs a space before it. */
function stripClosingHashes(content: string): string {
  return content
    .trim()
    .replace(/(^|[ \t])#+$/, "")
    .trim();
}

const ESCAPE = /\\([!-/:-@[-`{-~])/g;
const ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&nbsp;": " ",
};

/**
 * Heading markdown as the reader sees it: code spans keep their text, links
 * and images keep their label, emphasis marks, HTML tags, and backslash
 * escapes go.
 */
export function plainHeadingText(raw: string): string {
  // Escaped characters and code spans are literal: park them in private-use
  // characters so the rules below cannot touch them.
  const parked: string[] = [];
  const park = (text: string) => {
    parked.push(text);
    return String.fromCharCode(0xe000 + parked.length - 1);
  };
  let text = raw
    .replace(ESCAPE, (_, char: string) => park(char))
    .replace(/(`+)(.+?)\1/g, (_, _ticks: string, code: string) => park(code.trim()));
  text = text
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]*)\]\[[^\]]*\]/g, "$1")
    .replace(/<((?:https?|mailto):[^>\s]+)>/g, "$1")
    .replace(/<\/?[a-zA-Z][^>]*>/g, "")
    .replace(/(\*\*|__)(?=\S)(.+?)(?<=\S)\1/g, "$2")
    .replace(/~~(?=\S)(.+?)(?<=\S)~~/g, "$1")
    .replace(/\*(?=\S)(.+?)(?<=\S)\*/g, "$1")
    .replace(/(^|[^\p{L}\p{N}_])_(?=\S)(.+?)(?<=\S)_(?![\p{L}\p{N}_])/gu, "$1$2")
    .replace(/&(?:amp|lt|gt|quot|#39|nbsp);/g, (entity) => ENTITIES[entity] ?? entity);
  return text
    .replace(/[-]/g, (char) => parked[char.charCodeAt(0) - 0xe000] ?? char)
    .replace(/\s+/g, " ")
    .trim();
}

/** True when the headings make an outline worth showing. */
export function hasOutline(headings: readonly OutlineHeading[]): boolean {
  return headings.length >= OUTLINE_MIN_HEADINGS;
}

/**
 * The heading the reader is in (scroll spy). `tops` are the headings' top
 * edges, measured from the top of the visible pane (null: not in the page).
 * The active heading is the last one at or above `threshold`. At the end of
 * the pane (`atEnd`) it is the last one that shows (above `height`), so a
 * short last section can still be active. Before the first heading, the
 * first heading is active. -1 when no heading is in the page.
 */
export function activeHeadingIndex(
  tops: readonly (number | null)[],
  options: { threshold: number; height: number; atEnd: boolean },
): number {
  let active = -1;
  let first = -1;
  for (const [index, top] of tops.entries()) {
    if (top === null) continue;
    if (first === -1) first = index;
    const limit = options.atEnd ? options.height : options.threshold;
    if (top <= limit) active = index;
  }
  return active === -1 ? first : active;
}
