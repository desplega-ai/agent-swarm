import { type MouseEvent, memo, type ReactNode } from "react";
import { TaskSourceMark } from "@/components/shared/task-source-mark";
import { plural } from "@/lib/sessions-v2";
import { cn } from "@/lib/utils";
import { rowPropsEqual, TreeRow as TreeRowFrame } from "./tree-row";
import type { TreeRow } from "./tree-rows";

/**
 * A plain sidebar section header (My groups, Shared with me): the title, and
 * the number of sessions on the right (SPEC R5). The words are drawn only:
 * the tree group it heads carries them as its label. `action` (My groups:
 * New group) sits at the right end.
 */
export function SectionHeader({
  label,
  count,
  action,
  touch,
}: {
  label: string;
  count: number;
  action?: ReactNode;
  /** The phone tree: its icon column starts further in. */
  touch?: boolean;
}) {
  return (
    <div
      className={cn(
        "mx-1.5 mt-3 flex h-7 items-center gap-1.5 font-mono text-meta text-muted-foreground",
        // The words start at the left edge of the rows' icon column.
        touch ? "pl-2.5" : "pl-1.5",
        // The action lines up with the row actions under it.
        action ? "pr-1.5" : "pr-2",
      )}
    >
      <span aria-hidden className="min-w-0 flex-1 truncate tracking-widest uppercase">
        {label}
      </span>
      <span aria-hidden className="shrink-0 tabular-nums">
        {count}
      </span>
      {action}
    </div>
  );
}

export type SourceRow = Extract<TreeRow, { type: "source" }>;

/** The name of a source section, with its session count, for screen readers. */
export function sourceRowLabel(row: SourceRow): string {
  return `${row.label}, ${plural(row.counts.total, "session")}`;
}

/**
 * A source section header (Slack, Telegram, Discord): the section header
 * look with the source logo, and the number of sessions on the right. No
 * other control (SPEC R5). It is a tree row: a click, Enter, or the arrow
 * keys fold the section.
 */
function SourceHeaderView({
  row,
  domId,
  cursor,
  onRowClick,
}: {
  row: SourceRow;
  domId: string;
  cursor: boolean;
  onRowClick: (rowKey: string, event: MouseEvent) => void;
}) {
  return (
    <TreeRowFrame
      id={domId}
      level={0}
      cursor={cursor}
      aria-expanded={row.open}
      aria-label={sourceRowLabel(row)}
      onClick={(event) => onRowClick(row.key, event)}
      className="mt-3 h-7 pr-2 font-mono text-meta text-muted-foreground"
    >
      {/* The logo sits in the rows' icon column, and the name in their label column. */}
      <span className="grid size-4 shrink-0 place-items-center">
        <TaskSourceMark source={row.source} />
      </span>
      <span className="min-w-0 flex-1 truncate tracking-widest uppercase">{row.label}</span>
      <span className="shrink-0 tabular-nums">{row.counts.total}</span>
    </TreeRowFrame>
  );
}

export const SourceHeader = memo(SourceHeaderView, rowPropsEqual);

/** A section and the rows under it, so the section can label its tree group. */
export interface TreeSegment {
  section: Extract<TreeRow, { type: "section" }> | null;
  rows: TreeRow[];
}

export function segmentsOf(rows: TreeRow[]): TreeSegment[] {
  const segments: TreeSegment[] = [{ section: null, rows: [] }];
  for (const row of rows) {
    if (row.type === "section") segments.push({ section: row, rows: [] });
    // A source header names its own rows: they leave the section above it.
    else if (row.type === "source") segments.push({ section: null, rows: [row] });
    else segments[segments.length - 1].rows.push(row);
  }
  return segments;
}

/**
 * A section's rows as a tree group with its header. Screen readers hear the
 * section when the cursor enters its rows. Desktop and phone trees share it.
 */
export function TreeSection({
  section,
  describedBy,
  action,
  touch,
  children,
}: {
  section: NonNullable<TreeSegment["section"]>;
  describedBy?: string;
  /** The phone tree. */
  touch?: boolean;
  /** A control at the right end of the header. */
  action?: ReactNode;
  children: ReactNode;
}) {
  const unit = section.unit ?? "session";
  return (
    // biome-ignore lint/a11y/useSemanticElements: a tree groups its items with role="group"; a fieldset is a form control group
    <div
      role="group"
      aria-label={`${section.label}, ${section.count} ${unit}${section.count === 1 ? "" : "s"}`}
      aria-describedby={describedBy}
    >
      <SectionHeader label={section.label} count={section.count} action={action} touch={touch} />
      {children}
    </div>
  );
}
