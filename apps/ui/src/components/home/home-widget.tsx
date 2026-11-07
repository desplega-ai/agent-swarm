import { ChevronRight } from "lucide-react";
import { type ReactNode, useCallback, useId, useState } from "react";
import { Link } from "react-router-dom";
import { cn } from "@/lib/utils";

const COLLAPSE_KEY = "agent-swarm:home:collapsed:";

function readCollapsed(id: string, fallback: boolean): boolean {
  try {
    const stored = window.localStorage.getItem(COLLAPSE_KEY + id);
    return stored === null ? fallback : stored === "1";
  } catch {
    return fallback;
  }
}

/** A widget's folded state, kept in this browser per widget id. */
export function useHomeCollapsed(id: string | undefined, defaultCollapsed = false) {
  const [collapsed, setCollapsed] = useState(() =>
    id ? readCollapsed(id, defaultCollapsed) : false,
  );
  const toggle = useCallback(() => {
    setCollapsed((prev) => {
      const next = !prev;
      if (id) {
        try {
          window.localStorage.setItem(COLLAPSE_KEY + id, next ? "1" : "0");
        } catch {
          /* best-effort */
        }
      }
      return next;
    });
  }, [id]);
  return { collapsed, toggle };
}

/**
 * The one chrome of every Home section: a bordered card with a 44px header
 * (icon, title, a count or status, one action on the right) over a list body.
 * Rows sit directly in the body, divided by subtle rules: never a card inside
 * this card. With `collapse`, a chevron folds the body away; the header (and
 * its count) stays, and the choice is kept per browser.
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
  collapse,
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
  /** Foldable: `id` keys the stored state, `defaultCollapsed` is the first-visit state. */
  collapse?: { id: string; defaultCollapsed?: boolean };
}) {
  const titleId = useId();
  const bodyId = useId();
  const { collapsed, toggle } = useHomeCollapsed(collapse?.id, collapse?.defaultCollapsed);
  return (
    <section
      id={id}
      aria-labelledby={titleId}
      className={cn(
        "flex min-w-0 flex-col overflow-hidden rounded-xl border border-border bg-card shadow-sm",
        className,
      )}
    >
      <header
        className={cn("flex h-11 shrink-0 items-center gap-2 pr-3", collapse ? "pl-2" : "pl-4")}
      >
        {collapse ? (
          <button
            type="button"
            onClick={toggle}
            aria-expanded={!collapsed}
            aria-controls={bodyId}
            aria-labelledby={titleId}
            className="grid size-6 shrink-0 place-items-center rounded-md text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60"
          >
            <ChevronRight
              aria-hidden
              className={cn("size-4 transition-transform duration-150", !collapsed && "rotate-90")}
            />
          </button>
        ) : null}
        {icon}
        <h2 id={titleId} className="min-w-0 truncate text-sm font-semibold">
          {title}
        </h2>
        {meta}
        {action ? <div className="ml-auto flex shrink-0 items-center gap-1">{action}</div> : null}
      </header>
      {children != null && children !== false && !collapsed ? (
        <div id={bodyId} className={cn("border-t border-border-subtle", bodyClassName)}>
          {children}
        </div>
      ) : null}
      {footer && !collapsed ? (
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
