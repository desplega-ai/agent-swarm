import { ChevronRight } from "lucide-react";
import { useRef, useState } from "react";
import { Link } from "react-router-dom";
import type { ApprovalRequest } from "@/api/types";
import { StatusBadge } from "@/components/shared/status-badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useUserName } from "@/hooks/use-user-name";
import { approvalRequestSource } from "@/lib/approval-format";
import { type ListShortcut, matchListShortcut } from "@/lib/approval-shortcuts";
import { cn, formatSmartTime } from "@/lib/utils";
import { WRAP } from "./answer-view";
import { KeyHint, useFinePointer, useKeyboardShortcuts } from "./keyboard";

const PAGE_SIZE = 50;
const SOURCE_LABEL = { workflow: "Workflow", agent: "Agent", manual: "Manual" } as const;
/** Desktop columns: request · status · questions · source · resolved by · created. */
const COLUMNS =
  "md:grid md:grid-cols-[minmax(0,1fr)_120px_96px_90px_140px_110px] md:items-center md:gap-4";

function questionCount(request: ApprovalRequest) {
  const count = request.questions?.length ?? 0;
  return `${count} ${count === 1 ? "question" : "questions"}`;
}

function Row({
  request,
  resolverName,
  highlighted,
  onFocus,
  linkRef,
}: {
  request: ApprovalRequest;
  /** The resolver's display name, or the stored reference when unknown. */
  resolverName: string | null;
  highlighted: boolean;
  onFocus: () => void;
  linkRef: (el: HTMLAnchorElement | null) => void;
}) {
  const pending = request.status === "pending";
  return (
    <li>
      <Link
        ref={linkRef}
        to={`/approval-requests/${request.id}`}
        onFocus={onFocus}
        aria-current={highlighted ? "true" : undefined}
        className={cn(
          "group relative flex min-h-11 flex-col gap-1.5 px-4 py-3 outline-none transition-colors md:py-2.5",
          COLUMNS,
          "hover:bg-accent/40 focus-visible:bg-accent/50",
          highlighted && "bg-accent/50",
        )}
      >
        {/* Amber rail: "pending" reads before the words do. */}
        <span
          aria-hidden
          className={cn(
            "absolute inset-y-2 left-0 w-0.5 rounded-full transition-colors",
            pending ? "bg-primary" : highlighted ? "bg-border" : "bg-transparent",
          )}
        />
        <span className="flex min-w-0 items-start gap-2">
          <span className={cn("min-w-0 flex-1 text-sm", pending && "font-medium", WRAP)}>
            {request.title}
          </span>
          <ChevronRight className="mt-0.5 size-4 shrink-0 text-muted-foreground md:hidden" />
        </span>
        <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground md:contents">
          <span className="md:flex">
            <StatusBadge status={request.status} />
          </span>
          <span>{questionCount(request)}</span>
          <span aria-hidden className="md:hidden">
            ·
          </span>
          <span>{SOURCE_LABEL[approvalRequestSource(request)]}</span>
          <span className="hidden truncate md:block" title={request.resolvedBy ?? undefined}>
            {resolverName ?? "—"}
          </span>
          <span aria-hidden className="md:hidden">
            ·
          </span>
          <span className="md:text-right">{formatSmartTime(request.createdAt)}</span>
        </span>
      </Link>
    </li>
  );
}

/**
 * The approval-request list: pending first (soonest to expire on top, then
 * newest), one responsive row per request (a card on phones, a table row from
 * `md`). j/k or ↑/↓ move the highlight, Enter opens.
 */
export function RequestList({
  rows,
  loading,
  onOpen,
}: {
  rows: ApprovalRequest[];
  loading: boolean;
  onOpen: (request: ApprovalRequest) => void;
}) {
  const [limit, setLimit] = useState(PAGE_SIZE);
  const [highlight, setHighlight] = useState(-1);
  const links = useRef<(HTMLAnchorElement | null)[]>([]);
  const finePointer = useFinePointer();
  const userName = useUserName();
  const visible = rows.slice(0, limit);
  const pendingCount = rows.filter((row) => row.status === "pending").length;

  const move = (index: number) => {
    const next = Math.min(Math.max(index, 0), visible.length - 1);
    if (next < 0) return;
    setHighlight(next);
    links.current[next]?.focus({ preventScroll: true });
    links.current[next]?.scrollIntoView({ block: "nearest" });
  };

  useKeyboardShortcuts(matchListShortcut, (action: ListShortcut) => {
    if (visible.length === 0) return false;
    if (action.type === "next") move(highlight + 1);
    else if (action.type === "prev") move(highlight < 0 ? 0 : highlight - 1);
    else {
      const row = visible[highlight];
      if (!row) return false;
      onOpen(row);
    }
    return undefined;
  });

  if (loading) {
    return (
      <div className="flex flex-col gap-2">
        {[0, 1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-14 rounded-lg" />
        ))}
      </div>
    );
  }

  if (rows.length === 0) {
    return (
      <p className="rounded-xl border border-dashed border-border px-4 py-10 text-center text-sm text-muted-foreground">
        No approval requests match the current filters
      </p>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
        <span>
          {pendingCount > 0 ? (
            <span className="font-medium text-foreground">{pendingCount} pending · </span>
          ) : null}
          {rows.length} total
        </span>
        {finePointer ? (
          <span className="hidden items-center gap-1 [@media(hover:hover)_and_(pointer:fine)]:inline-flex">
            <KeyHint>J</KeyHint>
            <KeyHint>K</KeyHint> move · <KeyHint>↵</KeyHint> open
          </span>
        ) : null}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto rounded-xl border border-border bg-card">
        <div
          aria-hidden
          className={cn(
            "sticky top-0 z-10 hidden border-b border-border bg-card/95 px-4 py-2 font-mono text-[10px] font-bold uppercase tracking-[0.08em] text-muted-foreground backdrop-blur",
            COLUMNS,
          )}
        >
          <span>Request</span>
          <span>Status</span>
          <span>Questions</span>
          <span>Source</span>
          <span>Resolved by</span>
          <span className="text-right">Created</span>
        </div>
        <ul className="divide-y divide-border-subtle" aria-label="Approval requests">
          {visible.map((request, index) => (
            <Row
              key={request.id}
              request={request}
              resolverName={
                request.resolvedBy ? (userName(request.resolvedBy) ?? request.resolvedBy) : null
              }
              highlighted={index === highlight}
              onFocus={() => setHighlight(index)}
              linkRef={(el) => {
                links.current[index] = el;
              }}
            />
          ))}
        </ul>
        {rows.length > limit ? (
          <div className="border-t border-border-subtle p-2">
            <Button
              variant="ghost"
              className="h-11 w-full text-xs text-muted-foreground sm:h-8"
              onClick={() => setLimit((current) => current + PAGE_SIZE)}
            >
              Show {Math.min(PAGE_SIZE, rows.length - limit)} more
            </Button>
          </div>
        ) : null}
      </div>
    </div>
  );
}
