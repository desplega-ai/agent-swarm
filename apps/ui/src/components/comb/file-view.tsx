import { AlertCircle, FileX } from "lucide-react";
import { type ReactNode, useRef } from "react";
import { Link, Navigate } from "react-router-dom";
import { useAgentFsLs, useAgentFsStat } from "@/api/hooks/use-agent-fs";
import { CommentRail } from "@/components/comb/comment-rail";
import { FileHeader } from "@/components/comb/file-header";
import { renderMentionPicker } from "@/components/comb/mention-picker";
import { FileViewer } from "@/components/comb/viewers/file-viewer";
import { ViewerSkeleton } from "@/components/comb/viewers/viewer-skeleton";
import { EmptyState } from "@/components/shared/empty-state";
import { AlertCallout } from "@/components/ui/alert-callout";
import { Button } from "@/components/ui/button";
import { AgentFsError } from "@/lib/agent-fs/client";
import type { StatResult } from "@/lib/agent-fs/types";
import { combPath, type DrivePath, parentFolder } from "@/lib/comb/paths";

/**
 * One file: the header, then the viewer in its own scroll pane. A folder URL
 * without its trailing "/" also lands here and moves to the folder view.
 */
export function FileView({ file }: { file: DrivePath }) {
  const stat = useAgentFsStat(file);
  const notFound = stat.error instanceof AgentFsError && stat.error.status === 404;
  // A file written through agent-fs always has a version. No version means no
  // file row: on the local storage backend, `stat` answers for a directory.
  const unversioned = stat.data !== undefined && stat.data.currentVersion === undefined;

  if (notFound || unversioned) {
    // A 404 keeps the last `stat.data`. Never show that stale file: it was
    // deleted or moved while open.
    return (
      <FolderRedirect file={file}>
        {notFound || !stat.data ? (
          <FileNotFound file={file} />
        ) : (
          <FileBody file={file} stat={stat.data} />
        )}
      </FolderRedirect>
    );
  }
  if (stat.data) return <FileBody file={file} stat={stat.data} />;
  if (stat.error) {
    return (
      <AlertCallout tone="error" icon={AlertCircle} title="Could not open this file">
        {stat.error.message}
      </AlertCallout>
    );
  }
  return <ViewerSkeleton />;
}

function FileBody({ file, stat }: { file: DrivePath; stat: StatResult }) {
  // Comment anchors, selection, and highlights live in the viewer pane.
  const viewerRef = useRef<HTMLDivElement>(null);
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <FileHeader file={file} stat={stat} />
      <div className="flex min-h-0 flex-1 gap-4">
        <div
          ref={viewerRef}
          className="min-h-[24rem] min-w-0 flex-1 overflow-auto rounded-xl border border-border bg-card lg:min-h-0"
        >
          <FileViewer file={file} stat={stat} />
        </div>
        {/* Comment rail (step-7). Mount points: threadActions, railHeaderActions, renderComposerExtras. */}
        <CommentRail
          file={file}
          stat={stat}
          viewerRef={viewerRef}
          // step-8: "@" mention picker in every composer.
          renderComposerExtras={renderMentionPicker}
        />
      </div>
    </div>
  );
}

/**
 * List `file.path` as a folder and move there when it has entries. Otherwise
 * render `children`. (`ls` of a missing folder answers an empty list.)
 */
function FolderRedirect({ file, children }: { file: DrivePath; children: ReactNode }) {
  const folder = { ...file, path: `${file.path}/` };
  const listing = useAgentFsLs(folder);

  if (listing.data && listing.data.entries.length > 0) {
    return <Navigate to={combPath(folder)} replace />;
  }
  if (listing.isPending) return <ViewerSkeleton />;
  return children;
}

function FileNotFound({ file }: { file: DrivePath }) {
  return (
    <EmptyState
      icon={FileX}
      title="File not found"
      description={`${file.path} is not in this drive. It may have moved or been deleted.`}
      action={
        <Button asChild size="sm" variant="outline">
          <Link to={combPath({ ...file, path: parentFolder(file.path) })}>Open the folder</Link>
        </Button>
      }
      fullPage
    />
  );
}
