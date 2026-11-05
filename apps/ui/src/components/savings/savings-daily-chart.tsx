import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  type TooltipContentProps,
  XAxis,
  YAxis,
} from "recharts";
import type { SavingsDailyPoint } from "@/api/types";
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatCost } from "@/lib/cost-format";
import { rechartsTooltipStyle } from "@/lib/recharts-tooltip-style";
import { cn } from "@/lib/utils";
import { formatDay, formatUsd } from "@/pages/usage/usage-format";

const SAVING_FILL = "var(--color-primary)";
const LOSS_FILL = "var(--color-destructive)";

function TooltipRow({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <p className="flex justify-between gap-6">
      <span className="text-muted-foreground">{label}</span>
      <span className={cn("font-mono tabular-nums", strong && "font-semibold")}>{value}</span>
    </p>
  );
}

function DayTooltip({
  active,
  payload,
  capApplied,
}: TooltipContentProps & { capApplied: boolean }) {
  const point = payload?.[0]?.payload as SavingsDailyPoint | undefined;
  if (!active || !point) return null;
  return (
    <div style={rechartsTooltipStyle} className="max-w-64 space-y-1 px-3 py-2">
      <p className="font-medium">{formatDay(point.day, true)}</p>
      <TooltipRow label="Saved (p50)" value={formatUsd(point.savingUsd)} strong />
      <TooltipRow label="Measured spend" value={formatUsd(point.measuredUsd)} />
      {point.estimatedLlmUsd > 0 ? (
        <TooltipRow label="LLM spend (est.)" value={formatUsd(point.estimatedLlmUsd)} />
      ) : null}
      <TooltipRow label="Substituted-run cost (est.)" value={formatUsd(point.actualUsd)} />
      {capApplied ? (
        <p className="pt-1 text-muted-foreground">
          Scheduled runs are capped at 24 a day over the window; the counted runs are spread pro
          rata across days.
        </p>
      ) : null}
    </div>
  );
}

/**
 * The workflow's p50 saving per UTC day, in the look of the usage page's
 * daily spend chart. The bars sum to the saved amount in the header.
 */
export function SavingsDailyChart({
  points,
  capApplied,
}: {
  points: SavingsDailyPoint[];
  capApplied: boolean;
}) {
  return (
    <Card className="gap-4 py-5">
      <CardHeader className="px-5">
        <CardTitle>Saved per day</CardTitle>
        <CardAction className="text-xs text-muted-foreground">p50, UTC days</CardAction>
      </CardHeader>
      <CardContent className="px-2 sm:px-5">
        <ResponsiveContainer width="100%" height={220}>
          <BarChart data={points} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" vertical={false} />
            <XAxis
              dataKey="day"
              tickFormatter={(day: string) => formatDay(day)}
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
            <ReferenceLine y={0} stroke="var(--color-border)" />
            <Tooltip
              cursor={{ fill: "var(--color-muted)", opacity: 0.6 }}
              content={(props) => <DayTooltip {...props} capApplied={capApplied} />}
            />
            <Bar dataKey="savingUsd" radius={[2, 2, 0, 0]}>
              {points.map((p) => (
                <Cell key={p.day} fill={p.savingUsd < 0 ? LOSS_FILL : SAVING_FILL} />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </CardContent>
    </Card>
  );
}
