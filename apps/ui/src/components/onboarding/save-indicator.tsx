import { AlertCircle, AlertTriangle, Check, CircleCheck } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import type { ReactNode } from "react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import type { AutosavePhase } from "./use-autosave";

/**
 * One status vocabulary for `/setup`: a small icon with its meaning in a
 * tooltip, instead of a sentence.
 *
 * - `done`: verified or connected. Amber like the stepper: Taras asked for no
 *   green checks next to the amber progress.
 * - `busy`: something is running now: a save, a probe, a worker check (amber ring).
 * - `saved`: stored, nothing to verify yet (quiet check).
 * - `dirty`: an edit waits for the debounce (hollow ring).
 * - `warning` / `error`: needs attention.
 * - `none`: keeps the slot, shows nothing.
 */
export type StatusTone = "done" | "busy" | "saved" | "dirty" | "warning" | "error" | "none";

const SNAPPY = [0.2, 0, 0, 1] as const;

/** Circular progress: the amber ring the dashboard uses for real waits. */
export function Spinner({ className }: { className?: string }) {
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
 * sits in a polite live region, so screen readers hear state changes.
 */
export function StatusIcon({
  tone,
  label,
  className,
}: {
  tone: StatusTone;
  /** Short meaning, shown on hover and read by screen readers. */
  label?: ReactNode;
  className?: string;
}) {
  const icon = (
    <output
      aria-live="polite"
      className={cn("relative inline-flex size-4 shrink-0 items-center justify-center", className)}
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
      {label && tone !== "none" ? <span className="sr-only">{label}</span> : null}
    </output>
  );
  if (!label || tone === "none") return icon;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{icon}</TooltipTrigger>
      <TooltipContent className="max-w-64">{label}</TooltipContent>
    </Tooltip>
  );
}

const PHASE_TONE: Record<AutosavePhase, StatusTone> = {
  idle: "none",
  pending: "dirty",
  saving: "busy",
  saved: "saved",
  error: "error",
};

/** Autosave state of one field (or one card) as a `StatusIcon`. */
export function SaveIndicator({
  phase,
  error,
  className,
}: {
  phase: AutosavePhase;
  error?: string | null;
  className?: string;
}) {
  const label =
    phase === "pending"
      ? "Saves when you stop typing"
      : phase === "saving"
        ? "Saving…"
        : phase === "saved"
          ? "Saved"
          : phase === "error"
            ? `Not saved. ${error ?? ""}`.trim()
            : undefined;
  return <StatusIcon tone={PHASE_TONE[phase]} label={label} className={className} />;
}

/**
 * An input (or textarea) with a status icon inside its right edge. Give the
 * control enough right padding (`pr-8`, or `pr-16` with an eye toggle).
 */
export function WithIndicator({
  indicator,
  multiline,
  children,
  className,
}: {
  indicator: ReactNode;
  /** Pin the icon to the top-right corner instead of the vertical center. */
  multiline?: boolean;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("relative", className)}>
      {children}
      <span
        className={cn(
          "absolute right-2.5 flex items-center",
          multiline ? "top-2.5" : "top-1/2 -translate-y-1/2",
        )}
      >
        {indicator}
      </span>
    </div>
  );
}

/** One short status line: icon plus a few words ("Verified by 2 agents"). */
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
    <p className={cn("flex items-center gap-2 text-sm", className)}>
      <span className="inline-flex size-4 shrink-0 items-center justify-center">
        <Glyph tone={tone} />
      </span>
      <span className={cn("min-w-0", tone === "busy" && "shimmer-text font-medium")}>
        {children}
      </span>
    </p>
  );
}
