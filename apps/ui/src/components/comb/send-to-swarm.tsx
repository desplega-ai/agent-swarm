import { Send } from "lucide-react";
import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { CombSendError } from "@/api/client";
import { useSendCombReviewBatch } from "@/api/hooks/use-agent-fs";
import type { CombRepairedComment, CombSkippedComment, CombSkipReason } from "@/api/types";
import { useAuthorLabel } from "@/components/comb/use-author-label";
import { useCombServiceUserId } from "@/components/comb/use-comb-service-user";
import { Button } from "@/components/ui/button";
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
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { CommentListEntry } from "@/lib/agent-fs/types";
import { COMB_BATCH_MAX, canSendThread, eligibleForBatch } from "@/lib/comb/batch";
import { commentCombPath, lineRangeLabel } from "@/lib/comb/comments";
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
    onSuccess: ({ taskId, sent, skipped, repaired }) => {
      const description =
        [skippedSummary(skipped), repairedSummary(repaired)].filter(Boolean).join(" ") || undefined;
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
      toast.error(error.message, {
        description: skippedSummary(skipped),
        action: tasks.length === 1 ? openTask(tasks[0] as string) : undefined,
      });
    },
  });
}

/**
 * Thread action (the comment rail's `threadActions`): "Send to swarm" on an
 * open root comment with `@swarm` that was not sent yet, with a confirm popover.
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
 * "Send N to swarm" for a file (the rail's `railHeaderActions`) or a folder
 * (`FolderComments`). N counts open root comments with `@swarm` that were not
 * sent yet. Hidden when N is 0. The dialog lets the human uncheck some.
 */
export function SendBatchButton({
  drive,
  scopePath,
  threads,
  showPaths = false,
  compact = false,
}: {
  drive: Drive;
  /** The file or folder path the batch is sent from. */
  scopePath: string;
  threads: ReadonlyArray<CommentListEntry>;
  /** List each comment's file (a folder batch). */
  showPaths?: boolean;
  /** Show "Send N" (the narrow rail header). The full label moves to the tooltip. */
  compact?: boolean;
}) {
  const serviceUserId = useCombServiceUserId();
  const eligible = useMemo(
    () => eligibleForBatch(threads, serviceUserId),
    [threads, serviceUserId],
  );
  const [open, setOpen] = useState(false);
  const label = `Send ${eligible.length} to swarm`;

  return (
    <>
      {eligible.length > 0 ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              size="sm"
              variant="outline"
              aria-label={label}
              className="shrink-0"
              onClick={() => setOpen(true)}
            >
              <Send />
              {compact ? `Send ${eligible.length}` : label}
            </Button>
          </TooltipTrigger>
          <TooltipContent>Send the open @swarm comments to the lead as one task</TooltipContent>
        </Tooltip>
      ) : null}
      {/* Stays mounted while the list refreshes under it. */}
      {open ? (
        <SendBatchDialog
          drive={drive}
          scopePath={scopePath}
          threads={eligible}
          showPaths={showPaths}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </>
  );
}

function SendBatchDialog({
  drive,
  scopePath,
  threads,
  showPaths,
  onClose,
}: {
  drive: Drive;
  scopePath: string;
  threads: CommentListEntry[];
  showPaths: boolean;
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

  const toggle = (id: string) =>
    setChecked((current) => {
      const next = new Set(current);
      if (!next.delete(id)) next.add(id);
      return next;
    });

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
        <ul className="max-h-80 divide-y divide-border-subtle overflow-y-auto rounded-lg border border-border">
          {listed.map((thread) => (
            <li key={thread.id}>
              <label className="hover-linger flex items-start gap-2.5 px-3 py-2 transition-colors hover:bg-accent/50">
                <input
                  type="checkbox"
                  checked={checked.has(thread.id)}
                  disabled={full && !checked.has(thread.id)}
                  onChange={() => toggle(thread.id)}
                  className="mt-0.5 size-4 shrink-0 rounded border-input accent-primary outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
                />
                <span className="flex min-w-0 flex-col gap-0.5">
                  <span className="flex min-w-0 items-baseline gap-1.5 text-xs text-muted-foreground">
                    <span className="truncate font-medium text-foreground">
                      {thread.authorDisplayName || authorLabel(thread.author)}
                    </span>
                    <span className="shrink-0 font-mono text-[11px]">
                      {showPaths ? `${commentCombPath(thread.path)} ` : ""}
                      {lineRangeLabel(thread.lineStart, thread.lineEnd) ?? "File"}
                    </span>
                  </span>
                  <span className="line-clamp-2 break-words text-sm">{thread.body}</span>
                </span>
              </label>
            </li>
          ))}
        </ul>
        {listed.length > COMB_BATCH_MAX ? (
          <p className="text-xs text-muted-foreground">
            Only the first {COMB_BATCH_MAX} are sent in one batch. Send again for the rest.
          </p>
        ) : null}
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="ghost">Cancel</Button>
          </DialogClose>
          <Button
            disabled={selected.length === 0 || send.isPending}
            onClick={() =>
              send.mutate(
                { commentIds: selected.map((thread) => thread.id), scopePath },
                { onSuccess: onClose },
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
