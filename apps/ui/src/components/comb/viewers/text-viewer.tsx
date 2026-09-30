import { Info } from "lucide-react";
import { AlertCallout } from "@/components/ui/alert-callout";
import { splitTextLines, TEXT_VIEWER_MAX_LINES } from "@/lib/comb/text-lines";
import type { ViewerProps } from "./file-viewer";
import { TextGate } from "./text-gate";

export { TEXT_VIEWER_MAX_LINES };

/**
 * Plain text, one row per line: `data-line-start` / `data-line-end` carry the
 * 1-based line number, and the line text is one plain text node (comments
 * anchor on it). The gutter is `data-comb-skip`, so it is not document text.
 * No syntax highlighting in v1.
 */
export function TextLines({ text }: { text: string }) {
  const { shown, total, truncated } = splitTextLines(text);
  const gutterWidth = `${String(shown.length).length + 2}ch`;

  return (
    <div className="flex flex-col">
      {truncated ? (
        <div className="p-3" data-comb-skip>
          <AlertCallout tone="info" icon={Info}>
            Showing the first {TEXT_VIEWER_MAX_LINES.toLocaleString()} of {total.toLocaleString()}{" "}
            lines. Download the file to read all of it.
          </AlertCallout>
        </div>
      ) : null}
      <div className="min-w-max py-2 font-mono text-xs leading-5">
        {shown.map((line, index) => (
          // Lines are positional and never reorder, so the index is a stable key.
          <div key={index} data-line-start={index + 1} data-line-end={index + 1} className="flex">
            <span
              aria-hidden
              data-comb-skip
              className="sticky left-0 shrink-0 select-none bg-card pr-3 text-right text-muted-foreground"
              style={{ width: gutterWidth }}
            >
              {index + 1}
            </span>
            <span className="whitespace-pre pr-6">{line}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/** Code and other text files (HTML included: Comb shows the source, never renders it). */
export default function TextViewer({ file, stat }: ViewerProps) {
  return (
    <TextGate file={file} stat={stat}>
      {(text) => <TextLines text={text} />}
    </TextGate>
  );
}
