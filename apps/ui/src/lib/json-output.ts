// Task output that is a JSON document (a structured-output completion, or an
// agent replying with a lone ```json block) renders as a JSON tree in the
// sessions view instead of a markdown blob. Everything else stays markdown.

export type JsonContainer = Record<string, unknown> | unknown[];

const FENCED_JSON = /^```json[ \t]*\r?\n([\s\S]*?)\r?\n?```$/i;

/**
 * Returns the parsed object or array when `text` is a JSON document: the
 * whole trimmed text, or one fenced ```json block with nothing around it.
 * Returns null for prose, markdown, scalars (`42`, `"hi"`, `true`) and
 * malformed JSON.
 */
export function parseJsonOutput(text: string | null | undefined): JsonContainer | null {
  if (!text) return null;
  const trimmed = text.trim();
  const fenced = FENCED_JSON.exec(trimmed);
  const body = (fenced ? fenced[1] : trimmed).trim();
  if (!body.startsWith("{") && !body.startsWith("[")) return null;
  try {
    const parsed: unknown = JSON.parse(body);
    return typeof parsed === "object" && parsed !== null ? (parsed as JsonContainer) : null;
  } catch {
    return null;
  }
}

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;

/** `["items", 0, "first name"]` -> `items[0]["first name"]`. */
export function formatJsonPath(path: ReadonlyArray<string | number>): string {
  let out = "";
  for (const segment of path) {
    if (typeof segment === "number") out += `[${segment}]`;
    else if (IDENTIFIER.test(segment)) out += out ? `.${segment}` : segment;
    else out += `[${JSON.stringify(segment)}]`;
  }
  return out;
}

/** Clipboard text for one node: strings copy bare, everything else as JSON. */
export function jsonValueToClipboard(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value, null, 2);
}
