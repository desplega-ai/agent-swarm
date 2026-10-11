import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
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
import type { SkillUsageDailyRow, SkillUsageWindow } from "@/api/types";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { rechartsTooltipStyle } from "@/lib/recharts-tooltip-style";
import { cn, parseUTCDate } from "@/lib/utils";

export const USAGE_WINDOW_OPTIONS = [
  { value: "7d", label: "7d", tooltip: "Last 7 days" },
  { value: "30d", label: "30d", tooltip: "Last 30 days" },
  { value: "all", label: "All", tooltip: "Since tracking began" },
] as const satisfies readonly { value: SkillUsageWindow; label: string; tooltip: string }[];

export function readUsageWindow(searchParams: URLSearchParams): SkillUsageWindow {
  const value = searchParams.get("window");
  return value === "7d" || value === "all" ? value : "30d";
}

export function UsageWindowControl({
  value,
  onChange,
}: {
  value: SkillUsageWindow;
  onChange: (value: SkillUsageWindow) => void;
}) {
  return (
    <SegmentedControl
      size="sm"
      aria-label="Usage window"
      value={value}
      onValueChange={onChange}
      options={USAGE_WINDOW_OPTIONS}
    />
  );
}

const COUNT = new Intl.NumberFormat();

export function formatCount(value: number): string {
  return COUNT.format(value);
}

export function formatPercent(part: number, whole: number): string {
  if (whole <= 0) return "n/a";
  const pct = (part / whole) * 100;
  return pct > 0 && pct < 1 ? "<1%" : `${Math.round(pct)}%`;
}

/** AG Grid comparator for ISO timestamps: nulls ("never") sort last in both directions. */
export function compareIsoNullsLast(
  a: string | null | undefined,
  b: string | null | undefined,
  _nodeA: unknown,
  _nodeB: unknown,
  isDescending: boolean,
): number {
  if (a === b) return 0;
  if (!a) return isDescending ? -1 : 1;
  if (!b) return isDescending ? 1 : -1;
  return a < b ? -1 : 1;
}

