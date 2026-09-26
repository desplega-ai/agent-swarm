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
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

export function MobileList({
  children,
  label,
  loading,
  emptyMessage,
  footer,
  className,
}: {
  children: ReactNode;
  label: string;
  loading?: boolean;
  emptyMessage: string;
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
  title,
  leading,
  status,
  meta,
  live,
}: {
  to: string;
  title: ReactNode;
  /** Avatar or icon before the title. */
  leading?: ReactNode;
  /** Status chip, kept on the title line so it is never pushed off-screen. */
  status?: ReactNode;
  /** Short facts joined with " · " on the second line. Falsy entries are skipped. */
  meta?: ReactNode[];
  /** Amber rail for rows that are working or waiting on the viewer. */
  live?: boolean;
}) {
  const facts = (meta ?? []).filter(
    (fact) => fact !== null && fact !== undefined && fact !== false && fact !== "",
  );
  return (
    <li>
      <Link
        to={to}
        className="relative flex min-h-11 items-start gap-3 px-4 py-3 outline-none transition-colors hover:bg-accent/40 focus-visible:bg-accent/50"
      >
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
        <ChevronRight className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
      </Link>
    </li>
  );
}

/** "Show N more" footer for client-side paged mobile lists. */
export function MobileListMore({ count, onMore }: { count: number; onMore: () => void }) {
  if (count <= 0) return null;
  return (
    <Button variant="ghost" className="h-11 w-full text-xs text-muted-foreground" onClick={onMore}>
      Show {count} more
    </Button>
  );
}
