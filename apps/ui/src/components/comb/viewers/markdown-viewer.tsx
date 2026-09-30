import { useState } from "react";
import { useAgentFsMediaUrl } from "@/api/hooks/use-agent-fs";
import { useAgentFs } from "@/contexts/agent-fs-context";
import { useTheme } from "@/hooks/use-theme";
import { CombMarkdown, type DriveImageProps } from "./comb-markdown";
import type { ViewerProps } from "./file-viewer";
import { TextGate } from "./text-gate";

/**
 * Markdown files, rendered. Every block carries `data-line-start` /
 * `data-line-end` (see `comb-markdown.tsx`). Relative links and agent-fs live
 * links stay in Comb.
 */
export default function MarkdownViewer({ file, stat }: ViewerProps) {
  const { liveUrl } = useAgentFs();
  const { theme } = useTheme();
  return (
    <TextGate file={file} stat={stat}>
      {(text) => (
        <article className="prose-doc mx-auto max-w-[72ch] px-6 py-5">
          <CombMarkdown
            text={text}
            doc={file}
            DriveImage={DriveImage}
            liveUrl={liveUrl}
            codeTheme={theme}
          />
        </article>
      )}
    </TextGate>
  );
}

/**
 * A relative image in the markdown, loaded like the image viewer loads it
 * (`useAgentFsMediaUrl`, so blob-mode bytes go through `blobUrlPlan`).
 */
function DriveImage({ file, alt, fallback }: DriveImageProps) {
  const media = useAgentFsMediaUrl(file, "image");
  // The URL that the element could not show. A new URL (a new version) tries again.
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  if (media.url === null || media.url === failedUrl) return fallback;
  const url = media.url;
  return (
    <img
      src={url}
      alt={alt}
      onError={() => setFailedUrl(url)}
      className="my-4 inline-block max-w-full rounded-lg"
    />
  );
}
