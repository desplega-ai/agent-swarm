/**
 * The files a person sent with a `SessionThread` message, as chips above the
 * bubble. An image chip shows a thumbnail. A chip opens its file in a dialog
 * with the `File` view (the viewer, "Open in agent-fs" and Download). Both
 * read with the viewer's own agent-fs key, like `File`.
 */

import { useState } from "react";
import { useAgentFsMediaUrl } from "@/api/hooks/use-agent-fs";
import { FileKindIcon } from "@/components/comb/file-icon";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { useOptionalAgentFs } from "@/contexts/agent-fs-context";
import type { DrivePath } from "@/lib/comb/paths";
import { formatBytes } from "@/lib/format-bytes";
import { cn } from "@/lib/utils";
import { FileView } from "./files";
import type { ThreadAttachment } from "./session-thread-model";

const THUMBNAIL_CLASS = "h-8 w-12 shrink-0 rounded-sm border border-border";

function Thumbnail({ file }: { file: DrivePath }) {
  const { url } = useAgentFsMediaUrl(file, "image");
  if (!url) return <span aria-hidden className={cn(THUMBNAIL_CLASS, "bg-muted")} />;
  return <img src={url} alt="" className={cn(THUMBNAIL_CLASS, "object-cover object-top")} />;
}

function ChipIcon({ file }: { file: ThreadAttachment }) {
  const agentFs = useOptionalAgentFs();
  const { orgId, driveId } = agentFs ?? {};
  if (file.mimeType.startsWith("image/") && agentFs?.state === "ready" && orgId && driveId) {
    return <Thumbnail file={{ orgId, driveId, path: file.path }} />;
  }
  return <FileKindIcon name={file.name} isFolder={false} />;
}

export function ThreadMessageFiles({ files }: { files: readonly ThreadAttachment[] }) {
  const [opened, setOpened] = useState<ThreadAttachment | null>(null);
  return (
    <>
      <ul aria-label="Attached files" className="flex max-w-full flex-wrap gap-1.5">
        {files.map((file) => (
          <li key={file.path} className="min-w-0 max-w-full">
            <button
              type="button"
              onClick={() => setOpened(file)}
              aria-label={`Open ${file.name}`}
              className={cn(
                "inline-flex max-w-full items-center gap-1.5 rounded-md border border-border",
                "bg-muted/55 px-2 py-1 text-xs text-foreground hover:bg-muted",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60",
              )}
            >
              <ChipIcon file={file} />
              <span className="truncate max-w-[12rem] sm:max-w-[18rem]">{file.name}</span>
              <span className="shrink-0 text-meta text-muted-foreground">
                {formatBytes(file.size)}
              </span>
            </button>
          </li>
        ))}
      </ul>
      <Dialog open={opened !== null} onOpenChange={(open) => !open && setOpened(null)}>
        <DialogContent className="sm:max-w-3xl" aria-describedby={undefined}>
          <DialogTitle className="sr-only">{opened?.name}</DialogTitle>
          {opened ? <FileView props={{ path: opened.path, height: "70vh" }} /> : null}
        </DialogContent>
      </Dialog>
    </>
  );
}
