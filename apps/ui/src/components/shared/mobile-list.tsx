/**
 * Phone-width list rows (below `md`), lifted from the approval-requests list.
 *
 * A desktop `DataGrid` squeezed into 390px clips its columns: status ends up
 * off-screen and names are cut mid-word. Below `md`, list pages render these
 * rows instead: title, status chip and chevron on the first line, a short
 * meta line under it. Pages keep the `DataGrid` from `md` up.
 */

import { ChevronRight } from "lucide-react";
import { Children, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { Checkbox } from "../ui/checkbox";

export function MobileList({
  children,
  label,
  loading,
  emptyMessage,
  empty,
  footer,
  className,
}: {
  children: ReactNode;
  label: string;
  loading?: boolean;
  emptyMessage: string;
  /** Replaces the dashed `emptyMessage` box, e.g. with an `EmptyState`. */
  empty?: ReactNode;
  /** Rendered under the rows, e.g. a "Show more" button or a pager. */
  footer?: ReactNode;
  className?: string;
}) {
  if (loading) {
    return (
      <div className={cn("flex flex-col gap-2", className)}>
        {[0, 1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-14 rounded-lg" />
        ))}
      </div>
    );
  }
  if (Children.count(children) === 0) {
    if (empty) return <>{empty}</>;
    return (
      <p
        className={cn(
          "rounded-xl border border-dashed border-border px-4 py-10 text-center text-sm text-muted-foreground",
          className,
        )}
      >
        {emptyMessage}
      </p>
    );
  }
  return (
    <div
      className={cn(
        "min-h-0 flex-1 overflow-y-auto rounded-xl border border-border bg-card",
        className,
      )}
    >
      <ul className="divide-y divide-border-subtle" aria-label={label}>
        {children}
      </ul>
      {footer ? <div className="border-t border-border-subtle p-2">{footer}</div> : null}
    </div>
  );
}

export function MobileListRow({
  to,
  onClick,
  selected,
  title,
  leading,
  status,
  meta,
  live,
  check,
  controls,
}: {
  /** Row link. Without it, `onClick` makes the row a button. */
  to?: string;
  onClick?: () => void;
  /** Highlights the row whose detail is open. */
  selected?: boolean;
  title: ReactNode;
  /** Avatar or icon before the title. */
  leading?: ReactNode;
  /** Status chip, kept on the title line so it is never pushed off-screen. */
  status?: ReactNode;
  /** Short facts joined with " · " on the second line. Falsy entries are skipped. */
  meta?: ReactNode[];
  /** Amber rail for rows that are working or waiting on the viewer. */
  live?: boolean;
  /**
   * Selection checkbox in its own 44px tap target BESIDE the row, never inside
   * it (a checkbox is a button; the row may be a button or a link).
   */
  check?: {
    checked: boolean | "indeterminate";
    onChange: () => void;
    label: string;
    disabled?: boolean;
  };
  /**
   * Interactive cells (a checkbox or switch column) in a trailing 44px tap
   * target each. Beside the row for the same reason as `check`: a control
   * inside a button or link row would nest interactive elements.
   */
  controls?: ReactNode[];
}) {
  const facts = (meta ?? []).filter(
    (fact) => fact !== null && fact !== undefined && fact !== false && fact !== "",
  );
  const rowClass = cn(
    "relative flex min-h-11 w-full min-w-0 items-start gap-3 px-4 py-3 text-left outline-none transition-colors hover:bg-accent/40 focus-visible:bg-accent/50 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/60",
    selected && "bg-accent/50",
  );
  const content = (
    <>
      <span
        aria-hidden
        className={cn(
          "absolute inset-y-2 left-0 w-0.5 rounded-full",
          live ? "bg-primary" : "bg-transparent",
        )}
      />
      {leading ? <span className="mt-0.5 shrink-0">{leading}</span> : null}
      <span className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="flex min-w-0 items-start gap-2">
          <span className="min-w-0 flex-1 text-sm font-medium [overflow-wrap:anywhere] line-clamp-2">
            {title}
          </span>
          {status ? <span className="shrink-0">{status}</span> : null}
        </span>
        {facts.length > 0 ? (
          <span className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs text-muted-foreground">
            {facts.map((fact, index) => (
              // Facts are positional and never reorder, so the index is a stable key.
              // The separator trails its fact, so a wrapped line never starts with "·".
              <span key={index} className="inline-flex min-w-0 items-center gap-1.5">
                <span className="min-w-0 truncate">{fact}</span>
                {index < facts.length - 1 ? <span aria-hidden>·</span> : null}
              </span>
            ))}
          </span>
        ) : null}
      </span>
      {to !== undefined || onClick ? (
        <ChevronRight className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
      ) : null}
    </>
  );
  const row =
    to !== undefined ? (
      <Link to={to} className={rowClass}>
        {content}
      </Link>
    ) : onClick ? (
      <button
        type="button"
        className={rowClass}
        onClick={onClick}
        aria-current={selected ? "true" : undefined}
      >
        {content}
      </button>
    ) : (
      <div className={rowClass}>{content}</div>
    );
  const trailing = (controls ?? []).filter(Boolean);
  if (!check && trailing.length === 0) return <li>{row}</li>;
  return (
    <li className="flex items-stretch">
      {check ? (
        <label className="flex w-11 shrink-0 cursor-pointer items-center justify-center pl-2">
          <Checkbox
            checked={check.checked}
            disabled={check.disabled}
            aria-label={check.label}
            onCheckedChange={() => check.onChange()}
          />
        </label>
      ) : null}
      <div className="min-w-0 flex-1">{row}</div>
      {trailing.map((control, index) => (
        // Controls are positional (one per editable column), never reordered.
        <div key={index} className="flex min-h-11 w-11 shrink-0 items-center justify-center">
          {control}
        </div>
      ))}
    </li>
  );
}
