/**
 * Swarm activity as density: the last 8 hours per agent, one small stacked
 * bar per 15 minutes (30 on phones) for done, failed and running work. A
 * swarm that runs hundreds of tasks an hour stays readable: no task blocks,
 * no overflow chips. Lanes sort by task count, and the quiet agents fold into
 * one lane. Click a bar for the tasks in that slice.
 */

import { Activity } from "lucide-react";
import { type ReactNode, useMemo } from "react";
import { Link } from "react-router-dom";
import { useAgents } from "@/api/hooks/use-agents";
import { useTasks } from "@/api/hooks/use-tasks";
import { TaskStatusIcon } from "@/components/shared/task-status-icon";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Skeleton } from "@/components/ui/skeleton";
import { useElementWidth } from "@/hooks/use-element-width";
import { useMinuteClock } from "@/hooks/use-minute-clock";
import { useIsMobile } from "@/hooks/use-mobile";
import {
  buildDensityLanes,
  type DensityBin,
  type DensityLane,
  densityHourTicks,
  densityPeak,
} from "@/lib/activity-density";
import { taskListTitle } from "@/lib/task-title";
import { cn } from "@/lib/utils";
import { HomeWidget, HomeWidgetCount } from "./home-widget";

const HOUR_MS = 60 * 60 * 1000;
const WINDOW_MS = 8 * HOUR_MS;
/** The newest tasks read; past this the header says the view is partial. */
const TASK_LIMIT = 1200;
const MAX_LANES = 6;
/** Tasks listed in a bar's popover before "more" takes over. */
const LIST_ROWS = 12;
/** Room for one "21:00" axis label (11px mono) and the "now" pill, in px. */
const AXIS_LABEL_PX = 36;
const AXIS_NOW_PX = 30;

