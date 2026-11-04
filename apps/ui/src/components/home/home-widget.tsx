import { type ReactNode, useId } from "react";
import { Link } from "react-router-dom";
import { cn } from "@/lib/utils";

/**
 * The one chrome of every Home section: a bordered card with a 44px header
 * (icon, title, a count or status, one action on the right) over a list body.
 * Rows sit directly in the body, divided by subtle rules: never a card inside
 * this card.
 */
export function HomeWidget({
  title,
  icon,
  meta,
  action,
  footer,
  children,
  className,
  bodyClassName,
  id,
}: {
  title: ReactNode;
  icon?: ReactNode;
  /** A count, a pill, or a short status next to the title. */
  meta?: ReactNode;
  /** One action on the right: a `HomeWidgetLink` or a small button. */
  action?: ReactNode;
  /** A muted line under the body. */
  footer?: ReactNode;
  children?: ReactNode;
  className?: string;
  bodyClassName?: string;
  id?: string;
}) {
  const titleId = useId();
  return (
    <section
      id={id}
      aria-labelledby={titleId}
      className={cn(
        "flex min-w-0 flex-col overflow-hidden rounded-xl border border-border bg-card shadow-sm",
        className,
      )}
    >
      <header className="flex h-11 shrink-0 items-center gap-2 pl-4 pr-3">
        {icon}
        <h2 id={titleId} className="min-w-0 truncate text-sm font-semibold">
          {title}
        </h2>
        {meta}
        {action ? <div className="ml-auto flex shrink-0 items-center gap-1">{action}</div> : null}
      </header>
      {children != null && children !== false ? (
        <div className={cn("border-t border-border-subtle", bodyClassName)}>{children}</div>
      ) : null}
      {footer ? (
        <div className="flex items-center gap-1.5 border-t border-border-subtle px-4 py-2.5 text-xs text-muted-foreground">
          {footer}
        </div>
      ) : null}
    </section>
  );
}

/** The header action of a widget: a quiet text link. */
export function HomeWidgetLink({ to, children }: { to: string; children: ReactNode }) {
  return (
    <Link
      to={to}
      className="inline-flex h-7 items-center rounded-md px-2 text-[13px] text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60"
    >
      {children}
    </Link>
  );
}

/** A count next to a widget title, in the muted mono style. */
export function HomeWidgetCount({ children }: { children: ReactNode }) {
  return (
    <span className="shrink-0 whitespace-nowrap font-mono text-xs tabular-nums text-muted-foreground">
      {children}
    </span>
  );
}

/** An empty widget body: one short line. */
export function HomeWidgetEmpty({ children }: { children: ReactNode }) {
  return <p className="px-4 py-4 text-sm text-muted-foreground">{children}</p>;
}
