import type { LucideIcon } from "lucide-react";
import { Sparkles } from "lucide-react";
import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { useFeatureGate } from "@/api/hooks/use-feature-gate";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface EmptyStateProps {
  icon: LucideIcon;
  title: string;
  description?: string;
  action?: ReactNode;
  /** Entity noun ("app", "workflow", …). When set, renders an "Ask the swarm"
   * shortcut that opens a new session with the composer pre-seeded to set up
   * the first one. Secondary (outline) when a page-specific `action` is also
   * present, primary otherwise. */
  entity?: string;
  /** First-run empty state that IS the page body: stretch to the available
   * height (flex parents) with a viewport-based floor (static parents) so the
   * indicator sits vertically centered instead of hugging the page header. */
  fullPage?: boolean;
  className?: string;
}

export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  entity,
  fullPage,
  className,
}: EmptyStateProps) {
  // `?seed=` is the NewSessionView composer-prefill contract. `/sessions`
  // itself is version-gated (it renders UpgradeRequired below 1.76.0), so the
  // CTA only appears once the connected API confirms support — otherwise it
  // would be a dead action on compatibility deployments.
  const sessionsGate = useFeatureGate("1.76.0");
  const askHref =
    entity && sessionsGate.supported
      ? `/sessions?seed=${encodeURIComponent(`Hey, help me set up my first ${entity}`)}`
      : null;

  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center py-16 text-center",
        fullPage && "flex-1 min-h-[50vh]",
        className,
      )}
    >
      <div className="flex h-14 w-14 items-center justify-center rounded-full bg-muted/50 mb-4">
        <Icon className="h-7 w-7 text-muted-foreground" />
      </div>
      <h3 className="text-sm font-medium">{title}</h3>
      {description && <p className="mt-1 text-sm text-muted-foreground max-w-sm">{description}</p>}
      {(action || askHref) && (
        <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
          {action}
          {askHref && (
            <Button asChild variant={action ? "outline" : "default"} size="sm">
              <Link to={askHref}>
                <Sparkles className="size-3.5" />
                Ask the swarm
              </Link>
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
