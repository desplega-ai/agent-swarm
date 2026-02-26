import { useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { useAutoScroll } from "@/hooks/use-auto-scroll";
import { ArrowDown, ChevronDown, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import type { SessionLog } from "@/api/types";

interface IterationGroup {
  iteration: number;
  logs: SessionLog[];
}

function groupByIteration(logs: SessionLog[]): IterationGroup[] {
  const groups = new Map<number, SessionLog[]>();
  for (const log of logs) {
    const existing = groups.get(log.iteration);
    if (existing) {
      existing.push(log);
    } else {
      groups.set(log.iteration, [log]);
    }
  }
  return Array.from(groups.entries())
    .sort(([a], [b]) => a - b)
    .map(([iteration, iterLogs]) => ({ iteration, logs: iterLogs }));
}

function IterationSection({
  group,
  defaultOpen,
}: {
  group: IterationGroup;
  defaultOpen: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const firstLog = group.logs[0];
  const time = firstLog ? new Date(firstLog.createdAt).toLocaleTimeString() : "";

  return (
    <div className="border-b border-zinc-800 last:border-0">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex w-full items-center gap-2 px-3 py-1.5 text-[11px] text-zinc-500 hover:bg-zinc-900/50 transition-colors"
      >
        {open ? (
          <ChevronDown className="h-3 w-3 shrink-0" />
        ) : (
          <ChevronRight className="h-3 w-3 shrink-0" />
        )}
        <span className="font-semibold text-zinc-400">
          Iteration {group.iteration}
        </span>
        <span className="text-zinc-600">{time}</span>
        <span className="ml-auto text-zinc-600">
          {group.logs.length} line{group.logs.length !== 1 ? "s" : ""}
        </span>
      </button>
      {open && (
        <div className="px-3 pb-2">
          {group.logs.map((log) => (
            <div
              key={log.id}
              className="py-0.5 hover:bg-zinc-900/50 text-zinc-300"
            >
              {log.content}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

interface SessionLogViewerProps {
  logs: SessionLog[];
  className?: string;
}

export function SessionLogViewer({ logs, className }: SessionLogViewerProps) {
  const groups = useMemo(() => groupByIteration(logs), [logs]);

  const [scrollEl, setScrollEl] = useState<HTMLDivElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const { isFollowing, scrollToBottom } = useAutoScroll(scrollEl, [logs]);

  return (
    <div className={cn("flex flex-col rounded-lg border border-zinc-800 bg-zinc-950", className)}>
      <div className="flex items-center justify-between px-3 py-2 border-b border-zinc-800">
        <span className="text-xs font-semibold text-zinc-400 uppercase tracking-wider">
          Session Logs
        </span>
        {!isFollowing && (
          <Button
            size="sm"
            variant="ghost"
            onClick={scrollToBottom}
            className="gap-1 h-6 text-xs text-zinc-400 hover:text-zinc-200"
          >
            <ArrowDown className="h-3 w-3" />
            Follow
          </Button>
        )}
      </div>
      <div
        ref={(el) => {
          scrollRef.current = el;
          setScrollEl(el);
        }}
        className="flex-1 min-h-0 overflow-auto font-mono text-xs leading-relaxed"
      >
        {groups.map((group) => (
          <IterationSection
            key={group.iteration}
            group={group}
            defaultOpen={group.iteration === groups[groups.length - 1]?.iteration}
          />
        ))}
      </div>
    </div>
  );
}
