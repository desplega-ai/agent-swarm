/**
 * Bounded single-line text for values that can be arbitrarily large (json
 * columns, template substitutions, card titles). No imports, so every pure
 * helper module can share it under `bun test`.
 */

/** Longest `JSON.stringify` preview a cell, field or template piece shows. */
export const JSON_PREVIEW_MAX_CHARS = 120;

/** `text` cut to `max` characters, with an ellipsis when it was longer. */
export function truncateText(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** Compact single-line JSON preview, truncated to `JSON_PREVIEW_MAX_CHARS`. */
export function jsonPreview(value: unknown): string {
  return truncateText(JSON.stringify(value) ?? String(value), JSON_PREVIEW_MAX_CHARS);
}
