import { useMemo } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  type TooltipContentProps,
  XAxis,
  YAxis,
} from "recharts";
import type { UsageSummaryDailyRow } from "@/api/types";
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatCost } from "@/lib/cost-format";
import { rechartsTooltipStyle } from "@/lib/recharts-tooltip-style";
import { cn } from "@/lib/utils";
import { DAY_MS, formatCount, formatDay, formatUsd } from "./usage-format";

const SUBSCRIPTION_FILL = "var(--color-primary)";
const PAYG_FILL = "var(--color-muted-foreground)";
const PAYG_OPACITY = 0.45;

interface DayPoint {
  date: string;
  total: number;
  subscription: number;
  payg: number;
  sessions: number;
}

/**
 * One point per day from `from` to `to` (both `YYYY-MM-DD`, UTC). Days with
 * no sessions are zero, so the bars keep a true time scale.
 */
function fillDays(daily: UsageSummaryDailyRow[], from: string, to: string): DayPoint[] {
  const byDate = new Map(daily.map((row) => [row.date, row]));
  const points: DayPoint[] = [];
  for (let t = Date.parse(from); t <= Date.parse(to); t += DAY_MS) {
    const date = new Date(t).toISOString().slice(0, 10);
    const row = byDate.get(date);
    const total = row?.costUsd ?? 0;
    const subscription = Math.min(total, row?.subscriptionCostUsd ?? 0);
    points.push({
      date,
      total,
      subscription,
      payg: total - subscription,
      sessions: row?.sessions ?? 0,
    });
  }
  return points;
}

function Swatch({ fill, opacity = 1 }: { fill: string; opacity?: number }) {
  return (
    <span aria-hidden className="size-2.5 rounded-[2px]" style={{ background: fill, opacity }} />
  );
}

function DayTooltip({ active, payload, split }: TooltipContentProps & { split: boolean }) {
  const point = payload?.[0]?.payload as DayPoint | undefined;
  if (!active || !point) return null;
  return (
    <div style={rechartsTooltipStyle} className="space-y-1 px-3 py-2">
      <p className="font-medium">{formatDay(point.date, true)}</p>
      <TooltipRow label="Total" value={formatUsd(point.total)} strong />
      {split ? (
        <>
          <TooltipRow label="Subscription" value={formatUsd(point.subscription)} />
          <TooltipRow label="Pay-as-you-go" value={formatUsd(point.payg)} />
        </>
      ) : null}
      <TooltipRow label="Sessions" value={formatCount(point.sessions)} />
    </div>
  );
}

function TooltipRow({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <p className="flex justify-between gap-6">
      <span className="text-muted-foreground">{label}</span>
      <span className={cn("font-mono tabular-nums", strong && "font-semibold")}>{value}</span>
    </p>
  );
}

/**
 * Stacked daily spend: subscription runs and pay-as-you-go keys. Older API
 * servers send no split, so the chart draws one series.
 */
export function DailySpendChart({
  daily,
  from,
  to,
}: {
  daily: UsageSummaryDailyRow[];
  /** First day on the axis (`YYYY-MM-DD`). */
  from: string;
  /** Last day on the axis (`YYYY-MM-DD`). */
  to: string;
}) {
  const points = useMemo(() => fillDays(daily, from, to), [daily, from, to]);
  const split = daily.some((row) => row.subscriptionCostUsd !== undefined);

  return (
    <Card className="gap-4 py-5">
      <CardHeader className="px-5">
        <CardTitle>Daily spend</CardTitle>
        {split ? (
          <CardAction className="flex items-center gap-3 text-xs text-muted-foreground">
            <span className="flex items-center gap-1.5">
              <Swatch fill={SUBSCRIPTION_FILL} />
              Subscription
            </span>
            <span className="flex items-center gap-1.5">
              <Swatch fill={PAYG_FILL} opacity={PAYG_OPACITY} />
              Pay-as-you-go
            </span>
          </CardAction>
        ) : null}
      </CardHeader>
      <CardContent className="px-2 sm:px-5">
        <ResponsiveContainer width="100%" height={220}>
          <BarChart data={points} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" vertical={false} />
            <XAxis
              dataKey="date"
              tickFormatter={(date: string) => formatDay(date)}
              tick={{ fontSize: 10, fill: "var(--color-muted-foreground)" }}
              tickLine={false}
              interval="preserveStartEnd"
              minTickGap={24}
            />
            <YAxis
              tickFormatter={(value: number) => formatCost(value, { precision: "compact" })}
              tick={{ fontSize: 10, fill: "var(--color-muted-foreground)" }}
              tickLine={false}
              axisLine={false}
              width={48}
            />
            <Tooltip
              cursor={{ fill: "var(--color-muted)", opacity: 0.6 }}
              content={(props) => <DayTooltip {...props} split={split} />}
            />
            {split ? (
              <>
                <Bar dataKey="subscription" stackId="spend" fill={SUBSCRIPTION_FILL} />
                <Bar
                  dataKey="payg"
                  stackId="spend"
                  fill={PAYG_FILL}
                  fillOpacity={PAYG_OPACITY}
                  radius={[2, 2, 0, 0]}
                />
              </>
            ) : (
              <Bar dataKey="total" fill={SUBSCRIPTION_FILL} radius={[2, 2, 0, 0]} />
            )}
          </BarChart>
        </ResponsiveContainer>
      </CardContent>
    </Card>
  );
}
