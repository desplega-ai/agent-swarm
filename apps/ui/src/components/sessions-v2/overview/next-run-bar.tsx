/**
 * The next-run bar across the top of the Overview (step-10): when the
 * group's next run is, which schedule it is, the last run, the enabled
 * switch of that schedule, and Run now with a caret menu for the other
 * schedules of the group.
 */

import { useQuery } from "@tanstack/react-query";
import { ChevronDown, Clock, Play } from "lucide-react";
import { sessionsQueryOptions } from "@/api/hooks/use-sessions";
import type { ScheduledTask } from "@/api/types";
import { TaskStatusIcon } from "@/components/shared/task-status-icon";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Switch } from "@/components/ui/switch";
import { useCurrentUser } from "@/contexts/current-user-context";
import { cadenceWords, formatNextRun, nextRunSchedule } from "@/lib/use-case-overview";
import { cn, formatRelativeTime } from "@/lib/utils";
import { shortAgo } from "../sidebar/session-row";
import {
  BlockedHint,
  PAUSED_RUN_REASON,
  useAgentNames,
  useRunNow,
  useToggleSchedule,
} from "./run-now";

/** "2h ago", "just now", "Oct 26". */
export function agoWords(iso: string, now: number): string {
  const ago = shortAgo(iso, now);
  if (ago === "now") return "just now";
  return /^\d/.test(ago) ? `${ago} ago` : ago;
}

/** The newest schedule run in the group: its status and age. */
function useLastRun(groupKey: string) {
  const { userId } = useCurrentUser();
  const list = useQuery(
    sessionsQueryOptions(userId ?? null, {
      scope: "tree",
      groupKey,
      source: ["schedule"],
      limit: 1,
    }),
  );
  return list.data?.sessions[0];
}

export function NextRunBar({
  groupKey,
  schedules,
  now,
  onOpen,
}: {
  groupKey: string;
  schedules: ScheduledTask[];
  now: number;
  onOpen: (rootTaskId: string) => void;
}) {
  const next = nextRunSchedule(schedules);
  const lastRun = useLastRun(groupKey);
  const agentName = useAgentNames();
  const runNow = useRunNow();
  const toggle = useToggleSchedule();
  if (!next) return null;
  const due = next.enabled && next.nextRunAt ? formatNextRun(next.nextRunAt, now) : null;
  const others = schedules.filter((schedule) => schedule.id !== next.id);
  const blocked = !next.enabled;

  return (
    <section
      aria-label="Next run"
      className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border border-border bg-card px-3.5 py-2.5"
    >
      <div className="flex min-w-0 items-center gap-2">
        <Clock aria-hidden className="size-4 shrink-0 text-muted-foreground" />
        <span className="text-xs text-muted-foreground">Next run</span>
        {due ? (
          <>
            <span className="text-base font-semibold tabular-nums">{due.when}</span>
            <span className="font-mono text-xs tabular-nums text-muted-foreground">{due.in}</span>
          </>
        ) : (
          <span className="text-sm font-medium text-muted-foreground">Paused</span>
        )}
      </div>
      <div className="flex min-w-0 flex-1 items-center gap-2 border-border-subtle max-sm:basis-full sm:border-l sm:pl-4">
        <span className="max-w-[60%] shrink-0 truncate text-sm font-semibold">{next.name}</span>
        <span className="min-w-0 truncate text-xs text-muted-foreground">
          {cadenceWords(next)} · {agentName(next.targetAgentId)}
        </span>
      </div>
      <div className="flex shrink-0 items-center gap-3 max-sm:w-full max-sm:justify-between">
        {lastRun ? (
          <button
            type="button"
            onClick={() => onOpen(lastRun.root.id)}
            title={formatRelativeTime(lastRun.root.createdAt)}
            className="flex items-center gap-1.5 rounded-sm text-xs text-muted-foreground hover:text-foreground"
          >
            <TaskStatusIcon status={lastRun.latestStatus} className="size-3.5" />
            <span className="whitespace-nowrap">
              Last run {agoWords(lastRun.root.createdAt, now)}
            </span>
          </button>
        ) : (
          <span className="text-xs text-muted-foreground">No runs yet</span>
        )}
        <label className="flex items-center gap-2 border-l border-border-subtle pl-3 text-xs text-muted-foreground">
          <Switch
            checked={next.enabled}
            disabled={toggle.pendingId === next.id}
            onCheckedChange={(enabled) => toggle.toggle(next, enabled)}
            aria-label={`${next.name} enabled`}
          />
          <span className="max-sm:hidden">Enabled</span>
        </label>
        <div className="flex items-center">
          <BlockedHint reason={blocked ? PAUSED_RUN_REASON : null}>
            <Button
              size="sm"
              aria-disabled={blocked || undefined}
              disabled={runNow.pendingId === next.id}
              onClick={() => runNow.run(next)}
              className={cn("aria-disabled:opacity-50", others.length > 0 && "rounded-r-none")}
            >
              <Play />
              Run now
            </Button>
          </BlockedHint>
          {others.length > 0 ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  size="icon-sm"
                  aria-label="Run another schedule"
                  className="w-7 rounded-l-none border-l border-primary-foreground/25"
                >
                  <ChevronDown />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="max-h-80 w-64 overflow-y-auto">
                <DropdownMenuLabel className="text-xs text-muted-foreground">
                  Run now
                </DropdownMenuLabel>
                {others.map((schedule) => (
                  <DropdownMenuItem
                    key={schedule.id}
                    disabled={!schedule.enabled}
                    onSelect={() => runNow.run(schedule)}
                    className="flex items-center gap-2"
                  >
                    <Play className="size-3.5" />
                    <span className="min-w-0 flex-1 truncate">{schedule.name}</span>
                    {schedule.enabled ? null : (
                      <span className="text-xs text-muted-foreground">Paused</span>
                    )}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          ) : null}
        </div>
      </div>
    </section>
  );
}
