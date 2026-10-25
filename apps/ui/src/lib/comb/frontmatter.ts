// Leading YAML frontmatter for Comb's markdown preview. Only a block that opens
// on the file's first line counts: a `---` later in the document stays a rule.
//
// The block's lines become blank lines in the body instead of being cut, so
// every block below it keeps the file's own line numbers
// (`rehype-source-lines.ts`, comment anchors).

import { parse, stringify } from "yaml";

/** A value as Comb shows it: text, a list of chips, or a nested block. */
export type FrontmatterValue =
  | { kind: "text"; text: string }
  | { kind: "list"; items: string[] }
  | { kind: "block"; text: string };

/** One top-level key and its value. */
export interface FrontmatterEntry {
  key: string;
  value: FrontmatterValue;
}

export interface Frontmatter {
  /** The YAML between the fences, without them. */
  raw: string;
  /** The top-level keys, or `null` when neither YAML nor the line reading finds any. */
  entries: FrontmatterEntry[] | null;
  /** Why the YAML did not parse, or why it is not a mapping. Also set when `lenient`. */
  error: string | null;
  /**
   * The YAML did not parse, and `entries` come from reading it line by line
   * (`key: rest of the line`). Agents often write values with ": " in them.
   */
  lenient: boolean;
}

export interface SplitFrontmatter {
  frontmatter: Frontmatter | null;
  /** The markdown to render: the frontmatter lines are blank, the rest is unchanged. */
  body: string;
}

const OPEN_RE = /^---[ \t]*$/;
const CLOSE_RE = /^(?:---|\.\.\.)[ \t]*$/;

/** Split a leading `---` YAML block off a markdown file. */
export function splitFrontmatter(text: string): SplitFrontmatter {
  const bom = text.startsWith("\uFEFF") ? "\uFEFF" : "";
  const lines = text.slice(bom.length).split("\n");
  if (!OPEN_RE.test(stripCr(lines[0] ?? ""))) return { frontmatter: null, body: text };
  const close = lines.findIndex((line, i) => i > 0 && CLOSE_RE.test(stripCr(line)));
  // An unclosed fence is not frontmatter: it renders as markdown, as before.
  if (close === -1) return { frontmatter: null, body: text };

  const raw = lines.slice(1, close).map(stripCr).join("\n");
  const body = lines.map((line, i) => (i <= close ? "" : line)).join("\n");
  return { frontmatter: parseFrontmatter(raw), body };
}

function stripCr(line: string): string {
  return line.endsWith("\r") ? line.slice(0, -1) : line;
}

function parseFrontmatter(raw: string): Frontmatter {
  if (raw.trim() === "") return { raw, entries: [], error: null, lenient: false };
  let data: unknown;
  try {
    data = parse(raw);
  } catch (err) {
    const error = firstLine(err instanceof Error ? err.message : String(err));
    const entries = readLines(raw);
    return { raw, entries, error, lenient: entries !== null };
  }
  if (data === null || data === undefined) return { raw, entries: [], error: null, lenient: false };
  if (typeof data !== "object" || Array.isArray(data)) {
    return { raw, entries: null, error: "Frontmatter is not a key/value mapping", lenient: false };
  }
  const entries = Object.entries(data as Record<string, unknown>).map(([key, value]) => ({
    key,
    value: toValue(value),
  }));
  return { raw, entries, error: null, lenient: false };
}

function firstLine(message: string): string {
  return message.split("\n")[0] ?? message;
}

/** Scalars as text, a list of scalars as chips, anything nested as a YAML block. */
export function toValue(value: unknown): FrontmatterValue {
  if (value === null || value === undefined) return { kind: "text", text: "" };
  if (value instanceof Date) return { kind: "text", text: value.toISOString() };
  if (typeof value !== "object") return { kind: "text", text: String(value) };
  if (Array.isArray(value) && value.every((item) => item === null || typeof item !== "object")) {
    return { kind: "list", items: value.map((item) => (item === null ? "" : String(item))) };
  }
  return { kind: "block", text: stringify(value).trimEnd() };
}

// The line reading, for YAML that does not parse. Like the agent-fs live UI:
// a top-level `key:` starts an entry and the rest of the line is its value.
const KEY_RE = /^([A-Za-z_][\w.-]*)[ \t]*:(?:[ \t]+(.*?))?[ \t]*$/;
const ITEM_RE = /^[ \t]*-(?:[ \t]+(.*?))?[ \t]*$/;

function unquote(text: string): string {
  const quoted = /^(["'])(.*)\1$/.exec(text);
  return quoted ? (quoted[2] as string) : text;
}

/**
 * Read `raw` line by line: `key: value` at the start of a line, `- item`
 * lines and `[a, b]` as lists, and other indented lines as more of the value
 * (a nested block when the key has no value of its own). Null when no line
 * names a key.
 */
export function readLines(raw: string): FrontmatterEntry[] | null {
  const found: { key: string; inline: string; rest: string[] }[] = [];
  for (const line of raw.split("\n")) {
    if (line.trim() === "" || line.trimStart().startsWith("#")) continue;
    const key = KEY_RE.exec(line);
    if (key) found.push({ key: key[1] as string, inline: key[2] ?? "", rest: [] });
    // A line before the first key is skipped.
    else found[found.length - 1]?.rest.push(line);
  }
  if (found.length === 0) return null;
  return found.map(({ key, inline, rest }): FrontmatterEntry => {
    if (inline) {
      const list = /^\[(.*)\]$/.exec(inline);
      if (list && rest.length === 0) {
        const items = (list[1] as string).split(",").map((item) => unquote(item.trim()));
        return { key, value: { kind: "list", items: items.filter(Boolean) } };
      }
      // Lines under a value continue it (a folded line).
      const text = [unquote(inline), ...rest.map((line) => line.trim())].join(" ");
      return { key, value: { kind: "text", text } };
    }
    const items = rest.map((line) => ITEM_RE.exec(line));
    if (rest.length > 0 && items.every(Boolean)) {
      return { key, value: { kind: "list", items: items.map((item) => unquote(item?.[1] ?? "")) } };
    }
    if (rest.length > 0) return { key, value: { kind: "block", text: dedent(rest).join("\n") } };
    return { key, value: { kind: "text", text: "" } };
  });
}

function dedent(lines: string[]): string[] {
  const indent = Math.min(...lines.map((line) => line.length - line.trimStart().length));
  return lines.map((line) => line.slice(indent));
}
