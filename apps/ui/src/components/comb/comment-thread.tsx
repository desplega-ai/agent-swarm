import { Check, MessageSquare, RotateCcw, Send, TriangleAlert } from "lucide-react";
import { type ReactNode, useState } from "react";
import { Link } from "react-router-dom";
import { toast } from "sonner";
import { useResolveComment } from "@/api/hooks/use-agent-fs";
import { useAuthorLabel } from "@/components/comb/use-author-label";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { AgentFsError } from "@/lib/agent-fs/client";
import type { CommentEntry, CommentListEntry } from "@/lib/agent-fs/types";
import { type AnchorResolution, commentQuote } from "@/lib/comb/comment-anchor";
import { sentTaskIdOf, splitSwarmMarkers } from "@/lib/comb/markers";
import { formatRelative } from "@/lib/relative-time";
import { cn } from "@/lib/utils";
import { CommentComposer, useHasDraft } from "./comment-composer";
import { useCommentContext } from "./comment-context";

/** A comment body: plain text, with each `@swarm` token as a chip. */
function CommentBody({ body }: { body: string }) {
  return (
    <p className="whitespace-pre-wrap break-words text-sm">
      {splitSwarmMarkers(body).map((segment, index) =>
        segment.kind === "swarm" ? (
          <span
            key={index}
            className="rounded-sm bg-status-info/15 px-1 font-medium text-status-info-strong"
          >
            {segment.text}
          </span>
        ) : (
          segment.text
        ),
      )}
    </p>
  );
}

function Byline({ entry, children }: { entry: CommentEntry; children?: ReactNode }) {
  const { file } = useCommentContext();
  const authorLabel = useAuthorLabel(file);
  return (
    <div className="flex min-w-0 items-baseline gap-1.5 text-xs">
      <span className="truncate font-medium">
        {entry.authorDisplayName || authorLabel(entry.author)}
      </span>
      <time
        dateTime={entry.createdAt}
        title={entry.createdAt}
        className="shrink-0 text-muted-foreground"
      >
        {formatRelative(entry.createdAt)}
      </time>
      {children}
    </div>
  );
}

function Reply({ reply }: { reply: CommentEntry }) {
  const taskId = sentTaskIdOf(reply);
  return (
    <li className="flex flex-col gap-1 py-2">
      <Byline entry={reply} />
      {taskId ? (
        <Link
          to={`/tasks/${taskId}`}
          onClick={(event) => event.stopPropagation()}
          className="flex items-center gap-1.5 text-sm text-primary underline-offset-2 hover:underline"
        >
          <Send className="size-3.5 shrink-0" aria-hidden />
          Sent to the swarm · task <span className="font-mono text-xs">{taskId.slice(0, 8)}</span>
        </Link>
      ) : (
        <CommentBody body={reply.body} />
      )}
    </li>
  );
}

const ANCHOR_BADGES = {
  moved: {
    label: "Moved",
    hint: "The text changed since this comment. It shows the closest match.",
    className: "border-status-warning/40 text-status-warning-strong",
  },
  lost: {
    label: "Lost",
    hint: "The text this comment pointed to is no longer in the file.",
    className: "border-status-neutral/40 text-status-neutral-strong",
  },
} as const;

interface CommentThreadProps {
  thread: CommentListEntry;
  /** The resolved anchor. Undefined for a file-level comment or while it resolves. */
  anchor: AnchorResolution | undefined;
  active: boolean;
  /** The pointer is over this comment's passage in the document. */
  hovered: boolean;
  /** Select the thread: scroll to its passage and emphasize it. */
  onActivate: (id: string) => void;
  onHover: (id: string | null) => void;
  /** Thread actions mount point: step-9 "Send to swarm", step-10 "Review changes". */
  actions?: ReactNode;
}

