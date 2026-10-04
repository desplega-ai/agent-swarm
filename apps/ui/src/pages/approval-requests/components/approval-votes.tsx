import { CircleCheck, CircleX } from "lucide-react";
import type { ApprovalRequest } from "@/api/types";
import { quorumLabel } from "@/lib/approval-format";
import { cn, formatSmartTime } from "@/lib/utils";
import { ResponderChip } from "./responder-chip";

/**
 * The answers collected so far, with quorum progress ("1 of 2 approved"),
 * for requests whose policy needs more than one approval. A request resolved
 * by a single answer shows nothing here: the resolution banner names them.
 */
export function ApprovalVotes({ request }: { request: ApprovalRequest }) {
  const votes = request.approvals ?? [];
  const progress = request.approvalProgress ?? null;
  const quorum = quorumLabel(progress);
  if (!quorum && votes.length <= 1) return null;
  const pct = progress ? Math.min(progress.approved / Math.max(progress.required, 1), 1) : 0;
  return (
    <section
      aria-label="Approvals"
      className="flex flex-col gap-2 rounded-xl border border-border-subtle px-4 py-3"
    >
      <div className="flex items-center justify-between gap-2 text-xs">
        <span className="font-medium text-foreground">Approvals</span>
        {quorum ? <span className="tabular-nums text-muted-foreground">{quorum}</span> : null}
      </div>
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
      {votes.length === 0 ? (
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
