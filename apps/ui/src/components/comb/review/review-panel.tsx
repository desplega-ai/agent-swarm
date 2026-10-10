import {
  AlertCircle,
  Check,
  GitCompareArrows,
  Lock,
  RefreshCw,
  RotateCcw,
  Undo2,
  X,
} from "lucide-react";
import { useLayoutEffect, useRef } from "react";
import { useSearchParams } from "react-router-dom";
import { toast } from "sonner";
import {
  useAgentFsComments,
  useAgentFsDiff,
  useAgentFsLog,
  useAgentFsStat,
  useResolveComment,
  useRevertFile,
} from "@/api/hooks/use-agent-fs";
import { READ_ONLY_MESSAGE } from "@/components/comb/comment-composer";
import { QuoteExcerpt } from "@/components/comb/quote-excerpt";
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
import { commentQuote } from "@/lib/comb/comment-anchor";
import { diffHasChanges } from "@/lib/comb/diff-lines";
import { getFileKind } from "@/lib/comb/file-kinds";
import type { DrivePath } from "@/lib/comb/paths";
import {
  canRevert,
  DIFF_PARAM,
  type DiffRange,
  formatDiffRange,
  newerVersion,
  revertOutcome,
  reviewsThread,
} from "@/lib/comb/review";
import { formatRelative } from "@/lib/relative-time";
import { DiffViewer } from "./diff-viewer";

/** Revert answered 409: a version newer than the reviewed one landed. */
export const STALE_REVIEW_MESSAGE = "The file changed. Reload the diff";

interface ReviewPanelProps {
  file: DrivePath;
  stat: StatResult;
  /**
   * From `?diff=<from>..<to>`. `to` is the head the human reviews, at most
   * the current version (`FileBody` checks it with `reviewRangeNotice`).
   */
  range: DiffRange;
  /** Shared with the comment rail: a 403 on any write sets it. */
  readOnly: boolean;
  onReadOnly: () => void;
}

/**
 * The review view (`?diff=<from>..<to>`, optional `&comment=<id>`): what
 * changed between two versions, in the viewer pane. The comment rail stays
 * on the right with the linked thread selected. Actions: Resolve / Reopen
 * the linked thread when this is its own review, Revert to `from`, and close
 * (back to the file view).
 */
