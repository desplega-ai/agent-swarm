import { ChevronLeft } from "lucide-react";
import type { ReactNode, Ref } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * The top bar of a pushed phone screen (SPEC R8.5): a 44 px back chevron,
 * the title on one line, and the screen's actions on the right.
 */
export function MobileTopBar({
  onBack,
  backLabel = "Back",
  backRef,
  children,
  actions,
  className,
}: {
  onBack: () => void;
  backLabel?: string;
  backRef?: Ref<HTMLButtonElement>;
  /** The title, or a field (rename). */
  children?: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <header
      className={cn(
        "flex h-14 shrink-0 items-center gap-1 border-b border-border-subtle px-1",
        className,
      )}
    >
      <Button
        ref={backRef}
        variant="ghost"
        size="icon"
        aria-label={backLabel}
        onClick={onBack}
        className="size-11 shrink-0"
      >
        <ChevronLeft className="size-6" />
      </Button>
      <div className="flex min-w-0 flex-1 items-center">{children}</div>
      {actions ? <div className="flex shrink-0 items-center gap-1 pr-1">{actions}</div> : null}
    </header>
  );
}
