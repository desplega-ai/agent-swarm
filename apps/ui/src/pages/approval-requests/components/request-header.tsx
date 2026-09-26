import { ArrowLeft, CircleCheck, CircleSlash, CircleX, Clock, Keyboard, Users } from "lucide-react";
import { motion } from "motion/react";
import { type ReactNode, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import type { ApprovalRequest } from "@/api/types";
import { StatusBadge } from "@/components/shared/status-badge";
import { StatusLine } from "@/components/shared/status-icon";
import { UserChip } from "@/components/shared/user-chip";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useUserLookup } from "@/hooks/use-user-name";
import {
  approvalRequestSource,
  approverParts,
  formatRemaining,
  humanizeSeconds,
} from "@/lib/approval-format";
import { cn, formatSmartTime, parseUTCDate } from "@/lib/utils";
import { WRAP } from "./answer-view";
import { KeyHint } from "./keyboard";

/** Re-renders every `intervalMs` while `active`. */
function useNow(active: boolean, intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const id = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(id);
  }, [active, intervalMs]);
  return now;
}

const SOURCE_LABEL = { workflow: "Workflow run", agent: "Agent task", manual: "Manual" } as const;

export function RequestHeader({
  request,
  showKeys,
  onOpenShortcuts,
}: {
  request: ApprovalRequest;
  showKeys: boolean;
  onOpenShortcuts: () => void;
}) {
  const isPending = request.status === "pending";
  const expiresAt = request.expiresAt ? parseUTCDate(request.expiresAt).getTime() : null;
  const now = useNow(isPending && expiresAt !== null);
  const source = approvalRequestSource(request);
  const lookupUser = useUserLookup();
  const sourceTo = request.workflowRunId
    ? `/workflow-runs/${request.workflowRunId}`
    : request.sourceTaskId
      ? `/tasks/${request.sourceTaskId}`
      : null;

  return (
    <header className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <Tooltip>
          <TooltipTrigger asChild>
            <Link
              to="/approval-requests"
              aria-label="Back to approval requests"
              aria-keyshortcuts="Escape"
              className="-ml-2 flex size-10 items-center justify-center gap-1 rounded-md text-muted-foreground outline-none transition-colors hover:bg-accent/60 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60 sm:size-auto sm:h-8 sm:px-2"
            >
              <ArrowLeft className="size-4" />
              {showKeys ? <KeyHint>Esc</KeyHint> : null}
            </Link>
          </TooltipTrigger>
          <TooltipContent side="bottom">Back to the list (Esc)</TooltipContent>
        </Tooltip>
        <StatusBadge status={request.status} />
        <span className="flex-1" />
        {showKeys ? (
          <button
            type="button"
            onClick={onOpenShortcuts}
            aria-keyshortcuts="Shift+?"
            className="hidden h-8 items-center gap-1.5 rounded-md px-2 text-xs text-muted-foreground outline-none transition-colors hover:bg-accent/60 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60 [@media(hover:hover)_and_(pointer:fine)]:inline-flex"
          >
            <Keyboard className="size-3.5" />
            Shortcuts
            <KeyHint>?</KeyHint>
          </button>
        ) : null}
      </div>

      <h1 className={cn("text-lg font-semibold leading-snug tracking-tight sm:text-xl", WRAP)}>
        {request.title}
      </h1>

      <p className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs text-muted-foreground">
        <span>Created {formatSmartTime(request.createdAt)}</span>
        <span aria-hidden>·</span>
        {sourceTo ? (
          <Link to={sourceTo} className="underline-offset-2 hover:text-foreground hover:underline">
            {SOURCE_LABEL[source]}
          </Link>
        ) : (
          <span>{SOURCE_LABEL[source]}</span>
        )}
        {isPending && request.timeoutSeconds ? (
          <>
            <span aria-hidden>·</span>
            <span className="inline-flex items-center gap-1">
              <Clock className="size-3" aria-hidden />
              Times out after {humanizeSeconds(request.timeoutSeconds)}
            </span>
          </>
        ) : null}
      </p>

      {isPending ? (
        <div className="flex flex-col gap-1 pt-0.5">
          <StatusLine tone="busy">
            Waiting for an answer
            {expiresAt !== null ? ` · ${formatRemaining(expiresAt - now)}` : null}
          </StatusLine>
          <ApproversLine approvers={request.approvers} lookupUser={lookupUser} />
        </div>
      ) : (
        <ResolutionBanner
          request={request}
          resolvedBy={
            request.resolvedBy ? (
              <UserChip userRef={request.resolvedBy} user={lookupUser(request.resolvedBy)} />
            ) : null
          }
        />
      )}
    </header>
  );
}

