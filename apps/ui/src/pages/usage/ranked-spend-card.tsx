import { useState } from "react";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { formatCount, formatUsd } from "./usage-format";

const TOP_ROWS = 8;

export interface RankedSpendRow {
  key: string;
  name: string;
  /** Detail page for the row, when it has one. */
  href?: string;
  costUsd: number;
  /** Sessions (agents) or tasks (users). */
  count: number;
  /** Rendered muted and italic (for example autonomous spend with no requester). */
  muted?: boolean;
}

// One line per row, so every cell shares a baseline. The average column
// drops when the card is narrow (phones, two cards side by side on a small
// desktop), so the name keeps room.
const GRID =
  "grid grid-cols-[minmax(0,1fr)_2.75rem_4.25rem_3.5rem] items-center gap-x-3 px-1.5 @sm:grid-cols-[minmax(0,1fr)_2.75rem_4.25rem_3.5rem_3.75rem]";
const NUMBER = "text-right font-mono tabular-nums whitespace-nowrap";

function formatShare(share: number): string {
  return share > 0 && share < 0.1 ? "<0.1%" : `${share.toFixed(1)}%`;
}

/**
 * A ranked spend list: name, share of the listed total, cost, count, and the
 * average per unit. The share also fills the row background as a bar. Shows
 * the top rows, then a toggle for all.
 */
export function RankedSpendCard({
  title,
  nameLabel,
  rows,
  countLabel,
}: {
  title: string;
  /** Column header for the name, for example "Agent". */
  nameLabel: string;
  rows: RankedSpendRow[];
  /** Column header for `count`, for example "Sessions". */
  countLabel: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const sorted = [...rows].sort((a, b) => b.costUsd - a.costUsd);
  const total = sorted.reduce((sum, row) => sum + row.costUsd, 0);
  const visible = expanded ? sorted : sorted.slice(0, TOP_ROWS);

  return (
    <Card className="min-w-0 gap-3 py-5">
      <CardHeader className="px-5">
        <CardTitle>{title}</CardTitle>
      </CardHeader>
      <CardContent className="@container px-5">
        <div
          className={cn(
            GRID,
            "whitespace-nowrap border-b border-border-subtle pb-2 text-xs text-muted-foreground",
          )}
        >
          <span>{nameLabel}</span>
          <span className="text-right">Share</span>
          <span className="text-right">Cost</span>
          <span className="text-right">{countLabel}</span>
          <span className="hidden text-right @sm:block">Avg</span>
        </div>
        <ol className="divide-y divide-border-subtle">
          {visible.map((row) => {
            const share = total > 0 ? (row.costUsd / total) * 100 : 0;
            return (
              <li key={row.key} className={cn(GRID, "relative isolate py-2 text-sm")}>
                <span
                  aria-hidden
                  className={cn(
                    "absolute inset-y-1 left-0 -z-10 rounded-sm",
                    row.muted ? "bg-muted/60" : "bg-muted",
                  )}
                  style={{ width: `${share}%` }}
                />
                <span
                  title={row.name}
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
                  {formatShare(share)}
                </span>
                <span className={NUMBER}>{formatUsd(row.costUsd)}</span>
                <span className={cn(NUMBER, "text-muted-foreground")}>
                  {formatCount(row.count)}
                </span>
                <span className={cn(NUMBER, "hidden text-muted-foreground @sm:block")}>
                  {row.count > 0 ? formatUsd(row.costUsd / row.count) : "n/a"}
                </span>
              </li>
            );
          })}
        </ol>
        {sorted.length > TOP_ROWS ? (
          <Button
            variant="ghost"
            size="xs"
            className="mt-2 text-muted-foreground"
            onClick={() => setExpanded((value) => !value)}
          >
            {expanded ? `Show top ${TOP_ROWS}` : `Show all ${sorted.length}`}
          </Button>
        ) : null}
      </CardContent>
    </Card>
  );
}
