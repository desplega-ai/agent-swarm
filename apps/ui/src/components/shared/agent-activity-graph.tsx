import { useMemo } from "react";
import { useAgentTaskActivity } from "@/api/hooks/use-agents";
import {
  type Activity,
  ContributionGraph,
  ContributionGraphBlock,
  ContributionGraphCalendar,
  ContributionGraphFooter,
  ContributionGraphLegend,
  ContributionGraphTotalCount,
} from "@/components/kibo-ui/contribution-graph";
import { Skeleton } from "@/components/ui/skeleton";

const DAYS = 365;
const DAY_MS = 86_400_000;

/** Fills the UTC-day window so every day has a block, levels 0–4 by max. */
function toActivities(rows: { date: string; count: number }[], days: number): Activity[] {
  const counts = new Map(rows.map((row) => [row.date, row.count]));
  const today = Date.parse(`${new Date().toISOString().slice(0, 10)}T00:00:00Z`);
  const window = Array.from({ length: days }, (_, i) =>
    new Date(today - (days - 1 - i) * DAY_MS).toISOString().slice(0, 10),
  );
  const max = Math.max(0, ...window.map((date) => counts.get(date) ?? 0));
  return window.map((date) => {
    const count = counts.get(date) ?? 0;
    return {
      date,
      count,
      level: max === 0 || count === 0 ? 0 : Math.min(4, Math.ceil((count / max) * 4)),
    };
  });
}

/** Daily task-count heatmap for one agent over the last year (UTC days). */
export function AgentActivityGraph({ agentId }: { agentId: string }) {
  const { data, isLoading, isError } = useAgentTaskActivity(agentId, DAYS);
  const activities = useMemo(() => toActivities(data?.days ?? [], DAYS), [data]);

  if (isLoading) return <Skeleton className="h-36 w-full" />;
  if (isError) {
    return <p className="text-sm text-muted-foreground">Task activity is unavailable.</p>;
  }

  return (
    <div className="min-w-0" data-testid="agent-activity-graph">
      <ContributionGraph className="text-muted-foreground" data={activities} fontSize={12}>
        <ContributionGraphCalendar>
          {({ activity, dayIndex, weekIndex }) => (
            <ContributionGraphBlock activity={activity} dayIndex={dayIndex} weekIndex={weekIndex}>
              <title>{`${activity.count} tasks on ${activity.date}`}</title>
            </ContributionGraphBlock>
          )}
        </ContributionGraphCalendar>
        <ContributionGraphFooter>
          <ContributionGraphTotalCount>
            {({ totalCount }) => (
              <span className="text-xs">{totalCount} tasks in the last year</span>
            )}
          </ContributionGraphTotalCount>
          <ContributionGraphLegend />
        </ContributionGraphFooter>
      </ContributionGraph>
    </div>
  );
}