/** One root comment with its replies, reply box, and Resolve / Reopen. */
export function CommentThread({
  thread,
  anchor,
  active,
  hovered,
  onActivate,
  onHover,
  actions,
}: CommentThreadProps) {
  const { file, readOnly, markReadOnly, renderComposerExtras } = useCommentContext();
  const resolve = useResolveComment(file);
  const replyTarget = { kind: "reply", parentId: thread.id } as const;
  // A saved reply draft reopens the reply box (after a reload).
  const hasReplyDraft = useHasDraft(replyTarget);
  const [replying, setReplying] = useState(hasReplyDraft);
  const quote = commentQuote(thread)?.exact;
  const lineStart = anchor?.lineStart ?? thread.lineStart;
  const lineEnd = anchor?.lineStart != null ? anchor.lineEnd : thread.lineEnd;
  const badge = anchor && anchor.status !== "anchored" ? ANCHOR_BADGES[anchor.status] : null;

  const toggleResolved = () =>
    resolve.mutate(
      { id: thread.id, resolved: !thread.resolved },
      {
        onError: (error) => {
          if (error instanceof AgentFsError && error.status === 403) {
            markReadOnly();
            toast.error("You have view-only access");
          } else {
            toast.error(error.message);
          }
        },
      },
    );

  return (
    <article
      data-comment-id={thread.id}
      aria-current={active ? "true" : undefined}
      onClick={() => onActivate(thread.id)}
      onMouseEnter={() => onHover(thread.id)}
      onMouseLeave={() => onHover(null)}
      className={cn(
        "hover-linger flex flex-col gap-2 rounded-lg border border-border bg-card p-3 transition-colors hover:bg-accent/40",
        hovered && "bg-accent/60",
        active && "border-primary/60",
      )}
    >
      <header className="flex items-start justify-between gap-2">
        <Byline entry={thread}>
          {lineStart && anchor?.status !== "lost" ? (
            <span className="shrink-0 font-mono text-[11px] text-muted-foreground">
              L{lineStart}
              {lineEnd && lineEnd !== lineStart ? `-${lineEnd}` : ""}
            </span>
          ) : null}
        </Byline>
        <div className="flex shrink-0 items-center gap-1">
          {badge ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <Badge variant="outline" size="tag" className={cn("gap-1", badge.className)}>
                  <TriangleAlert className="size-2.5" aria-hidden />
                  {badge.label}
                </Badge>
              </TooltipTrigger>
              <TooltipContent>{badge.hint}</TooltipContent>
            </Tooltip>
          ) : null}
          {readOnly ? null : (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  size="icon-xs"
                  variant="ghost"
                  aria-label={thread.resolved ? "Reopen" : "Resolve"}
                  disabled={resolve.isPending}
                  onClick={(event) => {
                    event.stopPropagation();
                    toggleResolved();
                  }}
                >
                  {thread.resolved ? <RotateCcw /> : <Check />}
                </Button>
              </TooltipTrigger>
              <TooltipContent>{thread.resolved ? "Reopen" : "Resolve"}</TooltipContent>
            </Tooltip>
          )}
        </div>
      </header>

      {quote ? (
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            onActivate(thread.id);
          }}
          className={cn(
            "line-clamp-2 border-l-2 border-border pl-2 text-left text-xs text-muted-foreground",
            anchor?.status === "lost" && "line-through",
          )}
          title="Show in the file"
        >
          {quote}
        </button>
      ) : null}

      <CommentBody body={thread.body} />

      {thread.replies.length > 0 ? (
        <ol className="flex flex-col divide-y divide-border-subtle border-t border-border-subtle">
          {thread.replies.map((reply) => (
            <Reply key={reply.id} reply={reply} />
          ))}
        </ol>
      ) : null}

      {replying ? (
        // Typing in the reply box does not select the card.
        <div onClick={(event) => event.stopPropagation()}>
          <CommentComposer
            target={replyTarget}
            placeholder="Reply"
            autoFocus
            onClose={() => setReplying(false)}
            renderComposerExtras={renderComposerExtras}
          />
        </div>
      ) : (
        <footer className="flex flex-wrap items-center gap-1">
          {readOnly ? null : (
            <Button
              size="xs"
              variant="ghost"
              className="text-muted-foreground"
              onClick={(event) => {
                event.stopPropagation();
                setReplying(true);
              }}
            >
              <MessageSquare />
              Reply
            </Button>
          )}
          {/* Thread actions mount point (step-9 Send to swarm, step-10 Review changes). */}
          {actions}
        </footer>
      )}
    </article>
  );
}
