import { ArrowLeft, ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/button";

interface SetupFooterProps {
  note: string;
  /** Omit to disable Back (step 1). */
  onBack?: () => void;
  /** Omit to hide Skip (step 1, or no connection yet). */
  skip?: { label: string; disabled: boolean; onSkip: () => void };
  primary: { label: string; disabled: boolean; onClick: () => void };
  busy?: boolean;
}

/** Sticky bottom bar: Back, a one-line status note, Skip, and the primary action. */
export function SetupFooter({ note, onBack, skip, primary, busy }: SetupFooterProps) {
  return (
    <footer className="sticky bottom-0 z-30 border-t border-border bg-background">
      <div className="mx-auto flex w-full max-w-[840px] items-center gap-2 px-3 py-2.5 sm:px-5">
        <Button variant="ghost" onClick={onBack} disabled={!onBack || busy}>
          <ArrowLeft />
          Back
        </Button>
        <span className="flex-1" />
        <p className="hidden min-w-0 truncate text-xs text-muted-foreground sm:block">{note}</p>
        {skip ? (
          <Button variant="ghost" onClick={skip.onSkip} disabled={skip.disabled || busy}>
            {skip.label}
          </Button>
        ) : null}
        <Button onClick={primary.onClick} disabled={primary.disabled || busy}>
          {primary.label}
          <ArrowRight />
        </Button>
      </div>
    </footer>
  );
}
