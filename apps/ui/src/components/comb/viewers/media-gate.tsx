import { FileWarning } from "lucide-react";
import { type ReactNode, useState } from "react";
import { useAgentFsMediaUrl } from "@/api/hooks/use-agent-fs";
import { DownloadButton, OpenInAgentFsButton } from "@/components/comb/file-actions";
import { EmptyState } from "@/components/shared/empty-state";
import type { MediaKind } from "@/lib/comb/media";
import FallbackViewer from "./fallback-viewer";
import type { ViewerProps } from "./file-viewer";
import { ViewerSkeleton } from "./viewer-skeleton";

/** What the error title calls the file. */
const MEDIA_NOUNS: Record<MediaKind, string> = { image: "image", video: "video", pdf: "PDF" };

/**
 * Load a media URL for the file and pass it to `children`, with an `onError`
 * for the media element. Owns the loading state, the "too large" fallback
 * (blob mode only), and the error state (Download and "Open in agent-fs"), so
 * media viewers render the element only.
 *
 * A PDF frame cannot report load errors (an `<iframe>` has no error event).
 * For a PDF, the error state covers loading the URL only (the `signed-url`
 * call, or the bytes in blob mode).
 */
export function MediaGate({
  file,
  stat,
  kind,
  children,
}: ViewerProps & {
  kind: MediaKind;
  children: (url: string, onError: () => void) => ReactNode;
}) {
  const media = useAgentFsMediaUrl(file, kind);
  // The URL that the element could not show. A new URL (a new version) tries again.
  const [failedUrl, setFailedUrl] = useState<string | null>(null);

  if (media.tooLarge) return <FallbackViewer file={file} stat={stat} tooLarge />;
  if (media.error || (media.url !== null && media.url === failedUrl)) {
    return (
      <EmptyState
        icon={FileWarning}
        title={`Could not show this ${MEDIA_NOUNS[kind]}`}
        description={
          media.error?.message ?? "The browser cannot display this file. Download it instead."
        }
        action={
          <>
            <DownloadButton file={file} variant="default" />
            <OpenInAgentFsButton target={file} />
          </>
        }
      />
    );
  }
  if (media.url === null) return <ViewerSkeleton />;
  const url = media.url;
  return children(url, () => setFailedUrl(url));
}
