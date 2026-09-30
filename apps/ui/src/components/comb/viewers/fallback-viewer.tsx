import { FileQuestion, FileWarning } from "lucide-react";
import { DownloadButton, OpenInAgentFsButton } from "@/components/comb/file-actions";
import { EmptyState } from "@/components/shared/empty-state";
import { formatBytes } from "@/lib/format-bytes";
import type { ViewerProps } from "./file-viewer";

/** Files Comb cannot show: metadata plus Download and "Open in agent-fs". */
export default function FallbackViewer({
  file,
  stat,
  tooLarge,
}: ViewerProps & { tooLarge?: boolean }) {
  const facts = [formatBytes(stat.size), stat.contentType].filter(Boolean).join(" · ");
  return (
    <EmptyState
      icon={tooLarge ? FileWarning : FileQuestion}
      title={tooLarge ? "Too large to preview" : "No preview for this file type"}
      description={tooLarge ? `${facts}. Download the file to read it.` : facts}
      action={
        <>
          <DownloadButton file={file} />
          <OpenInAgentFsButton target={file} />
        </>
      }
    />
  );
}
