import { CombMarkdown } from "./comb-markdown";
import type { ViewerProps } from "./file-viewer";
import { TextGate } from "./text-gate";

/**
 * Markdown files, rendered. Every block carries `data-line-start` /
 * `data-line-end` (see `comb-markdown.tsx`). Relative links stay in Comb.
 */
export default function MarkdownViewer({ file, stat }: ViewerProps) {
  return (
    <TextGate file={file} stat={stat}>
      {(text) => (
        <article className="mx-auto max-w-4xl px-6 py-5 text-sm leading-relaxed">
          <CombMarkdown text={text} doc={file} />
        </article>
      )}
    </TextGate>
  );
}
