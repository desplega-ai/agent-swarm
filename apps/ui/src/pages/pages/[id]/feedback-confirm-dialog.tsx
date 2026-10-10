import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import type { usePageFeedbackBridge } from "./feedback-bridge";

/**
 * Viewer confirmation for a feedback send requested by the page iframe. The
 * request comes from page-authored code, so the dashboard shows exactly what
 * will be sent and creates the task only after the viewer clicks Send.
 */
export function FeedbackConfirmDialog({
  bridge,
}: {
  bridge: ReturnType<typeof usePageFeedbackBridge>;
}) {
  const { pending, sending, confirm, cancel } = bridge;
  return (
    <AlertDialog
      open={pending !== null}
      onOpenChange={(open) => {
        if (!open && !sending) cancel();
      }}
    >
      <AlertDialogContent className="sm:max-w-lg">
        <AlertDialogHeader>
          <AlertDialogTitle>Send feedback to the swarm?</AlertDialogTitle>
          <AlertDialogDescription>
            This creates one task for the lead with {pending?.count ?? 0}{" "}
            {pending?.count === 1 ? "comment" : "comments"}.
          </AlertDialogDescription>
        </AlertDialogHeader>
        {pending ? (
          <ol className="max-h-64 space-y-2 overflow-auto text-sm">
            {pending.payload.comments.map((c, i) => (
              <li key={i} className="rounded-md border border-border px-3 py-2">
                <p className="truncate font-mono text-[11px] text-muted-foreground">
                  {i + 1}. {String(c.selector)}
                </p>
                <p className="whitespace-pre-wrap break-words">{String(c.comment)}</p>
              </li>
            ))}
            {pending.payload.note ? (
              <li className="rounded-md border border-border px-3 py-2">
                <p className="font-mono text-[11px] text-muted-foreground">Overall note</p>
                <p className="whitespace-pre-wrap break-words">{String(pending.payload.note)}</p>
              </li>
            ) : null}
          </ol>
        ) : null}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={sending}>Cancel</AlertDialogCancel>
          <Button onClick={() => void confirm()} disabled={sending}>
            {sending ? "Sending…" : "Send"}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
