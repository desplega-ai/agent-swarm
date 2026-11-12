// Smart paste for the composer: what a plain-text paste turns into.
//
// Relative imports only: `bun:test` runs this from the repo root.

/** Past this, a paste becomes a `.txt` attachment (about 2k tokens at 4 chars each). */
export const LONG_PASTE_CHARS = 8000;
export const LONG_PASTE_LINES = 80;

export function isLongPaste(text: string): boolean {
  return text.length > LONG_PASTE_CHARS || text.split("\n").length > LONG_PASTE_LINES;
}

/**
 * A spreadsheet copy (tab-separated, at least two rows, the same number of
 * columns on every row) as a markdown table with the first row as its header.
 * Null for anything else.
 */
export function tsvToMarkdownTable(text: string): string | null {
  const rows = text
    .replace(/\r\n?/g, "\n")
    .replace(/\n+$/, "")
    .split("\n")
    .map((line) => line.split("\t"));
  const columns = rows[0]?.length ?? 0;
  if (rows.length < 2 || columns < 2 || rows.some((row) => row.length !== columns)) return null;
  const line = (cells: string[]) =>
    `| ${cells.map((cell) => cell.trim().replace(/\|/g, "\\|")).join(" | ")} |`;
  const [header, ...body] = rows;
  return [line(header), line(header.map(() => "---")), ...body.map(line)].join("\n");
}

/** The pasted text when it is one http(s) URL and nothing else. */
export function pastedUrl(text: string): string | null {
  const trimmed = text.trim();
  if (!/^https?:\/\/\S+$/i.test(trimmed)) return null;
  try {
    new URL(trimmed);
    return trimmed;
  } catch {
    return null;
  }
}

/** A URL pasted over selected text: the selection becomes the link text. */
export function linkOverSelection(selection: string, url: string): string {
  return `[${selection.replace(/[\\[\]]/g, "\\$&")}](${url.replace(/[()]/g, (paren) => (paren === "(" ? "%28" : "%29"))})`;
}

/** The name for the Nth pasted-text attachment. */
export function pastedFileName(existing: readonly { name: string }[]): string {
  let n = 1;
  while (existing.some((file) => file.name === `pasted-${n}.txt`)) n++;
  return `pasted-${n}.txt`;
}
