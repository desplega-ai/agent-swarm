import { jsonPreview, truncateText } from "./json-preview";

/** Longest text a `format` template produces; past it the cell ends in `…`. */
export const TEMPLATE_MAX_CHARS = 500;

/** `{{key}}` placeholders: word characters and dots only (no hyphens or spaces). */
const PLACEHOLDER = /\{\{\s*([\w.]+)\s*\}\}/g;

/**
 * `TableColumn.format` — combine several row fields into one cell.
 *
 * - `{{key}}` (whitespace inside the braces allowed, key matching `[\w.]+`)
 *   is replaced by the row's own `row[key]`, looked up flat: a dotted key
 *   such as `{{owner.name}}` reads the literal `"owner.name"` column, never a
 *   nested path, and inherited names (`{{constructor}}`) read nothing.
 * - `null` / `undefined` (including a missing field) → empty string.
 * - objects and arrays → the same truncated JSON preview as the `json` kind;
 *   everything else → `String(value)`. No per-field `kind` formatting.
 * - text without a well-formed placeholder is returned unchanged, and the
 *   whole result is capped at `TEMPLATE_MAX_CHARS`.
 */
export function applyTemplate(template: string, row: Record<string, unknown>): string {
  const text = template.replace(PLACEHOLDER, (_match, key: string) => {
    const value = Object.hasOwn(row, key) ? row[key] : undefined;
    if (value === null || value === undefined) return "";
    if (typeof value === "object") return jsonPreview(value);
    return String(value);
  });
  return truncateText(text, TEMPLATE_MAX_CHARS);
}
