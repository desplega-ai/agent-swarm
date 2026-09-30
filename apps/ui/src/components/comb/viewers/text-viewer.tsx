import { Info } from "lucide-react";
import { Highlight, type RenderProps, type Token } from "prism-react-renderer";
import { memo, useDeferredValue, useMemo } from "react";
import { AlertCallout } from "@/components/ui/alert-callout";
import { useTheme } from "@/hooks/use-theme";
import { HIGHLIGHT_MAX_CHARS, prismLanguageForPath } from "@/lib/comb/code-language";
import { splitTextLines, TEXT_VIEWER_MAX_LINES } from "@/lib/comb/text-lines";
import { LineTokens, prismTheme } from "./code-tokens";
import type { ViewerProps } from "./file-viewer";
import { TextGate } from "./text-gate";

export { TEXT_VIEWER_MAX_LINES };

/**
 * Text, one row per line: `data-line-start` / `data-line-end` carry the
 * 1-based line number, and the row's text is the line's text (comments anchor
 * on it). The gutter is `data-comb-skip`, so it is not document text.
 *
 * `language` (a Prism grammar, see `lib/comb/code-language.ts`) highlights
 * the rows. The plain rows paint first and Prism runs in a background render.
 * The highlighted rows hold the same text in the same boxes, so nothing moves
 * when they arrive. Text over `HIGHLIGHT_MAX_CHARS` stays plain.
 * Memoized: a file view re-render (a `?c=` change) does not rebuild the rows.
 */
export const TextLines = memo(function TextLines({
  text,
  language = null,
}: {
  text: string;
  language?: string | null;
}) {
  const { theme } = useTheme();
  const { shown, total, truncated } = useMemo(() => splitTextLines(text), [text]);
  const code = useMemo(() => shown.join("\n"), [shown]);
  const tooLarge = language !== null && text.length > HIGHLIGHT_MAX_CHARS;
  const highlighted = useDeferredValue(tooLarge ? null : language, null);
  const gutterWidth = `${String(shown.length).length + 2}ch`;
  const notice = [
    truncated &&
      `Showing the first ${TEXT_VIEWER_MAX_LINES.toLocaleString()} of ${total.toLocaleString()} lines. Download the file to read all of it.`,
    tooLarge && `Syntax highlighting is off for files over ${HIGHLIGHT_MAX_CHARS / 1024} KiB.`,
  ]
    .filter(Boolean)
    .join(" ");

  const rows = (tokens: Token[][] | null, getTokenProps?: RenderProps["getTokenProps"]) =>
    shown.map((line, index) => (
      // Lines are positional and never reorder, so the index is a stable key.
      // `data-comb-row`: the row adds one "\n" to the text space, blank rows too,
      // so a comment quote is verbatim file text (step-7, `TEXT_ROW_ATTR`).
      <div
        key={index}
        data-line-start={index + 1}
        data-line-end={index + 1}
        data-comb-row=""
        className="flex"
      >
        <span
          aria-hidden
          data-comb-skip
          className="sticky left-0 shrink-0 select-none bg-card pr-3 text-right text-muted-foreground"
          style={{ width: gutterWidth }}
        >
          {index + 1}
        </span>
        <span className="whitespace-pre pr-6">
          {tokens && getTokenProps ? (
            <LineTokens line={tokens[index]} getTokenProps={getTokenProps} />
          ) : (
            line
          )}
        </span>
      </div>
    ));

  return (
    <div className="flex flex-col">
      {notice ? (
        <div className="p-3" data-comb-skip>
          <AlertCallout tone="info" icon={Info}>
            {notice}
          </AlertCallout>
        </div>
      ) : null}
      {highlighted ? (
        <Highlight code={code} language={highlighted} theme={prismTheme(theme)}>
          {({ tokens, getTokenProps }) =>
            // Prism also splits on a lone CR, which `splitTextLines` keeps
            // inside a line. Then the lines do not match: stay plain.
            tokens.length === shown.length ? (
              <div
                className="min-w-max py-2 font-mono text-xs leading-5"
                style={{ color: prismTheme(theme).plain.color }}
              >
                {rows(tokens, getTokenProps)}
              </div>
            ) : (
              <div className="min-w-max py-2 font-mono text-xs leading-5">{rows(null)}</div>
            )
          }
        </Highlight>
      ) : (
        <div className="min-w-max py-2 font-mono text-xs leading-5">{rows(null)}</div>
      )}
    </div>
  );
});

/** Code and other text files (HTML included: Comb shows the source, never renders it). */
export default function TextViewer({ file, stat }: ViewerProps) {
  return (
    <TextGate file={file} stat={stat}>
      {(text) => <TextLines text={text} language={prismLanguageForPath(file.path)} />}
    </TextGate>
  );
}
