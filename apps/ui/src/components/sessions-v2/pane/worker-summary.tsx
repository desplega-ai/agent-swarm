import { ChevronDown } from "lucide-react";
import { AgentAvatarStack } from "@/components/sessions/session-meta";
import { TaskStatusIcon } from "@/components/shared/task-status-icon";
import { formatSpan } from "@/lib/format-duration-ms";
import type { WorkerSummary as Summary } from "@/lib/session-turns";
import { plural } from "@/lib/sessions-v2";
import { cn } from "@/lib/utils";

const ICON = {
  working: "active",
  waiting: "paused",
  done: "done",
  failed: "failed",
  cancelled: "cancelled",
} as const;

/**
 * The folded worker line of a part (SPEC R8.3): the worker avatars, then
 * "Writer worked for 17m" or "2 workers worked for 26m", with a muted
 * "· 2 retries", a red "· 1 failed", or a muted "· 1 cancelled". While work
 * runs: "Coder is working · 3m", with a turning ring and shimmer text. It
 * opens the steps below.
 */
export function WorkerSummaryLine({
  summary,
  nameOf,
  open,
  onToggle,
  controls,
}: {
  summary: Summary;
  nameOf: (agentId: string | null) => string;
  open: boolean;
  onToggle: () => void;
  /** The id of the steps block this line opens. */
  controls: string;
}) {
  const active = summary.state === "working" || summary.state === "waiting";
  const ids = active ? summary.activeAgentIds : summary.agentIds;
  const one = ids.length === 1;
  const subject = one ? nameOf(ids[0] ?? null) : plural(ids.length, "worker");
  const span = formatSpan(summary.durationMs);
  const verb =
    summary.state === "working"
      ? `${one ? "is working" : "working"} · ${span}`
      : summary.state === "waiting"
        ? `${one ? "is queued" : "queued"} · ${span}`
        : `worked for ${span}`;
  return (
    <button
      type="button"
      aria-expanded={open}
      aria-controls={controls}
      onClick={onToggle}
      // Phones and touch screens: the whole 44 px row is the tap target (UX review R9).
      className="hover-linger -ml-1 flex w-fit max-w-full min-w-0 items-center gap-2 rounded-md py-0.5 pr-2 pl-1 text-left text-xs text-muted-foreground transition-colors outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60 max-md:w-full pointer-coarse:min-h-11 pointer-coarse:w-full"
    >
      <TaskStatusIcon variant={ICON[summary.state]} className="size-3.5" />
      <AgentAvatarStack
        agentIds={summary.agentIds}
        max={3}
        nameOf={(id) => (id ? nameOf(id) : undefined)}
        role="img"
        aria-label={summary.agentIds.map((id) => nameOf(id)).join(", ")}
        className="font-mono text-meta"
      />
      <span className={cn("min-w-0 truncate", summary.state === "working" && "shimmer-text")}>
        <span className="font-semibold text-foreground">{subject}</span> {verb}
      </span>
      {summary.failed > 0 ? (
        <span className="shrink-0 text-status-error-strong">· {summary.failed} failed</span>
      ) : summary.cancelled > 0 ? (
        <span className="shrink-0">· {summary.cancelled} cancelled</span>
      ) : summary.retries > 0 && !active ? (
        <span className="shrink-0">
          · {summary.retries === 1 ? "1 retry" : `${summary.retries} retries`}
        </span>
      ) : null}
      <ChevronDown
        aria-hidden
        className={cn(
          "size-3 shrink-0 transition-transform duration-150 ease-snappy",
          !open && "-rotate-90",
        )}
      />
    </button>
  );
}