function hhmm(ms: number): string {
  const at = new Date(ms);
  return `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;
}

export function ActivityDensity({
  viewToggle,
  className,
}: {
  viewToggle?: ReactNode;
  className?: string;
}) {
  const isMobile = useIsMobile();
  const binMs = (isMobile ? 30 : 15) * 60 * 1000;
  const now = useMinuteClock();
  // The window ends with the bin that holds "now", so the last bar is live.
  const endMs = Math.ceil((now + 1) / binMs) * binMs;
  const startMs = endMs - WINDOW_MS;
  const tasksQ = useTasks(
    {
      createdAfter: new Date(startMs - HOUR_MS).toISOString(),
      limit: TASK_LIMIT,
      orderBy: "createdAt",
      fields: "timeline",
    },
    { keepPreviousData: true, refetchInterval: 30_000 },
  );
  const agentsQ = useAgents(false);
  const tasks = tasksQ.data?.tasks ?? [];

  const lanes = useMemo(
    () =>
      buildDensityLanes({
        tasks,
        agents: (agentsQ.data ?? []).map((agent) => ({ id: agent.id, name: agent.name })),
        startMs,
        endMs,
        binMs,
        maxLanes: MAX_LANES,
      }),
    [tasks, agentsQ.data, startMs, endMs, binMs],
  );
  const peak = densityPeak(lanes);
  const total = lanes.reduce((sum, lane) => sum + lane.total, 0);
  const failed = lanes.reduce((sum, lane) => sum + lane.failed, 0);
  const running = lanes.reduce(
    (sum, lane) => sum + lane.bins.reduce((n, bin) => n + bin.running, 0),
    0,
  );
  const partial = tasks.length >= TASK_LIMIT;
  const [axisRef, axisWidth] = useElementWidth<HTMLDivElement>();
  // Thin the hour labels to the width at hand (every 2h or 3h on a phone) and
  // keep them clear of the "now" pill.
  const hours = densityHourTicks({
    startMs,
    endMs,
    widthPx: axisWidth,
    labelPx: AXIS_LABEL_PX,
    reservePx: AXIS_NOW_PX,
  });

  return (
    <HomeWidget
      className={className}
      bodyClassName="min-h-0 flex-1 overflow-y-auto"
      title={isMobile ? "Activity" : "Swarm activity"}
      icon={<Activity className="size-4 shrink-0 text-muted-foreground" aria-hidden />}
      meta={
        tasksQ.data && !isMobile ? (
          <HomeWidgetCount>
            {total.toLocaleString()}
            {partial ? "+" : ""} tasks · {failed} failed · {running} running · 8h
          </HomeWidgetCount>
        ) : null
      }
      action={viewToggle}
      collapse={{ id: "activity" }}
      footer={
        <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <Legend className="bg-status-success/50">Done</Legend>
          <Legend className="bg-status-error">Failed</Legend>
          <Legend className="bg-status-active">Running</Legend>
          <span className="ml-auto max-sm:hidden">Click a bar for its tasks</span>
        </span>
      }
    >
      {tasksQ.isLoading && !tasksQ.data ? (
        <div className="flex flex-col gap-3 p-4" aria-busy="true">
          <Skeleton className="h-8 w-full" />
          <Skeleton className="h-8 w-full" />
        </div>
      ) : lanes.length === 0 ? (
        <p className="px-4 py-6 text-sm text-muted-foreground">No activity in the last 8 hours.</p>
      ) : (
        <div className="px-2 pb-2 sm:px-4">
          <div className="grid grid-cols-1 md:grid-cols-[11rem_minmax(0,1fr)]">
            <span className="max-md:hidden" />
            <div ref={axisRef} className="relative h-7" aria-hidden>
              {hours.map((tick) => (
                <span
                  key={tick.at}
                  data-axis-label
                  className="absolute top-2 -translate-x-1/2 whitespace-nowrap font-mono text-[11px] text-muted-foreground"
                  style={{ left: tick.x }}
                >
                  {hhmm(tick.at)}
                </span>
              ))}
              <span
                data-axis-now
                className="absolute right-0 top-1.5 rounded bg-primary px-1 font-mono text-[10px] font-semibold text-primary-foreground"
              >
                now
              </span>
            </div>
          </div>
          <ul className="divide-y divide-border-subtle">
            {lanes.map((lane) => (
              <LaneRow key={lane.id} lane={lane} peak={peak} binMs={binMs} />
            ))}
          </ul>
        </div>
      )}
    </HomeWidget>
  );
}

function Legend({ className, children }: { className: string; children: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span aria-hidden className={cn("size-2.5 rounded-sm", className)} />
      {children}
    </span>
  );
}

function LaneRow({ lane, peak, binMs }: { lane: DensityLane; peak: number; binMs: number }) {
  return (
    // Phones stack the name and counts over full-width bars; a 6rem gutter
    // cut both to one word.
    <li className="grid grid-cols-1 pt-1.5 md:h-11 md:grid-cols-[11rem_minmax(0,1fr)] md:items-center md:pt-0">
      <div
        className="flex min-w-0 items-baseline gap-2 md:block md:pr-3"
        title={lane.members?.join(", ")}
      >
        <p className="min-w-0 truncate text-[13px] font-medium">{lane.name}</p>
        <p className="shrink-0 whitespace-nowrap font-mono text-[11px] text-muted-foreground md:truncate">
          {lane.total} tasks
          {lane.failed > 0 ? (
            <span className="text-status-error-strong"> · {lane.failed} failed</span>
          ) : null}
        </p>
      </div>
      <div className="flex h-9 items-end gap-px py-1.5 md:h-full">
        {lane.bins.map((bin) => (
          <Bar key={bin.start} lane={lane} bin={bin} peak={peak} binMs={binMs} />
        ))}
      </div>
    </li>
  );
}

function Bar({
  lane,
  bin,
  peak,
  binMs,
}: {
  lane: DensityLane;
  bin: DensityBin;
  peak: number;
  binMs: number;
}) {
  const count = bin.done + bin.failed + bin.running;
  if (count === 0) {
    return <span aria-hidden className="h-px flex-1 rounded-full bg-border-subtle" />;
  }
  // A floor keeps a single task visible next to a peak of hundreds.
  const height = Math.max(12, (count / Math.max(peak, 1)) * 100);
  const range = `${hhmm(bin.start)} to ${hhmm(bin.start + binMs)}`;
  const parts = [
    bin.done ? `${bin.done} done` : null,
    bin.failed ? `${bin.failed} failed` : null,
    bin.running ? `${bin.running} running` : null,
  ]
    .filter(Boolean)
    .join(", ");
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={`${lane.name}, ${range}: ${parts}`}
          className="group flex h-full min-w-0 flex-1 flex-col justify-end rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
        >
          <span
            className="flex w-full flex-col overflow-hidden rounded-[2px] opacity-90 transition-opacity group-hover:opacity-100"
            style={{ height: `${height}%` }}
          >
            {bin.failed ? (
              <span className="w-full bg-status-error" style={{ flexGrow: bin.failed }} />
            ) : null}
            {bin.running ? (
              <span className="w-full bg-status-active" style={{ flexGrow: bin.running }} />
            ) : null}
            {bin.done ? (
              <span className="w-full bg-status-success/50" style={{ flexGrow: bin.done }} />
            ) : null}
          </span>
        </button>
      </PopoverTrigger>
      <PopoverContent align="center" className="w-80 p-0">
        <div className="border-b border-border-subtle px-3 py-2">
          <p className="text-sm font-medium">
            {lane.name} · {range}
          </p>
          <p className="text-xs text-muted-foreground">{parts}</p>
        </div>
        <ul className="max-h-72 overflow-y-auto py-1">
          {bin.tasks.slice(0, LIST_ROWS).map((task) => (
            <li key={task.id}>
              <Link
                to={`/tasks/${task.id}`}
                className="grid grid-cols-[14px_minmax(0,1fr)] items-center gap-2 px-3 py-1.5 text-[13px] outline-none hover:bg-accent focus-visible:bg-accent"
              >
                <TaskStatusIcon status={task.status} className="size-3.5" />
                <span className="truncate">{taskListTitle(task)}</span>
              </Link>
            </li>
          ))}
        </ul>
        {bin.tasks.length > LIST_ROWS ? (
          <Link
            to="/tasks"
            className="block border-t border-border-subtle px-3 py-2 text-xs text-muted-foreground outline-none hover:bg-accent hover:text-foreground"
          >
            {bin.tasks.length - LIST_ROWS} more in Tasks
          </Link>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}
