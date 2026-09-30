import { AlertCircle, FileX } from "lucide-react";
import { type ReactNode, useCallback, useReducer, useRef } from "react";
import { Link, Navigate, useSearchParams } from "react-router-dom";
import { useAgentFsLs, useAgentFsStat } from "@/api/hooks/use-agent-fs";
import { useCombLayout } from "@/components/comb/comb-layout";
import { CommentRail } from "@/components/comb/comment-rail";
import { renderMentionPicker } from "@/components/comb/mention-picker";
import { ReviewChangesButton } from "@/components/comb/review/review-changes-button";
import { ReviewPanel, ReviewRangeNotice } from "@/components/comb/review/review-panel";
import { SendBatchButton, SendThreadButton } from "@/components/comb/send-to-swarm";
import { FileViewer } from "@/components/comb/viewers/file-viewer";
import { ViewerSkeleton } from "@/components/comb/viewers/viewer-skeleton";
import { EmptyState } from "@/components/shared/empty-state";
import { AlertCallout } from "@/components/ui/alert-callout";
import { Button } from "@/components/ui/button";
import { AgentFsError } from "@/lib/agent-fs/client";
import type { StatResult } from "@/lib/agent-fs/types";
import { combPath, type DrivePath, parentFolder } from "@/lib/comb/paths";
import { DIFF_PARAM, parseDiffRange, reviewRangeNotice } from "@/lib/comb/review";
import { cn } from "@/lib/utils";

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
  return <FileViewSkeleton />;
}

/** The loaded frame while `stat` loads: the viewer pane and the comment panel's column. */
function FileViewSkeleton() {
  const layout = useCombLayout();
  const inline = layout?.inline ?? true;
  const railOpen = layout?.right.open ?? true;
  return (
    <div className="flex min-h-0 flex-1 gap-3" aria-busy="true">
      <div className={VIEWER_PANE}>
        <ViewerSkeleton />
      </div>
      {inline ? (
        <div
          aria-hidden
          className={cn(
            "shrink-0",
            railOpen ? "w-72 rounded-xl border border-border bg-card xl:w-80" : "w-11",
          )}
        />
      ) : null}
    </div>
  );
}

// The viewer scroll pane. The outline scrolls a heading to its top, 16px below the edge.
const VIEWER_PANE =
  "min-h-[24rem] min-w-0 flex-1 overflow-auto rounded-xl border border-border bg-card lg:min-h-0 [&_:is(h1,h2,h3,h4,h5,h6)]:scroll-mt-4";

// step-10: the review (`?diff=`) replaces the file in the viewer pane.
const VIEWER_PARAMS = [DIFF_PARAM];

function FileBody({ file, stat }: { file: DrivePath; stat: StatResult }) {
  // Comment anchors, selection, and highlights live in the viewer pane. The
  // page layout gets it too: the outline scrolls it.
  const viewerRef = useRef<HTMLDivElement>(null);
  const setViewer = useCombLayout()?.setViewer;
  const setViewerRef = useCallback(
    (element: HTMLDivElement | null) => {
      viewerRef.current = element;
      setViewer?.(element);
    },
    [setViewer],
  );
  // step-10: one read-only flag for the rail and the review. A 403 on any write sets it.
  const [readOnly, markReadOnly] = useReducer(() => true, false);
  // step-10: `?diff=<from>..<to>` shows the review (the diff) in place of the
  // viewer. A range this file cannot show opens the file with a notice.
  const [searchParams] = useSearchParams();
  const requested = parseDiffRange(searchParams.get(DIFF_PARAM));
  const notice = requested ? reviewRangeNotice(requested, file.path, stat) : null;
  const review = notice ? null : requested;
  return (
    <div className="flex min-h-0 flex-1 gap-3">
      <div ref={setViewerRef} className={VIEWER_PANE}>
        {review ? (
          <ReviewPanel
            key={`${review.from}..${review.to}`}
            file={file}
            stat={stat}
            range={review}
            readOnly={readOnly}
            onReadOnly={markReadOnly}
          />
        ) : (
          <>
            {notice ? <ReviewRangeNotice message={notice} /> : null}
            <FileViewer file={file} stat={stat} />
          </>
        )}
      </div>
      {/* Comment rail (step-7). Mount points: threadActions, railHeaderActions, renderComposerExtras. */}
      <CommentRail
        file={file}
        stat={stat}
        viewerRef={viewerRef}
        // step-8: "@" mention picker in every composer.
        renderComposerExtras={renderMentionPicker}
        // step-10: the shared read-only flag and the review param.
        readOnly={readOnly}
        onReadOnly={markReadOnly}
        viewerParams={VIEWER_PARAMS}
        // step-9 "Send to swarm" and step-10 "Review changes (vX → vY)" on each thread.
        threadActions={(thread) => (
          <>
            <SendThreadButton file={file} thread={thread} />
            <ReviewChangesButton file={file} stat={stat} thread={thread} />
          </>
        )}
        // step-9: "Send N" for every open @swarm thread of the file.
        railHeaderActions={({ open }) => (
          <SendBatchButton drive={file} scopePath={file.path} threads={open} compact />
        )}
      />
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
  if (listing.isPending) return <FileViewSkeleton />;
  return children;
}

function FileNotFound({ file }: { file: DrivePath }) {
  return (
    <EmptyState
      icon={FileX}
      title="File not found"
      description={`${file.path} is not in this drive. It may have moved or been deleted.`}
      action={
        <Button asChild size="sm">
          <Link to={combPath({ ...file, path: parentFolder(file.path) })}>Open the folder</Link>
        </Button>
      }
      fullPage
    />
  );
}
