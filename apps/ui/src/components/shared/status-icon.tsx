import { AlertCircle, AlertTriangle, Check, CircleCheck } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { type ReactNode, useState } from "react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

/**
 * One status vocabulary (`/setup`, credentials panels, ...): a small icon
 * with its meaning in a tooltip, instead of a sentence.
 *
 * - `done`: verified or connected, inside `/setup`. Amber like its stepper:
 *   no green checks next to amber progress.
 * - `success`: verified or healthy, outside `/setup` (green check).
 * - `busy`: something is running now: a save, a probe, a worker check (amber ring).
 * - `saved`: stored, nothing to verify yet (quiet check).
 * - `dirty`: an edit waits for the debounce (hollow ring).
 * - `warning` / `error`: needs attention.
 * - `none`: keeps the slot, shows nothing.
 */
export type StatusTone =
  | "done"
  | "success"
  | "busy"
  | "saved"
  | "dirty"
  | "warning"
  | "error"
  | "none";

const SNAPPY = [0.2, 0, 0, 1] as const;

/** Circular progress: the amber ring the dashboard uses for real waits. */
function Spinner({ className }: { className?: string }) {
  return (
    <span
      aria-hidden
      className={cn(
        "block size-3.5 shrink-0 animate-spin rounded-full border-2 border-primary/25 border-t-primary motion-reduce:animate-none",
        className,
      )}
    />
  );
}

function Glyph({ tone }: { tone: Exclude<StatusTone, "none"> }) {
  switch (tone) {
    case "done":
      return <CircleCheck className="size-4 text-primary" aria-hidden />;
    case "success":
      return <CircleCheck className="size-4 text-status-success-strong" aria-hidden />;
    case "busy":
      return <Spinner />;
    case "saved":
      return <Check className="size-3.5 text-muted-foreground" aria-hidden />;
    case "dirty":
      return (
        <span
          aria-hidden
          className="block size-3 rounded-full border-[1.5px] border-muted-foreground/40"
        />
      );
    case "warning":
      return <AlertTriangle className="size-4 text-status-warning-strong" aria-hidden />;
    case "error":
      return <AlertCircle className="size-4 text-status-error-strong" aria-hidden />;
  }
}

/**
 * Status icon with a tooltip. The label is also the accessible name, and it
 * sits in a polite live region, so screen readers hear state changes. One
 * root for every tone: the tooltip stays mounted (only its content and
 * `open` change), so the live region and the icon motion never remount. With
 * a label the icon takes focus, so keyboard users can read the tooltip too.
 */
export function StatusIcon({
  tone,
  label,
  focusable = true,
  className,
}: {
  tone: StatusTone;
  /** Short meaning, shown on hover and read by screen readers. */
  label?: ReactNode;
  /** Pass `false` inside a button: a button must not contain a focusable element. */
  focusable?: boolean;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const hasLabel = Boolean(label) && tone !== "none";
  return (
    <Tooltip open={hasLabel && open} onOpenChange={setOpen}>
      <TooltipTrigger asChild>
        <output
          aria-live="polite"
          tabIndex={hasLabel && focusable ? 0 : undefined}
          className={cn(
            "relative inline-flex size-4 shrink-0 items-center justify-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring/60",
            className,
          )}
        >
          <AnimatePresence initial={false}>
            {tone === "none" ? null : (
              <motion.span
                key={tone}
                className="absolute inset-0 flex items-center justify-center"
                initial={{ opacity: 0, scale: 0.6 }}
                animate={{ opacity: 1, scale: 1, transition: { duration: 0.18, ease: SNAPPY } }}
                exit={{ opacity: 0, scale: 0.6, transition: { duration: 0.1, ease: SNAPPY } }}
              >
                <Glyph tone={tone} />
              </motion.span>
            )}
          </AnimatePresence>
          {hasLabel ? <span className="sr-only">{label}</span> : null}
        </output>
      </TooltipTrigger>
      {hasLabel ? <TooltipContent className="max-w-64">{label}</TooltipContent> : null}
    </Tooltip>
  );
}

/**
 * One short status line: icon plus a few words ("Verified by 2 agents").
 * `busy` is the amber ring with shimmer text, only for real waits (a worker
 * check, a device approval, the lead coming online); both go static under
 * reduced motion. Phrasing content only, so it can sit in an `<output>`.
 */
export function StatusLine({
  tone,
  children,
  className,
}: {
  tone: Exclude<StatusTone, "none" | "dirty">;
  children: ReactNode;
  className?: string;
}) {
  return (
    <span className={cn("flex items-center gap-2 text-sm", className)}>
      <span className="inline-flex size-4 shrink-0 items-center justify-center">
        <Glyph tone={tone} />
      </span>
      <span className={cn("min-w-0", tone === "busy" && "shimmer-text font-medium")}>
        {children}
      </span>
    </span>
  );
}
