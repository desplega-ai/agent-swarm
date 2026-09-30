import { Link } from "react-router-dom";
import type { ThreadSwarmState } from "@/lib/comb/thread-status";
import { cn } from "@/lib/utils";

/**
 * The "the swarm works on it" dot: the session log's orb pulse
 * (`.sl-orb`, a static dot under reduced motion).
 */
export function ProcessingDot({ className }: { className?: string }) {
  return (
    <span
      aria-hidden
      className={cn("sl-orb size-1.5 shrink-0 rounded-full bg-status-active", className)}
    />
  );
}

/** The pending dot: the info tone of the `@swarm` chip. */
export function PendingDot({ className }: { className?: string }) {
  return (
    <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full bg-status-info", className)} />
  );
}

const LABEL_CLASS = {
  pending: "text-status-info-strong",
  processing: "text-status-active-strong",
} as const;

/**
 * A thread's swarm state as a dot and a word: "Pending" or "Processing".
 * For rows that are already a link (the folder's comment list).
 */
export function SwarmStateTag({ state }: { state: ThreadSwarmState }) {
  return (
    <span
      className={cn(
        "flex shrink-0 items-center gap-1.5 text-xs font-medium",
        LABEL_CLASS[state.kind],
      )}
    >
      {state.kind === "pending" ? <PendingDot /> : <ProcessingDot />}
      {state.kind === "pending" ? "Pending" : "Processing"}
    </span>
  );
}

/**
 * The thread card's state line under its header. Pending: the comment has
 * `@swarm` and was not sent. Processing: a link to the task the swarm works
 * on. Clicks stay on the link, not the card.
 */
export function SwarmStateLine({ state }: { state: ThreadSwarmState }) {
  if (state.kind === "pending") {
    return (
      <p className="flex items-center gap-1.5 text-xs">
        <PendingDot />
        <span className={cn("font-medium", LABEL_CLASS.pending)}>Pending</span>
        <span className="text-muted-foreground">Not sent to the swarm yet</span>
      </p>
    );
  }
  return (
    <Link
      to={`/tasks/${state.taskId}`}
      onClick={(event) => event.stopPropagation()}
      className="flex w-fit items-center gap-1.5 rounded-sm text-xs underline-offset-2 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring/60"
    >
      <ProcessingDot />
      <span className={cn("font-medium", LABEL_CLASS.processing)}>Processing</span>
      <span className="text-muted-foreground">
        task <span className="font-mono">{state.taskId.slice(0, 8)}</span>
      </span>
    </Link>
  );
}