export function ReviewPanel({ file, stat, range, readOnly, onReadOnly }: ReviewPanelProps) {
  const { from, to } = range;
  const [searchParams, setSearchParams] = useSearchParams();
  const diff = useAgentFsDiff(file, from, to);
  const log = useAgentFsLog(file, stat.currentVersion);
  const statQuery = useAgentFsStat(file);
  const authorLabel = useAuthorLabel(file);
  const threadId = searchParams.get("comment");
  const linked = useAgentFsComments(file).data?.threads.find((t) => t.id === threadId);
  // Only the thread whose own review this is: not a Versions menu compare,
  // and not a head that moved on since.
  const thread =
    linked && reviewsThread(linked, range, stat.currentVersion, log.data?.versions)
      ? linked
      : undefined;
  const resolve = useResolveComment(file);
  const revert = useRevertFile(file);

  // Open at the top of the diff, wherever the file view was scrolled.
  const rootRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    rootRef.current?.parentElement?.scrollTo({ top: 0 });
  }, []);

  const newer = newerVersion(stat.currentVersion, to);
  // The last revert, read against the live `stat` (a 409 refetches it).
  // The panel remounts for a new range, which clears it.
  const failure = revert.error ? revertOutcome(revert.error, stat.currentVersion, to) : null;
  const revertable = canRevert({
    changes: diff.isSuccess ? diff.data.changes : undefined,
    currentVersion: stat.currentVersion,
    to,
    stale: failure?.kind === "stale",
  });
  const toVersion = log.data?.versions.find((entry) => entry.version === to);

  const editParams = (edit: (params: URLSearchParams) => void, replace = false) =>
    setSearchParams(
      (params) => {
        const next = new URLSearchParams(params);
        edit(next);
        return next;
      },
      { replace },
    );
  const exit = (replace = false) => editParams((params) => params.delete(DIFF_PARAM), replace);
  const reloadDiff = (head: number) =>
    editParams((params) => params.set(DIFF_PARAM, formatDiffRange({ from, to: head })), true);
  // A 409 before `stat` knows the new head: load `stat` again, then clear the
  // failed revert (a newer head then shows "Reload the diff").
  const reloadStat = async () => {
    await statQuery.refetch();
    revert.reset();
  };

  const toggleResolved = () => {
    if (!thread) return;
    resolve.mutate(
      { id: thread.id, resolved: !thread.resolved },
      {
        onError: (error) => {
          if (error instanceof AgentFsError && error.status === 403) {
            onReadOnly();
            toast.error(READ_ONLY_MESSAGE);
          } else {
            toast.error(error.message);
          }
        },
      },
    );
  };

  const revertToFrom = () => {
    if (revert.isPending) return;
    revert.mutate(
      // The reviewed head: agent-fs refuses the revert when the file moved on.
      { version: from, expectedVersion: to },
      {
        onSuccess: (result) => {
          toast.success(`Reverted to v${from}. The file is now at v${result.version}.`);
          exit(true);
        },
        onError: (error) => {
          const outcome = revertOutcome(error, stat.currentVersion, to);
          if (outcome.kind === "read-only") {
            onReadOnly();
            toast.error(READ_ONLY_MESSAGE);
          } else if (outcome.kind === "stale") {
            toast.error(`${STALE_REVIEW_MESSAGE}.`);
          } else if (outcome.kind === "failed") {
            toast.error(outcome.message);
          }
        },
      },
    );
  };

  return (
    <div ref={rootRef} className="flex min-h-full flex-col">
      <div className="sticky top-0 z-10 flex flex-col gap-2 border-b border-border-subtle bg-card px-4 py-2">
        {/* The actions wrap below the title before the title shrinks. */}
        <div className="flex flex-wrap items-center gap-2">
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
            {/* Like the rail: a read-only human sees no write actions. */}
            {!readOnly && revertable ? (
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button size="sm" variant="outline" disabled={revert.isPending}>
                    <Undo2 />
                    Revert to v{from}
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>Revert to v{from}?</AlertDialogTitle>
                    <AlertDialogDescription>
                      This writes a new version with the content of v{from}. Agents' later edits
                      stay in history.
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>Cancel</AlertDialogCancel>
                    <AlertDialogAction disabled={revert.isPending} onClick={revertToFrom}>
                      Revert to v{from}
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            ) : null}
            <Button size="icon-sm" variant="ghost" aria-label="Close review" onClick={() => exit()}>
              <X />
            </Button>
          </div>
        </div>
        {thread ? (
          // The thread this review is for, named by its passage (or its text).
          <div className="flex flex-wrap items-center gap-2">
            <QuoteExcerpt
              text={commentQuote(thread)?.exact ?? thread.body}
              // Only a quote from the file is machine text. The body is human text.
              mono={commentQuote(thread) !== undefined && getFileKind(file.path) !== "markdown"}
              className="min-w-48 flex-1"
            />
            {readOnly ? null : (
              <Button
                size="xs"
                variant="outline"
                disabled={resolve.isPending}
                onClick={toggleResolved}
              >
                {thread.resolved ? <RotateCcw /> : <Check />}
                {thread.resolved ? "Reopen this thread" : "Resolve this thread"}
              </Button>
            )}
          </div>
        ) : null}
      </div>

      {newer !== null ? (
        <AlertCallout
          tone="warning"
          icon={AlertCircle}
          title="The file changed"
          className="m-4 mb-0"
        >
          <div className="flex flex-wrap items-center gap-2">
            <span>It is now at v{newer}. Reload the diff before you revert.</span>
            <Button size="xs" variant="outline" onClick={() => reloadDiff(newer)}>
              Reload the diff
            </Button>
          </div>
        </AlertCallout>
      ) : failure?.kind === "stale" ? (
        <AlertCallout
          tone="warning"
          icon={AlertCircle}
          title="The file changed"
          className="m-4 mb-0"
        >
          <div className="flex flex-wrap items-center gap-2">
            <span>{failure.message}</span>
            <Button
              size="xs"
              variant="outline"
              disabled={statQuery.isFetching}
              onClick={() => void reloadStat()}
            >
              <RefreshCw />
              Reload
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
        <DiffViewer
          changes={diff.data.changes}
          label={`Changes from v${from} to v${to}`}
          className="py-2"
        />
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

/**
 * A `?diff=` range this file cannot show (`reviewRangeNotice`), above the
 * normal file view. Close removes the range. `data-comb-skip`: comment
 * anchors ignore its text.
 */
export function ReviewRangeNotice({ message }: { message: string }) {
  const [, setSearchParams] = useSearchParams();
  const close = () =>
    setSearchParams(
      (params) => {
        const next = new URLSearchParams(params);
        next.delete(DIFF_PARAM);
        return next;
      },
      { replace: true },
    );
  return (
    <div data-comb-skip className="p-4 pb-0">
      <AlertCallout tone="warning" icon={AlertCircle}>
        <div className="flex flex-wrap items-center gap-2">
          <span>{message}</span>
          <Button size="xs" variant="outline" onClick={close}>
            Close
          </Button>
        </div>
      </AlertCallout>
    </div>
  );
}