/** "Needs an answer from [TY Taras]": each approver is a chip, the ID in its tooltip. */
function ApproversLine({
  approvers,
  lookupUser,
}: {
  approvers: ApprovalRequest["approvers"];
  lookupUser: ReturnType<typeof useUserLookup>;
}) {
  const { lead, people, tail } = approverParts(approvers);
  return (
    <span
      className={cn(
        "flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-muted-foreground",
        WRAP,
      )}
    >
      <Users className="size-4 shrink-0" aria-hidden />
      <span>{lead}</span>
      {people.map((person, index) => (
        <span
          key={person.kind === "user" ? `u:${person.ref}` : `r:${person.role}`}
          className="inline-flex min-w-0 items-center"
        >
          {person.kind === "user" ? (
            <UserChip userRef={person.ref} user={lookupUser(person.ref)} />
          ) : (
            <span className="font-medium text-foreground">@{person.role}</span>
          )}
          {index < people.length - 1 ? <span aria-hidden>,</span> : null}
        </span>
      ))}
      {tail ? <span>{tail}</span> : null}
    </span>
  );
}

const RESOLUTION = {
  approved: {
    icon: CircleCheck,
    title: "Approved",
    tone: "border-status-success/30 bg-status-success/10 text-status-success-strong",
  },
  rejected: {
    icon: CircleX,
    title: "Rejected",
    tone: "border-status-error/30 bg-status-error/10 text-status-error-strong",
  },
  timeout: {
    icon: Clock,
    title: "Timed out",
    tone: "border-status-error/30 bg-status-error/5 text-status-error-strong",
  },
  cancelled: {
    icon: CircleSlash,
    title: "Cancelled",
    tone: "border-border bg-muted/40 text-muted-foreground",
  },
} as const;

/** The outcome, first thing on a resolved request: who, when, and why. */
function ResolutionBanner({
  request,
  resolvedBy,
}: {
  request: ApprovalRequest;
  /** Who answered, as a `UserChip`; null when the request records nobody. */
  resolvedBy: ReactNode;
}) {
  if (request.status === "pending") return null;
  const config = RESOLUTION[request.status];
  const Icon = config.icon;
  const when = request.resolvedAt ? formatSmartTime(request.resolvedAt) : null;
  let detail: ReactNode = null;
  if (request.status === "timeout") {
    detail = request.timeoutSeconds
      ? `No answer within ${humanizeSeconds(request.timeoutSeconds)}`
      : "No answer before the deadline";
  } else if (resolvedBy) {
    detail = <>by {resolvedBy}</>;
  }
  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.98 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={{ duration: 0.24, ease: [0.2, 0, 0, 1] }}
      className={cn("mt-1 flex items-start gap-3 rounded-xl border px-4 py-3", config.tone)}
      role="status"
    >
      <motion.span
        initial={{ scale: 0.4, rotate: -30 }}
        animate={{ scale: 1, rotate: 0 }}
        transition={{ type: "spring", stiffness: 520, damping: 26, delay: 0.05 }}
        className="mt-0.5 flex shrink-0"
      >
        <Icon className="size-5" aria-hidden />
      </motion.span>
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className="text-sm font-semibold">{config.title}</span>
        <span
          className={cn("flex flex-wrap items-center gap-x-1 text-xs text-foreground/80", WRAP)}
        >
          {detail}
          {detail && when ? <span aria-hidden>·</span> : null}
          {when}
        </span>
        {request.resolutionReason ? (
          <span className={cn("text-xs text-foreground/70", WRAP)}>{request.resolutionReason}</span>
        ) : null}
      </span>
    </motion.div>
  );
}
