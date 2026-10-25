import { useCallback, useState } from "react";
import { useAgentFsMediaUrl } from "@/api/hooks/use-agent-fs";
import { useCombLayout } from "@/components/comb/comb-layout";
import { useAgentFs } from "@/contexts/agent-fs-context";
import { useConfig } from "@/hooks/use-config";
import { useTheme } from "@/hooks/use-theme";
import { browserStorage } from "@/lib/comb/drafts";
import { readPropertiesOpen, writePropertiesOpen } from "@/lib/comb/panels";
import { cn } from "@/lib/utils";
import { AssetFrame } from "./asset-frame";
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
  // Full width drops the reading measure: the text runs as wide as the pane.
  const fullWidth = useCombLayout()?.fullWidth ?? false;
  const [propertiesOpen, setPropertiesOpen] = usePropertiesOpen();
  return (
    <TextGate file={file} stat={stat}>
      {(text) => (
        <article
          className={cn(
            "prose-doc mx-auto px-6 py-5",
            fullWidth ? "max-w-none md:px-12" : "max-w-[72ch]",
          )}
        >
          <CombMarkdown
            text={text}
            doc={file}
            DriveImage={DriveImage}
            AssetFrame={AssetFrame}
            liveUrl={liveUrl}
            codeTheme={theme}
            propertiesOpen={propertiesOpen}
            onPropertiesOpenChange={setPropertiesOpen}
          />
        </article>
      )}
    </TextGate>
  );
}

/** The frontmatter block's open state, stored in this browser for every file. */
function usePropertiesOpen(): [boolean, (open: boolean) => void] {
  const { apiUrl } = useConfig().config;
  const [open, setOpen] = useState(() => readPropertiesOpen(browserStorage(), apiUrl));
  const update = useCallback(
    (next: boolean) => {
      setOpen(next);
      writePropertiesOpen(browserStorage(), apiUrl, next);
    },
    [apiUrl],
  );
  return [open, update];
}

/**
 * A relative image in the markdown, loaded like the image viewer loads it
 * (`useAgentFsMediaUrl`, so blob-mode bytes go through `blobUrlPlan`).
 */
function DriveImage({ file, alt, fallback, lines }: DriveImageProps) {
  const media = useAgentFsMediaUrl(file, "image");
  // The URL that the element could not show. A new URL (a new version) tries again.
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  if (media.url === null || media.url === failedUrl) return fallback;
  const url = media.url;
  return (
    <AssetFrame asset={{ kind: "image", src: url, alt, file }} lines={lines}>
      <img
        src={url}
        alt={alt}
        onError={() => setFailedUrl(url)}
        className="my-4 inline-block max-w-full rounded-lg"
      />
    </AssetFrame>
  );
}
