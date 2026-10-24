/**
 * The meta line of the session header (SPEC R8.1, R9): the status, the
 * Done or Later note, the workers, tasks, cost, started, and the Handoffs
 * toggle. Container queries on the pane (`@container/pane`) drop items as
 * it narrows: started and the Handoffs label under 65rem (1040 px), cost
 * under 55rem, the workers under 45rem, and the task count under 37.5rem.
 * The status and the Handoffs toggle (its icon and its accessible name)
 * never shrink or clip. Between them, the Done or Later note truncates
 * first, and the rest of the middle clips only after that.
 */

import { AlarmClock, Archive, ListTree } from "lucide-react";
import { type ReactNode, useMemo } from "react";
import type { SessionDetailResponse, SessionListItem } from "@/api/types";
import { SessionAgents } from "@/components/sessions/session-meta";
import { StatusBadge } from "@/components/shared/status-badge";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { formatCost } from "@/lib/cost-format";
import { sessionChipStatus } from "@/lib/session-status";
import { buildTurns, hasHandoffs } from "@/lib/session-turns";
import { latestTask, plural, sessionCostUsd } from "@/lib/sessions-v2";
import { formatRelativeTime } from "@/lib/utils";
import { formatWakeShort } from "../sidebar/snooze-times";
import { sessionWorkers } from "./people-popover";

/** "Back Thu 09:00" for a session in Later, "In Done" for one in Done (UX review R9). */
export function TriageNote({ session }: { session: SessionListItem }) {
  let note: ReactNode = null;
  if (session.readState === "done") {
    note = (
      <>
        <Archive aria-hidden className="size-3 shrink-0" />
        <span className="truncate">In Done</span>
      </>
    );
  } else if (session.readState === "later") {
    note = (
      <>
        <AlarmClock aria-hidden className="size-3 shrink-0" />
        <span className="truncate">
          {session.snoozeUntil
            ? `Back ${formatWakeShort(session.snoozeUntil, new Date())}`
            : "In Later"}
        </span>
      </>
    );
  }
  return note ? <span className="flex min-w-3 shrink items-center gap-1">{note}</span> : null;
}

/**
 * What the meta lines show (the pane header and the phone detail screen):
 * the status chip, "12 tasks", the whole chain's cost, and whether the turn
 * timeline has internal handoffs (the Handoffs toggle shows only then).
 */
export function useSessionMeta(detail: SessionDetailResponse) {
  const totalCost = sessionCostUsd(detail.chain);
  // The server's latest-task rule (`latestTask`), which the sidebar row and
  // the tab also follow, so the three agree. On a rare tie of update times
  // the server takes the row SQLite meets first, and the client's walk order
  // can pick another task.
  const status = useMemo(() => sessionChipStatus(latestTask(detail).status), [detail]);
  const handoffRows = useMemo(() => hasHandoffs(buildTurns(detail.chain).turns), [detail.chain]);
  return {
    status,
    tasks: plural(detail.chain.length, "task"),
    cost: totalCost == null ? null : formatCost(totalCost),
    handoffRows,
  };
}

export function SessionMetaLine({
  detail,
  session,
  showHandoffs,
  onShowHandoffs,
}: {
  detail: SessionDetailResponse;
  session: SessionListItem;
  showHandoffs: boolean;
  onShowHandoffs: (on: boolean) => void;
}) {
  const { status, tasks, cost, handoffRows } = useSessionMeta(detail);
  const workers = useMemo(() => sessionWorkers(detail).map((worker) => worker.id), [detail]);
  const handoffs = `Handoffs · ${showHandoffs ? "On" : "Off"}`;

  return (
    <div className="flex min-w-0 shrink items-center gap-2.5 text-xs whitespace-nowrap text-muted-foreground">
      <span className="flex shrink-0">
        <StatusBadge status={status} />
      </span>
      {/* The middle gives way: the note truncates first, then the rest clips. */}
      <div className="flex min-w-0 shrink items-center gap-2.5 overflow-hidden">
        <TriageNote session={session} />
        {workers.length > 0 ? (
          <span className="flex shrink-0 @max-[45rem]/pane:hidden">
            <SessionAgents agentIds={workers} />
          </span>
        ) : null}
        <span className="shrink-0 font-mono tabular-nums @max-[37.5rem]/pane:hidden">{tasks}</span>
        {cost ? (
          <span className="shrink-0 font-mono tabular-nums @max-[55rem]/pane:hidden">{cost}</span>
        ) : null}
        <span className="shrink-0 @max-[65rem]/pane:hidden">
          started {formatRelativeTime(detail.root.createdAt)}
        </span>
      </div>
      {handoffRows ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="xs"
              aria-pressed={showHandoffs}
              aria-label={handoffs}
              onClick={() => onShowHandoffs(!showHandoffs)}
              className="h-6 shrink-0 gap-1 px-1 font-mono text-meta tracking-wider text-muted-foreground uppercase hover:text-foreground aria-pressed:text-foreground"
            >
              {/* One glyph in both states: the state is in aria-pressed and the text (UX review R9). */}
              <ListTree className="size-3" />
              <span className="@max-[65rem]/pane:hidden">{handoffs}</span>
            </Button>
          </TooltipTrigger>
          <TooltipContent>
            {showHandoffs
              ? `${handoffs}. Hide the internal handoffs.`
              : `${handoffs}. Open every step and show the internal handoffs.`}
          </TooltipContent>
        </Tooltip>
      ) : null}
    </div>
  );
}
