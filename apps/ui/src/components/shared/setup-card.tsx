import { ChevronDown } from "lucide-react";
import type { ReactNode } from "react";
import { AnimatedReveal } from "@/components/shared/animated-reveal";
import { cn } from "@/lib/utils";

/**
 * The card anatomy of the `/setup` steps (round-2 mockup, option B), shared
 * with every surface that wants the same look: a bordered card with a header
 * row (icon, title, one-line description, status icon) and a body.
 * A card without children is a single header row.
 */

interface SetupCardProps {
  icon?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  /** Right side of the header, usually a `StatusIcon`. */
  status?: ReactNode;
  /** Extra header actions (docs link, ...), rendered before `status`. */
  actions?: ReactNode;
  /** Accordion mode: the header toggles the body. Omit for an always-open card. */
  collapsible?: { open: boolean; onOpenChange: (open: boolean) => void };
  /** Amber outline for the selected / open card. */
  active?: boolean;
  className?: string;
  bodyClassName?: string;
  children?: ReactNode;
}

export function SetupCard({
  icon,
  title,
  description,
  status,
  actions,
  collapsible,
  active,
  className,
  bodyClassName,
  children,
}: SetupCardProps) {
  const open = collapsible ? collapsible.open : true;
  const header = (
    <>
      {icon ? (
        <span className="flex size-8 shrink-0 items-center justify-center text-foreground">
          {icon}
        </span>
      ) : null}
      <span className="flex min-w-0 flex-1 flex-col gap-0.5 text-left">
        <span className="text-sm font-semibold leading-tight">{title}</span>
        {description ? <span className="text-xs text-muted-foreground">{description}</span> : null}
      </span>
      {actions}
      {status}
      {collapsible ? (
        <ChevronDown
          className={cn(
            "size-4 shrink-0 text-muted-foreground transition-transform duration-150 ease-snappy",
            open && "rotate-180",
          )}
        />
      ) : null}
    </>
  );

  return (
    <section
      className={cn(
        "rounded-xl border bg-card shadow-sm",
        active ? "border-primary/60" : "border-border",
        className,
      )}
    >
      {collapsible ? (
        <button
          type="button"
          aria-expanded={open}
          onClick={() => collapsible.onOpenChange(!open)}
          className="flex w-full shrink-0 items-center gap-3 rounded-xl px-4 py-3 hover:bg-accent/50 hover-linger transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
        >
          {header}
        </button>
      ) : (
        <div
          className={cn(
            "flex shrink-0 items-center gap-3 px-4 py-3",
            children ? "border-b border-border-subtle" : null,
          )}
        >
          {header}
        </div>
      )}
      {children ? (
        collapsible ? (
          <AnimatedReveal open={open}>
            <div className={cn("border-t border-border-subtle px-4 py-4", bodyClassName)}>
              {children}
            </div>
          </AnimatedReveal>
        ) : (
          <div className={cn("px-4 py-4", bodyClassName)}>{children}</div>
        )
      ) : null}
    </section>
  );
}