/** `YYYY-MM-DD` of a Date in the viewer's timezone. */
function localDayKey(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function parseDayKey(day: string): Date {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(y ?? 1970, (m ?? 1) - 1, d ?? 1);
}

/** A local `YYYY-MM-DD` day as "Oct 9". */
export function formatLocalDay(day: string, withYear = false): string {
  return parseDayKey(day).toLocaleDateString([], {
    month: "short",
    day: "numeric",
    ...(withYear && { year: "numeric" }),
  });
}

/** An ISO timestamp as "Oct 9, 14:05" in the viewer's timezone. */
export function formatLocalDateTime(iso: string): string {
  return parseUTCDate(iso).toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/**
 * One point per local day from the window start (or the first row, for the
 * all-time window) to today. Days without loads are zero, so the bars keep a
 * true time scale.
 */
function fillDays(daily: SkillUsageDailyRow[], since: string | null): SkillUsageDailyRow[] {
  const byDate = new Map(daily.map((row) => [row.date, row]));
  const today = localDayKey(new Date());
  const first = since ? localDayKey(parseUTCDate(since)) : (daily[0]?.date ?? today);
  const points: SkillUsageDailyRow[] = [];
  for (let day = parseDayKey(first); localDayKey(day) <= today; day.setDate(day.getDate() + 1)) {
    const key = localDayKey(day);
    points.push(byDate.get(key) ?? { date: key, invocations: 0, skills: 0, tasks: 0 });
  }
  return points;
}

function DayTooltip({
  active,
  payload,
  showSkills,
}: TooltipContentProps & { showSkills: boolean }) {
  const point = payload?.[0]?.payload as SkillUsageDailyRow | undefined;
  if (!active || !point) return null;
  return (
    <div style={rechartsTooltipStyle} className="space-y-1 px-3 py-2">
      <p className="font-medium">{formatLocalDay(point.date, true)}</p>
      <TooltipRow label="Loads" value={formatCount(point.invocations)} />
      {showSkills ? <TooltipRow label="Skills" value={formatCount(point.skills)} /> : null}
      <TooltipRow label="Tasks" value={formatCount(point.tasks)} />
    </div>
  );
}

function TooltipRow({ label, value }: { label: string; value: string }) {
  return (
    <p className="flex justify-between gap-6">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-mono tabular-nums">{value}</span>
    </p>
  );
}

/** Daily skill loads as bars, bucketed by the viewer's local day. */
export function DailyUsageChart({
  title,
  daily,
  since,
  showSkills = false,
}: {
  title: string;
  daily: SkillUsageDailyRow[];
  since: string | null;
  /** Show distinct skills per day in the tooltip (swarm-wide view). */
  showSkills?: boolean;
}) {
  const points = useMemo(() => fillDays(daily, since), [daily, since]);
  return (
    <Card className="gap-4 py-5">
      <CardHeader className="px-5">
        <CardTitle>{title}</CardTitle>
      </CardHeader>
      <CardContent className="px-2 sm:px-5">
        <ResponsiveContainer width="100%" height={200}>
          <BarChart data={points} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" vertical={false} />
            <XAxis
              dataKey="date"
              tickFormatter={(date: string) => formatLocalDay(date)}
              tick={{ fontSize: 10, fill: "var(--color-muted-foreground)" }}
              tickLine={false}
              interval="preserveStartEnd"
              minTickGap={24}
            />
            <YAxis
              allowDecimals={false}
              tick={{ fontSize: 10, fill: "var(--color-muted-foreground)" }}
              tickLine={false}
              axisLine={false}
              width={40}
            />
            <Tooltip
              cursor={{ fill: "var(--color-muted)", opacity: 0.6 }}
              content={(props) => <DayTooltip {...props} showSkills={showSkills} />}
            />
            <Bar dataKey="invocations" fill="var(--color-primary)" radius={[2, 2, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </CardContent>
    </Card>
  );
}

const TOP_ROWS = 8;
const RANK_GRID = "grid grid-cols-[minmax(0,1fr)_3rem_4rem] items-center gap-x-3 px-1.5";
const NUMBER = "text-right font-mono tabular-nums whitespace-nowrap";

export interface RankedCountRow {
  key: string;
  name: string;
  href?: string;
  count: number;
  /** Rendered muted and italic (for example a skill the swarm does not manage). */
  muted?: boolean;
  /** Tooltip on the name. */
  hint?: string;
}

/**
 * A ranked count list: name, share of the listed total, and count. The share
 * fills the row background as a bar. Shows the top rows, then a toggle for all.
 */
export function RankedCountCard({
  title,
  nameLabel,
  countLabel,
  rows,
  emptyMessage,
}: {
  title: string;
  nameLabel: string;
  countLabel: string;
  rows: RankedCountRow[];
  emptyMessage: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const total = rows.reduce((sum, row) => sum + row.count, 0);
  const visible = expanded ? rows : rows.slice(0, TOP_ROWS);

  return (
    <Card className="min-w-0 gap-3 py-5">
      <CardHeader className="px-5">
        <CardTitle>{title}</CardTitle>
      </CardHeader>
      <CardContent className="px-5">
        {rows.length === 0 ? (
          <p className="py-4 text-center text-sm text-muted-foreground">{emptyMessage}</p>
        ) : (
          <>
            <div
              className={cn(
                RANK_GRID,
                "whitespace-nowrap border-b border-border-subtle pb-2 text-xs text-muted-foreground",
              )}
            >
              <span>{nameLabel}</span>
              <span className="text-right">Share</span>
              <span className="text-right">{countLabel}</span>
            </div>
            <ol className="divide-y divide-border-subtle">
              {visible.map((row) => {
                const share = total > 0 ? (row.count / total) * 100 : 0;
                return (
                  <li key={row.key} className={cn(RANK_GRID, "relative isolate py-2 text-sm")}>
                    <span
                      aria-hidden
                      className="absolute inset-y-1 left-0 -z-10 rounded-sm bg-muted"
                      style={{ width: `${share}%` }}
                    />
                    <span
                      title={row.hint ?? row.name}
                      className={cn(
                        "truncate",
                        row.muted ? "italic text-muted-foreground" : "font-medium",
                      )}
                    >
                      {row.href ? (
                        <Link to={row.href} className="hover:underline">
                          {row.name}
                        </Link>
                      ) : (
                        row.name
                      )}
                    </span>
                    <span className={cn(NUMBER, "text-xs text-muted-foreground")}>
                      {share > 0 && share < 1 ? "<1%" : `${Math.round(share)}%`}
                    </span>
                    <span className={NUMBER}>{formatCount(row.count)}</span>
                  </li>
                );
              })}
            </ol>
            {rows.length > TOP_ROWS ? (
              <Button
                variant="ghost"
                size="xs"
                className="mt-2 text-muted-foreground"
                onClick={() => setExpanded((value) => !value)}
              >
                {expanded ? `Show top ${TOP_ROWS}` : `Show all ${rows.length}`}
              </Button>
            ) : null}
          </>
        )}
      </CardContent>
    </Card>
  );
}
