import type { LucideIcon } from "lucide-react";
import { X } from "lucide-react";
import type { ReactNode } from "react";
import { BorderBeam } from "@/components/shared/border-beam";
import { Button } from "@/components/ui/button";

/**
 * The chrome of a stacked Home card (the fleet benchmark, the telemetry
 * banner): icon tile, title, body, an optional dismiss X. `beam` marks the one
 * ask that waits on the admin.
 */
export function HomeCard({
  icon: Icon,
  title,
  beam = false,
  onDismiss,
  dismissLabel = `Dismiss ${title}`,
  children,
}: {
  icon: LucideIcon;
  title: string;
  beam?: boolean;
  onDismiss?: () => void;
  dismissLabel?: string;
  children: ReactNode;
}) {
  return (
    <section
      aria-label={title}
      className="relative w-full rounded-lg border border-border/60 bg-muted/30 px-3 py-2.5"
    >
      {beam ? <BorderBeam /> : null}
      <div className="flex items-start gap-2.5">
        <div className="flex size-7 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
          <Icon className="size-3.5" aria-hidden="true" />
        </div>
        <div className="min-w-0 flex-1 space-y-2">
          <p className="text-sm font-medium leading-snug">{title}</p>
          {children}
        </div>
        {onDismiss ? (
          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            onClick={onDismiss}
            aria-label={dismissLabel}
            title="Dismiss"
          >
            <X aria-hidden="true" />
          </Button>
        ) : null}
      </div>
    </section>
  );
}

/** A muted one-line note inside a Home card. */
export function HomeCardNote({ children }: { children: ReactNode }) {
  return <p className="text-xs text-muted-foreground">{children}</p>;
}

/** A section under a rule inside a Home card (a perk, a form). */
export function HomeCardDivider({ children }: { children: ReactNode }) {
  return <div className="space-y-2 border-t border-border/60 pt-2">{children}</div>;
}
