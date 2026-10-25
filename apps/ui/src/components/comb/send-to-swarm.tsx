import { Send } from "lucide-react";
import { useId, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { CombSendError } from "@/api/client";
import { useSendCombReviewBatch } from "@/api/hooks/use-agent-fs";
import type { CombRepairedComment, CombSkippedComment, CombSkipReason } from "@/api/types";
import { SwarmMarkedText } from "@/components/comb/comment-thread";
import { useAuthorLabel } from "@/components/comb/use-author-label";
import { useCombServiceUserId } from "@/components/comb/use-comb-service-user";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { CommentListEntry } from "@/lib/agent-fs/types";
import {
  batchNote,
  COMB_BATCH_MAX,
  COMB_NOTE_MAX,
  canSendThread,
  eligibleForBatch,
  groupByFile,
  leadNote,
  sendFailure,
} from "@/lib/comb/batch";
import { selectionState } from "@/lib/comb/bulk";
import { lineRangeLabel } from "@/lib/comb/comments";
import type { DrivePath } from "@/lib/comb/paths";

type Drive = { orgId: string; driveId: string };

const SKIP_LABELS: Record<CombSkipReason, string> = {
  "not-found": "not found",
  reply: "a reply",
  resolved: "resolved",
  "already-sent": "already sent",
};

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

/** "Left out: 2 already sent, 1 resolved." for the toast. */
function skippedSummary(skipped: CombSkippedComment[]): string | undefined {
  if (skipped.length === 0) return undefined;
  const counts = new Map<CombSkipReason, number>();
  for (const item of skipped) counts.set(item.reason, (counts.get(item.reason) ?? 0) + 1);
  const parts = [...counts].map(([reason, count]) => `${count} ${SKIP_LABELS[reason]}`);
  return `Left out: ${parts.join(", ")}.`;
}

function repairedSummary(repaired: CombRepairedComment[]): string | undefined {
  if (repaired.length === 0) return undefined;
  return `Posted the missing task link on ${plural(repaired.length, "earlier comment")}.`;
}

/**
 * `useSendCombReviewBatch` with the result toasts. A send that only repaired
 * the missing replies of an earlier send (no new task) links that task.
 */
function useSendToSwarm(drive: Drive) {
  const navigate = useNavigate();
  const openTask = (taskId: string) => ({
    label: "Open task",
    onClick: () => navigate(`/tasks/${taskId}`),
  });
  return useSendCombReviewBatch(drive, {
    onSuccess: ({ taskId, sent, skipped, repaired, lead }) => {
      const description =
        [leadNote(lead), skippedSummary(skipped), repairedSummary(repaired)]
          .filter(Boolean)
          .join(" ") || undefined;
      const linked = taskId ?? repaired[0]?.taskId;
      toast.success(
        taskId
          ? `Sent ${plural(sent.length, "comment")} · task ${taskId.slice(0, 8)}`
          : "Already sent to the swarm",
        { description, action: linked ? openTask(linked) : undefined },
      );
    },
    onError: (error) => {
      const skipped = error instanceof CombSendError ? error.skipped : [];
      const tasks = [...new Set(skipped.flatMap((item) => (item.taskId ? [item.taskId] : [])))];
      const failure =
        error instanceof CombSendError
          ? sendFailure(error.status, error.message)
          : { title: "Could not send to the swarm", description: error.message };
      toast.error(failure.title, {
        description: skippedSummary(skipped) ?? failure.description,
        action: tasks.length === 1 ? openTask(tasks[0] as string) : undefined,
      });
    },
  });
}

/**
 * Thread action (the comment rail's `threadActions`): "Send to swarm" on an
 * open root comment that was not sent yet, with a confirm popover.
 */
export function SendThreadButton({ file, thread }: { file: DrivePath; thread: CommentListEntry }) {
  const serviceUserId = useCombServiceUserId();
  const send = useSendToSwarm(file);
  const [open, setOpen] = useState(false);
  if (!canSendThread(thread, serviceUserId)) return null;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          size="xs"
          variant="ghost"
          className="text-muted-foreground"
          // The card selects itself on click. This button does not.
          onClick={(event) => event.stopPropagation()}
        >
          <Send />
          Send to swarm
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="flex w-64 flex-col gap-3"
        // A portal still bubbles React events to the card.
        onClick={(event) => event.stopPropagation()}
      >
        <p className="text-sm">
          Send this comment to the lead as a task? The comment gets a reply with the task link.
        </p>
        <div className="flex justify-end gap-2">
          <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button
            size="sm"
            disabled={send.isPending}
            onClick={() =>
              send.mutate(
                { commentIds: [thread.id], scopePath: file.path },
                { onSettled: () => setOpen(false) },
              )
            }
          >
            <Send />
            Send
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

/**
 * "Send to swarm" for a file: the primary button of the rail's send bar (the
 * bar shows the count). It offers the open root comments not sent yet and is
 * hidden when there are none. The dialog lets the human uncheck some and add
 * a note for the lead. A folder sends its checked comments through
 * `SendBatchDialog` (`FolderComments`).
 */
export function SendBatchButton({
  drive,
  scopePath,
  threads,
}: {
  drive: Drive;
  /** The file path the batch is sent from. */
  scopePath: string;
  threads: ReadonlyArray<CommentListEntry>;
}) {
  const serviceUserId = useCombServiceUserId();
  const eligible = useMemo(
    () => eligibleForBatch(threads, serviceUserId),
    [threads, serviceUserId],
  );
  const [open, setOpen] = useState(false);

  return (
    <>
      {eligible.length > 0 ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              size="sm"
              aria-label={`Send to swarm (${eligible.length})`}
              className="shrink-0"
              onClick={() => setOpen(true)}
            >
              <Send />
              Send to swarm
            </Button>
          </TooltipTrigger>
          <TooltipContent>Send the open comments to the lead as one task</TooltipContent>
        </Tooltip>
      ) : null}
      {/* Stays mounted while the list refreshes under it. */}
      {open ? (
        <SendBatchDialog
          drive={drive}
          scopePath={scopePath}
          threads={eligible}
          showPaths={false}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </>
  );
}

export function SendBatchDialog({
  drive,
  scopePath,
  threads,
  showPaths,
  onSent,
  onClose,
}: {
  drive: Drive;
  scopePath: string;
  threads: CommentListEntry[];
  /** List each comment's file (a folder batch). */
  showPaths: boolean;
  /** After a send that landed, with the ids the swarm took, before `onClose`. */
  onSent?: (sent: string[]) => void;
  onClose: () => void;
}) {
  const send = useSendToSwarm(drive);
  const authorLabel = useAuthorLabel(drive);
  // The list is fixed while the dialog is open. One send carries at most
  // COMB_BATCH_MAX comments: the first ones start checked, the rest wait.
  const [listed] = useState(threads);
  const [checked, setChecked] = useState(
    () => new Set(threads.slice(0, COMB_BATCH_MAX).map((thread) => thread.id)),
  );
  const selected = listed.filter((thread) => checked.has(thread.id));
  const full = checked.size >= COMB_BATCH_MAX;
  const [note, setNote] = useState("");
  const noteId = useId();

  // Checks or unchecks `ids`. Checking stops at COMB_BATCH_MAX.
  const toggleMany = (ids: readonly string[], on: boolean) =>
    setChecked((current) => {
      const next = new Set(current);
      for (const id of ids) {
        if (!on) next.delete(id);
        else if (next.size < COMB_BATCH_MAX) next.add(id);
      }
      return next;
    });

  const row = (thread: CommentListEntry) => {
    const on = checked.has(thread.id);
    return (
      <li key={thread.id}>
        <label className="hover-linger flex items-start gap-2.5 px-3 py-2 transition-colors hover:bg-accent/50">
          <Checkbox
            checked={on}
            disabled={full && !on}
            onCheckedChange={(value) => toggleMany([thread.id], value === true)}
            className="mt-0.5"
          />
          <span className="flex min-w-0 flex-col gap-0.5">
            <span className="flex min-w-0 items-baseline gap-1.5 text-xs text-muted-foreground">
              <span className="truncate font-medium text-foreground">
                {thread.authorDisplayName || authorLabel(thread.author)}
              </span>
              <span className="shrink-0 font-mono text-[11px]">
                {lineRangeLabel(thread.lineStart, thread.lineEnd) ?? "File"}
              </span>
            </span>
            <span className="line-clamp-2 break-words text-sm">
              <SwarmMarkedText text={thread.body} />
            </span>
          </span>
        </label>
      </li>
    );
  };

  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Send to swarm</DialogTitle>
          <DialogDescription>
            The lead gets one task with the checked comments. Each comment gets a reply with the
            task link.
          </DialogDescription>
        </DialogHeader>
        <div className="max-h-80 overflow-y-auto rounded-lg border border-border">
          {showPaths ? (
            // A batch from several files: one group per file, with a box for the whole file.
            groupByFile(listed).map((group) => {
              const ids = group.threads.map((thread) => thread.id);
              return (
                <section
                  key={group.path}
                  aria-label={group.path}
                  className="border-b border-border-subtle last:border-b-0"
                >
                  <label className="flex items-center gap-2.5 bg-muted/40 px-3 py-1.5">
                    <Checkbox
                      aria-label={`Check the comments on ${group.path}`}
                      checked={selectionState(checked, ids)}
                      onCheckedChange={(on) => toggleMany(ids, on === true)}
                    />
                    <span className="min-w-0 truncate font-mono text-xs text-muted-foreground">
                      {group.path}
                    </span>
                    <span className="ml-auto shrink-0 text-xs text-muted-foreground tabular-nums">
                      {ids.length}
                    </span>
                  </label>
                  <ul className="divide-y divide-border-subtle">
                    {group.threads.map((thread) => row(thread))}
                  </ul>
                </section>
              );
            })
          ) : (
            <ul className="divide-y divide-border-subtle">{listed.map((thread) => row(thread))}</ul>
          )}
        </div>
        {listed.length > COMB_BATCH_MAX ? (
          <p className="text-xs text-muted-foreground">
            Only the first {COMB_BATCH_MAX} are sent in one batch. Send again for the rest.
          </p>
        ) : null}
        <div className="flex flex-col gap-1.5">
          <label htmlFor={noteId} className="text-xs font-medium text-muted-foreground">
            Note for the lead (optional)
          </label>
          <Textarea
            id={noteId}
            value={note}
            onChange={(event) => setNote(event.target.value)}
            maxLength={COMB_NOTE_MAX}
            rows={2}
            placeholder="Context for all the comments, if any"
            className="max-h-40 min-h-14 text-sm"
          />
          {note.length > COMB_NOTE_MAX - 200 ? (
            <p className="text-right text-xs text-muted-foreground tabular-nums">
              {note.length} of {COMB_NOTE_MAX}
            </p>
          ) : null}
        </div>
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="ghost">Cancel</Button>
          </DialogClose>
          <Button
            disabled={selected.length === 0 || send.isPending}
            onClick={() =>
              send.mutate(
                {
                  commentIds: selected.map((thread) => thread.id),
                  scopePath,
                  note: batchNote(note),
                },
                {
                  onSuccess: (result) => {
                    onSent?.(result.sent);
                    onClose();
                  },
                },
              )
            }
          >
            <Send />
            {send.isPending ? "Sending…" : `Send ${selected.length}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
