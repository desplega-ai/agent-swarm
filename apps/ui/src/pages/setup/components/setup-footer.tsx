import { ArrowLeft, ArrowRight, Loader2 } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { type ReactNode, useState } from "react";
import type { OnboardingStepStatus } from "@/api/types";
import { StepStatusGlyph } from "@/components/onboarding/step-status";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { SETUP_COLUMN } from "./setup-layout";

/** Tooltip of the state icon next to the primary action. `todo` shows no icon. */
const STATE_HINT: Partial<Record<OnboardingStepStatus, string>> = {
  done: "Step done",
  skipped: "Skipped. Come back any time.",
  failed: "Last check failed. Retry or skip.",
};

interface SetupFooterProps {
  /** Omit to disable Back (step 1). */
  onBack?: () => void;
  /** Status of the step on screen, shown as an icon. Null before a connection exists. */
  status: OnboardingStepStatus | null;
  /** Work in flight (for example "Saving…"): a spinner with this tooltip replaces the status icon. */
  pending: string | null;
  /** Omit to hide Skip (step 1, or no connection yet). */
  skip?: { label: string; disabled: boolean; onSkip: () => void; hint?: string };
  /** `blockedBy` disables the action and becomes its tooltip. */
  primary: { label: string; onClick: () => void; blockedBy: string | null };
  busy?: boolean;
}

/** Fixed bottom bar: Back on the left; the step state icon, Skip, and the primary action on the right. */
export function SetupFooter({ onBack, status, pending, skip, primary, busy }: SetupFooterProps) {
  const state = stateIcon(status, pending);
  return (
    <footer className="shrink-0 border-t border-border bg-background pb-[env(safe-area-inset-bottom)]">
      <div className={cn(SETUP_COLUMN, "relative flex h-14 items-center gap-2")}>
        <Button variant="ghost" onClick={onBack} disabled={!onBack || busy}>
          <ArrowLeft />
          Back
        </Button>
        <span className="flex-1" />
        {/* `popLayout`: spinner and status icon swap in place, the buttons never move. */}
        <AnimatePresence mode="popLayout" initial={false}>
          {state ? (
            <motion.span
              key={state.key}
              role="img"
              aria-label={state.label}
              initial={{ opacity: 0, scale: 0.6 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.6, transition: { duration: 0.1 } }}
              transition={{ type: "spring", stiffness: 600, damping: 30 }}
              className="mr-1 flex"
            >
              <Hint content={state.label}>{state.icon}</Hint>
            </motion.span>
          ) : null}
        </AnimatePresence>
        {skip ? (
          <Hint content={skip.disabled ? undefined : skip.hint}>
            <Button variant="ghost" onClick={skip.onSkip} disabled={skip.disabled || busy}>
              {skip.label}
            </Button>
          </Hint>
        ) : null}
        <Hint content={primary.blockedBy ?? undefined}>
          {/* `aria-disabled` keeps a blocked Continue focusable and hoverable, so its tooltip can say why. */}
          <Button
            onClick={primary.blockedBy ? undefined : primary.onClick}
            aria-disabled={primary.blockedBy ? true : undefined}
            disabled={busy}
            className="aria-disabled:opacity-50 aria-disabled:hover:bg-primary aria-disabled:active:scale-100"
          >
            {primary.label}
            <ArrowRight />
          </Button>
        </Hint>
      </div>
    </footer>
  );
}

/** The state slot: a spinner while work is in flight, else the status icon (none for `todo`). */
function stateIcon(
  status: OnboardingStepStatus | null,
  pending: string | null,
): { key: string; label: string; icon: ReactNode } | null {
  if (pending) {
    return {
      key: "pending",
      label: pending,
      icon: <Loader2 className="size-[18px] animate-spin text-muted-foreground" />,
    };
  }
  const hint = status ? STATE_HINT[status] : undefined;
  if (!status || !hint) return null;
  return {
    key: status,
    label: hint,
    icon: <StepStatusGlyph status={status} className="size-[18px]" />,
  };
}

/**
 * A top tooltip around `children`. The tooltip stays mounted and only its
 * `open` changes, so a trigger never remounts (and never drops focus) when
 * the text comes and goes.
 */
function Hint({ content, children }: { content?: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <Tooltip open={Boolean(content) && open} onOpenChange={setOpen}>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      {content ? (
        <TooltipContent side="top" sideOffset={6} className="max-w-64">
          {content}
        </TooltipContent>
      ) : null}
    </Tooltip>
  );
}
