// The line model behind `TextLines` (`components/comb/viewers/text-viewer.tsx`).

/** Longer files show this many lines and a notice to download the rest. */
export const TEXT_VIEWER_MAX_LINES = 20_000;

/**
 * Split a file into its lines (LF or CRLF). A final newline ends the last
 * line. It does not start a new one. `shown` holds the first
 * `TEXT_VIEWER_MAX_LINES` lines, `total` counts all of them.
 */
export function splitTextLines(text: string): {
  shown: string[];
  total: number;
  truncated: boolean;
} {
  const lines = text.split(/\r?\n/);
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  const truncated = lines.length > TEXT_VIEWER_MAX_LINES;
  return {
    shown: truncated ? lines.slice(0, TEXT_VIEWER_MAX_LINES) : lines,
    total: lines.length,
    truncated,
  };
}
