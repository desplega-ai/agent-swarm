import { ChevronDown } from "lucide-react";
import type { CSSProperties, ReactNode } from "react";
import { AnimatedReveal } from "@/components/shared/animated-reveal";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

/**
 * Shared building blocks for the `/setup` steps, so every step renders the
 * same card anatomy as the round-2 mockup (option B): a bordered card with a
 * header row (icon, title, one-line description, status chip) and a body.
 */

export type SetupChipTone = "neutral" | "success" | "pending" | "error" | "info" | "active";

const CHIP_TONE: Record<SetupChipTone, string> = {
  neutral: "border-border text-muted-foreground",
  success: "border-status-success/30 text-status-success-strong",
  pending: "border-status-pending/30 text-status-pending-strong",
  error: "border-status-error/30 text-status-error-strong",
  info: "border-status-info/30 text-status-info-strong",
  active: "border-status-active/30 text-status-active-strong",
};

/** The 9px uppercase status chip ("NOT SET UP", "VERIFIED", ...). */
export function SetupChip({
  tone = "neutral",
  children,
}: {
  tone?: SetupChipTone;
  children: ReactNode;
}) {
  return (
    <Badge variant="outline" size="tag" className={CHIP_TONE[tone]}>
      {children}
    </Badge>
  );
}

interface SetupCardProps {
  icon?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  /** Right side of the header, usually a `SetupChip`. */
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
          className="flex w-full items-center gap-3 rounded-xl px-4 py-3 hover:bg-accent/50 hover-linger transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
        >
          {header}
        </button>
      ) : (
        <div className="flex items-center gap-3 border-b border-border-subtle px-4 py-3">
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

/**
 * Monochrome brand mark from a file in `public/` (harness-logos,
 * provider-logos, integration-logos). A CSS mask tints the mark with
 * `currentColor`, so it follows the theme like a lucide icon. Decorative:
 * every call site renders the brand name as visible text next to it.
 */
export function BrandLogo({ src, className }: { src: string; className?: string }) {
  const mask: CSSProperties = {
    maskImage: `url(${src})`,
    WebkitMaskImage: `url(${src})`,
    maskSize: "contain",
    WebkitMaskSize: "contain",
    maskRepeat: "no-repeat",
    WebkitMaskRepeat: "no-repeat",
    maskPosition: "center",
    WebkitMaskPosition: "center",
  };
  return (
    <span
      aria-hidden
      className={cn("inline-block size-5 shrink-0 bg-current", className)}
      style={mask}
    />
  );
}
