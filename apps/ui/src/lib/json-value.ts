// Config values that hold JSON: the dialogs show them formatted and store
// them compacted (one line), so the row stays small and env export stays
// single-line.

/** The parsed value when `text` is a JSON object or array, else undefined. */
export function parseJsonContainer(text: string): Record<string, unknown> | unknown[] | undefined {
  const trimmed = text.trim();
  if (!(trimmed.startsWith("{") || trimmed.startsWith("["))) return undefined;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return parsed !== null && typeof parsed === "object"
      ? (parsed as Record<string, unknown> | unknown[])
      : undefined;
  } catch {
    return undefined;
  }
}

/** Two-space formatted JSON, or `text` unchanged when it is not a JSON container. */
export function prettyJson(text: string): string {
  const parsed = parseJsonContainer(text);
  return parsed === undefined ? text : JSON.stringify(parsed, null, 2);
}

/** One-line JSON, or `text` unchanged when it is not a JSON container. */
export function compactJson(text: string): string {
  const parsed = parseJsonContainer(text);
  return parsed === undefined ? text : JSON.stringify(parsed);
}
