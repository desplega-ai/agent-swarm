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

/**
 * A thread's swarm state as a dot and a word: "Processing". Unsent threads
 * show nothing (the rail's send bar counts them). For rows that are already a
 * link (the folder's comment list).
 */
export function SwarmStateTag({ state }: { state: ThreadSwarmState }) {
  if (state.kind !== "processing") return null;
  return (
    <span className="flex shrink-0 items-center gap-1.5 text-xs font-medium text-status-active-strong">
      <ProcessingDot />
      Processing
    </span>
  );
}

/**
 * The thread card's state line under its header while the swarm works on
 * it: a link to the task. Unsent threads show nothing. Clicks stay on the
 * link, not the card.
 */
export function SwarmStateLine({ state }: { state: ThreadSwarmState }) {
  if (state.kind !== "processing") return null;
  return (
    <Link
      to={`/tasks/${state.taskId}`}
      onClick={(event) => event.stopPropagation()}
      className="flex w-fit items-center gap-1.5 rounded-sm text-xs underline-offset-2 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring/60"
    >
      <ProcessingDot />
      <span className="font-medium text-status-active-strong">Processing</span>
      <span className="text-muted-foreground">
        task <span className="font-mono">{state.taskId.slice(0, 8)}</span>
      </span>
    </Link>
  );
}
