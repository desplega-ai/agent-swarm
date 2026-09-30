import { AlertCircle, Check, GitCompareArrows, Lock, RotateCcw, Undo2, X } from "lucide-react";
import { useLayoutEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { toast } from "sonner";
import {
  useAgentFsComments,
  useAgentFsDiff,
  useAgentFsLog,
  useResolveComment,
  useRevertFile,
} from "@/api/hooks/use-agent-fs";
import { READ_ONLY_MESSAGE } from "@/components/comb/comment-composer";
import { useAuthorLabel } from "@/components/comb/use-author-label";
import { ViewerSkeleton } from "@/components/comb/viewers/viewer-skeleton";
import { EmptyState } from "@/components/shared/empty-state";
import { AlertCallout } from "@/components/ui/alert-callout";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { AgentFsError } from "@/lib/agent-fs/client";
import type { StatResult } from "@/lib/agent-fs/types";
import { diffHasChanges } from "@/lib/comb/diff-lines";
import type { DrivePath } from "@/lib/comb/paths";
import { DIFF_PARAM, type DiffRange, formatDiffRange } from "@/lib/comb/review";
import { formatRelative } from "@/lib/relative-time";
import { DiffViewer } from "./diff-viewer";

/** Revert answered 409: a version newer than the reviewed one landed. */
export const STALE_REVIEW_MESSAGE = "The file changed, reload the diff";

interface ReviewPanelProps {
  file: DrivePath;
  stat: StatResult;
  /** From `?diff=<from>..<to>`. `to` is the head the human reviews. */
  range: DiffRange;
}

/**
 * The review view (`?diff=<from>..<to>`, optional `&comment=<id>`): what
 * changed between two versions, in the viewer pane. The comment rail stays
 * on the right with the linked thread selected. Actions: Resolve / Reopen
 * the linked thread, Revert to `from`, and close (back to the file view).
 */
export function ReviewPanel({ file, stat, range }: ReviewPanelProps) {
  const { from, to } = range;
  const [searchParams, setSearchParams] = useSearchParams();
  const diff = useAgentFsDiff(file, from, to);
  const log = useAgentFsLog(file, stat.currentVersion);
  const authorLabel = useAuthorLabel(file);
  const threadId = searchParams.get("comment");
  const thread = useAgentFsComments(file).data?.threads.find((t) => t.id === threadId);
  const resolve = useResolveComment(file);
  const revert = useRevertFile(file);
  // A 403 on a write: the human is a drive viewer.
  const [readOnly, setReadOnly] = useState(false);
  // Revert answered 409. The panel remounts for a new range, which clears it.
  const [conflict, setConflict] = useState(false);

  // Open at the top of the diff, wherever the file view was scrolled.
  const rootRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    rootRef.current?.parentElement?.scrollTo({ top: 0 });
  }, []);

  const current = stat.currentVersion;
  const newer = current !== undefined && current > to ? current : null;
  const toVersion = log.data?.versions.find((entry) => entry.version === to);
  // Same content on both sides: a revert would only add a copy.
  const unchanged = diff.data !== undefined && !diffHasChanges(diff.data.changes);

  const editParams = (edit: (params: URLSearchParams) => void, replace = false) =>
    setSearchParams(
      (params) => {
        const next = new URLSearchParams(params);
        edit(next);
        return next;
      },
      { replace },
    );
  const exit = () => editParams((params) => params.delete(DIFF_PARAM));
  const reload = () => {
    if (newer === null) return;
    editParams((params) => params.set(DIFF_PARAM, formatDiffRange({ from, to: newer })), true);
  };

  const writeFailed = (error: Error) => {
    if (error instanceof AgentFsError && error.status === 403) {
      setReadOnly(true);
      toast.error(READ_ONLY_MESSAGE);
    } else {
      toast.error(error.message);
    }
  };

  const toggleResolved = () => {
    if (!thread) return;
    resolve.mutate({ id: thread.id, resolved: !thread.resolved }, { onError: writeFailed });
  };

  const revertToFrom = () =>
    revert.mutate(
      // The reviewed head: agent-fs refuses the revert when the file moved on.
      { version: from, expectedVersion: to },
      {
        onSuccess: (result) => {
          toast.success(`Reverted to v${from}. The file is now at v${result.version}.`);
          exit();
        },
        onError: (error) => {
          if (error instanceof AgentFsError && error.status === 409) {
            setConflict(true);
            toast.error(`${STALE_REVIEW_MESSAGE}.`);
          } else {
            writeFailed(error);
          }
        },
      },
    );

  return (
    <div ref={rootRef} className="flex min-h-full flex-col">
      <div className="sticky top-0 z-10 flex flex-wrap items-center gap-2 border-b border-border-subtle bg-card px-4 py-2">
        {/* The actions wrap below the title before the title shrinks. */}
        <div className="min-w-48 flex-1">
          <h3 className="text-sm font-semibold">
            Changes v{from} → v{to}
          </h3>
          {toVersion ? (
            <p className="truncate text-xs text-muted-foreground">
              by {authorLabel(toVersion.author)} ·{" "}
              <time dateTime={toVersion.createdAt} title={toVersion.createdAt}>
                {formatRelative(toVersion.createdAt)}
              </time>
              {toVersion.message ? ` · ${toVersion.message}` : null}
            </p>
          ) : null}
          {readOnly ? (
            <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Lock className="size-3.5 shrink-0" aria-hidden />
              {READ_ONLY_MESSAGE}
            </p>
          ) : null}
        </div>
        <div className="flex items-center gap-2">
          {thread ? (
            <Button
              size="sm"
              variant="outline"
              disabled={readOnly || resolve.isPending}
              onClick={toggleResolved}
            >
              {thread.resolved ? <RotateCcw /> : <Check />}
              {thread.resolved ? "Reopen" : "Resolve"}
            </Button>
          ) : null}
          {unchanged ? null : (
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button size="sm" variant="outline" disabled={readOnly || revert.isPending}>
                  <Undo2 />
                  Revert to v{from}
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Revert to v{from}?</AlertDialogTitle>
                  <AlertDialogDescription>
                    This writes a new version with the content of v{from}. Agents' later edits stay
                    in history.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <AlertDialogAction onClick={revertToFrom}>Revert to v{from}</AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          )}
          <Button size="icon-sm" variant="ghost" aria-label="Close review" onClick={exit}>
            <X />
          </Button>
        </div>
      </div>

      {conflict || newer !== null ? (
        <AlertCallout
          tone="warning"
          icon={AlertCircle}
          title="The file changed"
          className="m-4 mb-0"
        >
          <div className="flex flex-wrap items-center gap-2">
            <span>
              {newer !== null
                ? `It is now at v${newer}. Reload the diff before you revert.`
                : "A newer version exists. Reload the diff before you revert."}
            </span>
            <Button size="xs" variant="outline" disabled={newer === null} onClick={reload}>
              Reload the diff
            </Button>
          </div>
        </AlertCallout>
      ) : null}

      {diff.isPending ? (
        <ViewerSkeleton />
      ) : diff.error ? (
        <AlertCallout
          tone="error"
          icon={AlertCircle}
          title="Could not load the diff"
          className="m-4"
        >
          {diff.error.message}
        </AlertCallout>
      ) : diffHasChanges(diff.data.changes) ? (
        <DiffViewer changes={diff.data.changes} className="py-2" />
      ) : (
        <EmptyState
          icon={GitCompareArrows}
          title="No changes"
          description={`v${from} and v${to} have the same content.`}
        />
      )}
    </div>
  );
}
