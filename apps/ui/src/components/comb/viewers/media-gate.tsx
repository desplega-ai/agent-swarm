import { FileWarning } from "lucide-react";
import { type ReactNode, useState } from "react";
import { useAgentFsMediaUrl } from "@/api/hooks/use-agent-fs";
import { DownloadButton, OpenInAgentFsButton } from "@/components/comb/file-actions";
import { EmptyState } from "@/components/shared/empty-state";
import type { DrivePath } from "@/lib/comb/paths";
import { ViewerSkeleton } from "./viewer-skeleton";

/**
 * Load a media URL for the file and pass it to `children`, with an `onError`
 * for the media element. Owns the loading state and the error state
 * (Download and "Open in agent-fs"), so media viewers render the element only.
 */
export function MediaGate({
  file,
  noun,
  type,
  children,
}: {
  file: DrivePath;
  /** What the error title calls the file ("image", "video", "PDF"). */
  noun: string;
  /** Content type for a blob URL (see `useAgentFsMediaUrl`). */
  type?: string;
  children: (url: string, onError: () => void) => ReactNode;
}) {
  const media = useAgentFsMediaUrl(file, { disposition: "inline", type });
  // The URL that the element could not show. A new URL (a new version) tries again.
  const [failedUrl, setFailedUrl] = useState<string | null>(null);

  if (media.error || (media.url !== null && media.url === failedUrl)) {
    return (
      <EmptyState
        icon={FileWarning}
        title={`Could not show this ${noun}`}
        description={
          media.error?.message ?? "The browser cannot display this file. Download it instead."
        }
        action={
          <>
            <DownloadButton file={file} />
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
