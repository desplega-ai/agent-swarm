// Leading YAML frontmatter for Comb's markdown preview. Only a block that opens
// on the file's first line counts: a `---` later in the document stays a rule.
//
// The block's lines become blank lines in the body instead of being cut, so
// every block below it keeps the file's own line numbers
// (`rehype-source-lines.ts`, comment anchors).

import { parse } from "yaml";

/** One top-level key and its value, formatted for display. */
export interface FrontmatterEntry {
  key: string;
  value: string;
}

export interface Frontmatter {
  /** The YAML between the fences, without them. */
  raw: string;
  /** The parsed top-level keys, or `null` when the YAML is not a mapping. */
  entries: FrontmatterEntry[] | null;
  /** Why `entries` is `null` (a parse error, or a scalar or list at the top level). */
  error: string | null;
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
  if (raw.trim() === "") return { raw, entries: [], error: null };
  let data: unknown;
  try {
    data = parse(raw);
  } catch (err) {
    return {
      raw,
      entries: null,
      error: firstLine(err instanceof Error ? err.message : String(err)),
    };
  }
  if (data === null || data === undefined) return { raw, entries: [], error: null };
  if (typeof data !== "object" || Array.isArray(data)) {
    return { raw, entries: null, error: "Frontmatter is not a key/value mapping" };
  }
  const entries = Object.entries(data as Record<string, unknown>).map(([key, value]) => ({
    key,
    value: formatValue(value),
  }));
  return { raw, entries, error: null };
}

function firstLine(message: string): string {
  return message.split("\n")[0] ?? message;
}

/** Scalars as text, a list of scalars comma-joined, anything nested as JSON. */
export function formatValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return value.toISOString();
  if (typeof value !== "object") return String(value);
  if (Array.isArray(value) && value.every((item) => item === null || typeof item !== "object")) {
    return value.map((item) => (item === null ? "" : String(item))).join(", ");
  }
  return JSON.stringify(value);
}
