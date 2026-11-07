import { ChevronDown, CircleCheck, CircleX } from "lucide-react";
import { useState } from "react";
import type { ApprovalRequest } from "@/api/types";
import { useIsMobile } from "@/hooks/use-mobile";
import { quorumLabel } from "@/lib/approval-format";
import { cn, formatSmartTime } from "@/lib/utils";
import { ResponderChip } from "./responder-chip";

/**
 * The answers collected so far, with quorum progress ("1 of 2 approved"),
 * for requests whose policy needs more than one approval. A request resolved
 * by a single answer shows nothing here: the resolution banner names them.
 */
export function ApprovalVotes({ request }: { request: ApprovalRequest }) {
  const isMobile = useIsMobile();
  // On a phone the vote list folds under the quorum line: it is context, the questions are the task.
  const [open, setOpen] = useState(false);
  const votes = request.approvals ?? [];
  const progress = request.approvalProgress ?? null;
  const quorum = quorumLabel(progress);
  if (!quorum && votes.length <= 1) return null;
  const pct = progress ? Math.min(progress.approved / Math.max(progress.required, 1), 1) : 0;
  return (
    <section
      aria-label="Approvals"
      className="flex flex-col gap-2 rounded-xl border border-border-subtle px-4 py-3 max-md:py-2"
    >
      <button
        type="button"
        disabled={!isMobile || votes.length === 0}
        aria-expanded={isMobile ? open : undefined}
        onClick={() => setOpen((value) => !value)}
        className="flex min-h-9 items-center justify-between gap-2 text-xs outline-none disabled:cursor-default max-md:-my-1"
      >
        <span className="font-medium text-foreground">Approvals</span>
        <span className="flex items-center gap-1 tabular-nums text-muted-foreground">
          {quorum}
          {isMobile && votes.length > 0 ? (
            <ChevronDown
              aria-hidden
              className={cn("size-4 transition-transform", open && "rotate-180")}
            />
          ) : null}
        </span>
      </button>
      {quorum && progress ? (
        <div
          className="h-1 overflow-hidden rounded-full bg-muted"
          role="progressbar"
          aria-label="Approvals collected"
          aria-valuemin={0}
          aria-valuemax={progress.required}
          aria-valuenow={progress.approved}
        >
          <div
            className="h-full w-full origin-left bg-primary transition-transform"
            style={{ transform: `scaleX(${pct})` }}
          />
        </div>
      ) : null}
      {isMobile && !open ? null : votes.length === 0 ? (
        <p className="text-xs text-muted-foreground">No approvals yet.</p>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {votes.map((vote) => {
            const Icon = vote.approved ? CircleCheck : CircleX;
            return (
              <li
                key={`${vote.responder}:${vote.respondedAt}`}
                className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-xs"
              >
                <ResponderChip responder={vote.responder} claimed={vote.claimedRespondedBy} />
                <span
                  className={cn(
                    "inline-flex items-center gap-1",
                    vote.approved ? "text-status-success-strong" : "text-status-error-strong",
                  )}
                >
                  <Icon className="size-3.5" aria-hidden />
                  {vote.approved ? "Approved" : "Rejected"}
                </span>
                <span className="text-muted-foreground">{formatSmartTime(vote.respondedAt)}</span>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
