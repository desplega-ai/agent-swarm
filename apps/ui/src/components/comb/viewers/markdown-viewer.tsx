import { useAgentFs } from "@/contexts/agent-fs-context";
import { CombLiveUrlContext, CombMarkdown } from "./comb-markdown";
import type { ViewerProps } from "./file-viewer";
import { TextGate } from "./text-gate";

/**
 * Markdown files, rendered. Every block carries `data-line-start` /
 * `data-line-end` (see `comb-markdown.tsx`). Relative links and agent-fs live
 * links stay in Comb.
 */
export default function MarkdownViewer({ file, stat }: ViewerProps) {
  const { liveUrl } = useAgentFs();
  return (
    <TextGate file={file} stat={stat}>
      {(text) => (
        <article className="mx-auto max-w-4xl px-6 py-5 text-sm leading-relaxed">
          <CombLiveUrlContext.Provider value={liveUrl}>
            <CombMarkdown text={text} doc={file} />
          </CombLiveUrlContext.Provider>
        </article>
      )}
    </TextGate>
  );
}
