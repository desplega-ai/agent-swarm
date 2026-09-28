import type { ReactNode } from "react";
import { StatusIcon, type StatusTone } from "@/components/shared/status-icon";
import type { AutosavePhase } from "@/hooks/use-autosave";
import { cn } from "@/lib/utils";

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
            ? (error ?? "Not saved.")
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
