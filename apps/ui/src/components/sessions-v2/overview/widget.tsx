/**
 * The frame of an Overview widget (step-10, mockup `r3-overview.html`): a
 * bordered card with a 44 px header (icon, title, count, one action), the
 * body, and an optional muted footer row.
 */

import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export function Widget({
  icon: Icon,
  title,
  count,
  action,
  footer,
  className,
  children,
  label,
}: {
  icon: LucideIcon;
  title: ReactNode;
  /** Muted text after the title ("12 · 1 new"). */
  count?: ReactNode;
  /** One control at the right of the header. */
  action?: ReactNode;
  footer?: ReactNode;
  className?: string;
  children: ReactNode;
  /** The region's accessible name. Default: the title, when it is a string. */
  label?: string;
}) {
  return (
    <section
      aria-label={label ?? (typeof title === "string" ? title : undefined)}
      className={cn(
        "flex min-w-0 flex-col overflow-hidden rounded-lg border border-border bg-card text-card-foreground",
        className,
      )}
    >
      <header className="flex h-11 shrink-0 items-center gap-2 border-b border-border-subtle px-3.5">
        <Icon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
        <h3 className="min-w-0 truncate text-sm font-semibold">{title}</h3>
        {count !== undefined ? (
          <span className="shrink-0 font-mono text-xs tabular-nums text-muted-foreground">
            {count}
          </span>
        ) : null}
        <span className="flex-1" />
        {action}
      </header>
      {children}
      {footer ? (
        <footer className="flex min-h-9 shrink-0 items-center gap-2 border-t border-border-subtle px-3.5 text-xs text-muted-foreground">
          {footer}
        </footer>
      ) : null}
    </section>
  );
}
