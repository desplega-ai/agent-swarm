/**
 * "Up next" on Home: the enabled schedules that run soonest, with when they
 * run and how often. Folded by default: it is context, not a to-do.
 */

import { CalendarClock, Clock } from "lucide-react";
import { useMemo } from "react";
import { Link } from "react-router-dom";
import { useScheduledTasks } from "@/api/hooks/use-schedules";
import type { ScheduledTask } from "@/api/types";
import { Skeleton } from "@/components/ui/skeleton";
import { useMinuteClock } from "@/hooks/use-minute-clock";
import { scheduleCadence } from "@/lib/schedule-format";
import { formatNextRun } from "@/lib/use-case-overview";
import { HomeWidget, HomeWidgetCount, HomeWidgetEmpty, HomeWidgetLink } from "./home-widget";
import { SectionBody } from "./section-state";

/** Rows shown; the header link opens the rest. */
const ROWS = 6;

/** Enabled schedules with a next run, soonest first. */
export function upcomingSchedules(schedules: ScheduledTask[]): ScheduledTask[] {
  return schedules
    .filter((schedule) => schedule.enabled && schedule.nextRunAt)
    .sort((a, b) => (a.nextRunAt ?? "").localeCompare(b.nextRunAt ?? ""));
}

export function UpNext({ className }: { className?: string }) {
  const schedules = useScheduledTasks({ enabled: true });
  const now = useMinuteClock();
  const upcoming = useMemo(() => upcomingSchedules(schedules.data ?? []), [schedules.data]);

  return (
    <HomeWidget
      className={className}
      title="Up next"
      icon={<CalendarClock className="size-4 shrink-0 text-muted-foreground" aria-hidden />}
      meta={schedules.data ? <HomeWidgetCount>{upcoming.length}</HomeWidgetCount> : null}
      action={<HomeWidgetLink to="/schedules">Schedules</HomeWidgetLink>}
      collapse={{ id: "up-next", defaultCollapsed: true }}
    >
      <SectionBody query={schedules} what="schedules">
        {schedules.isLoading && !schedules.data ? (
          <div className="flex flex-col gap-3 px-4 py-3" aria-busy="true">
            <Skeleton className="h-4 w-1/2" />
            <Skeleton className="h-4 w-2/3" />
          </div>
        ) : upcoming.length === 0 ? (
          <HomeWidgetEmpty>No scheduled runs.</HomeWidgetEmpty>
        ) : (
          <ul className="divide-y divide-border-subtle">
            {upcoming.slice(0, ROWS).map((schedule) => {
              const next = formatNextRun(schedule.nextRunAt ?? "", now);
              return (
                <li key={schedule.id}>
                  <Link
                    to={`/schedules/${schedule.id}`}
                    title={next.when}
                    className="grid h-10 grid-cols-[14px_minmax(0,1fr)_auto] items-center gap-2.5 px-4 text-[13px] outline-none transition-colors hover:bg-accent focus-visible:bg-accent"
                  >
                    <Clock className="size-3.5 text-muted-foreground" aria-hidden />
                    <span className="min-w-0 truncate">
                      {schedule.name}
                      <span className="text-muted-foreground"> · {scheduleCadence(schedule)}</span>
                    </span>
                    <span className="whitespace-nowrap font-mono text-[11px] tabular-nums text-muted-foreground">
                      {next.in === "now" ? "now" : `in ${next.in}`}
                    </span>
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </SectionBody>
    </HomeWidget>
  );
}
