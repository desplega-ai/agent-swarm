import { Loader2, Send } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { AnswerProgress } from "@/lib/approval-format";
import { cn } from "@/lib/utils";
import { KeyHint, MOD } from "./keyboard";

const SNAPPY = [0.2, 0, 0, 1] as const;

/** A number that ticks: the old value slides up and out, the new one in. */
export function Ticker({ value, className }: { value: number; className?: string }) {
  return (
    <span className={cn("relative inline-flex overflow-hidden tabular-nums", className)}>
      <AnimatePresence mode="popLayout" initial={false}>
        <motion.span
          key={value}
          initial={{ y: "70%", opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          exit={{ y: "-70%", opacity: 0 }}
          transition={{ duration: 0.18, ease: SNAPPY }}
        >
          {value}
        </motion.span>
      </AnimatePresence>
    </span>
  );
}

/**
 * Bottom bar: live progress, why Submit is blocked, and Submit
 * (⌘/Ctrl+Enter). Fixed to the viewport on phones (above the iOS home
 * indicator), sticky inside the column from `md`. Slides up on mount.
 * A submission that rejects says so on the button.
 */
export function SubmitBar({
  progress,
  submitting,
  error,
  onSubmit,
}: {
  progress: AnswerProgress;
  submitting: boolean;
  error: string | null;
  onSubmit: () => void;
}) {
  const blocked = progress.blockedReason;
  const pct = progress.total ? (progress.answered / progress.total) * 100 : 0;
  const label = submitting ? "Submitting…" : progress.rejects ? "Submit · reject" : "Submit";
  return (
    <motion.div
      initial={{ y: "100%", opacity: 0 }}
      animate={{ y: 0, opacity: 1 }}
      transition={{ duration: 0.28, ease: SNAPPY, delay: 0.05 }}
      className="fixed inset-x-0 bottom-0 z-30 md:sticky md:inset-x-auto md:z-20 md:-mx-1 md:mt-2 md:px-1"
    >
      <div className="border-t border-border bg-background/95 shadow-[0_-8px_24px_-12px_rgb(0_0_0/0.25)] backdrop-blur supports-[backdrop-filter]:bg-background/80 md:mb-3 md:rounded-xl md:border">
        <div
          className="h-0.5 overflow-hidden bg-muted md:rounded-t-xl"
          role="progressbar"
          aria-label="Answered questions"
          aria-valuemin={0}
          aria-valuemax={progress.total}
          aria-valuenow={progress.answered}
        >
          <motion.div
            className="h-full bg-primary"
            initial={false}
            animate={{ width: `${pct}%` }}
            transition={{ duration: 0.3, ease: SNAPPY }}
          />
        </div>
        <div className="flex items-center gap-3 px-3 pt-2.5 pb-[max(0.625rem,env(safe-area-inset-bottom))] sm:px-4">
          <div className="flex min-w-0 flex-1 flex-col" aria-live="polite">
            <span className="flex items-baseline gap-1 text-sm font-medium">
              <Ticker value={progress.answered} />
              <span className="text-muted-foreground">of {progress.total} answered</span>
            </span>
            <span
              className={cn(
                "truncate text-xs",
                error ? "text-status-error-strong" : "text-muted-foreground",
              )}
            >
              {error ??
                blocked ??
                (progress.rejects ? "Submitting rejects the request" : "Ready to submit")}
            </span>
          </div>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                onClick={blocked || submitting ? undefined : onSubmit}
                aria-disabled={blocked || submitting ? true : undefined}
                aria-keyshortcuts="Control+Enter Meta+Enter"
                variant={progress.rejects ? "destructive" : "default"}
                className={cn(
                  "h-11 shrink-0 gap-2 px-5 sm:h-9",
                  "aria-disabled:cursor-not-allowed aria-disabled:opacity-50 aria-disabled:active:scale-100",
                )}
              >
                {submitting ? <Loader2 className="animate-spin" /> : <Send />}
                {label}
                <span className="ml-0.5 hidden gap-0.5 [@media(hover:hover)_and_(pointer:fine)]:inline-flex">
                  <KeyHint tone="inverted">{MOD}</KeyHint>
                  <KeyHint tone="inverted">↵</KeyHint>
                </span>
              </Button>
            </TooltipTrigger>
            <TooltipContent side="top">{blocked ?? `Submit (${MOD}+Enter)`}</TooltipContent>
          </Tooltip>
        </div>
      </div>
    </motion.div>
  );
}
