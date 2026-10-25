import type { ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

/** The state of one credential: a pool key, a ChatGPT account, an API key row. */
export type KeyStatusTone = "success" | "error" | "warning" | "neutral";

const TONE: Record<KeyStatusTone, { dot: string; chip: string }> = {
  success: {
    dot: "bg-status-success",
    chip: "border-status-success/30 text-status-success-strong",
  },
  error: { dot: "bg-status-error", chip: "border-status-error/30 text-status-error-strong" },
  warning: {
    dot: "bg-status-warning",
    chip: "border-status-warning/30 text-status-warning-strong",
  },
  neutral: {
    dot: "bg-status-neutral",
    chip: "border-status-neutral/30 text-status-neutral-strong",
  },
};

/** The 9px uppercase chip with a status dot ("VERIFIED", "REJECTED", ...). */
export function KeyStatusPill({
  tone,
  title,
  children,
}: {
  tone: KeyStatusTone;
  /** Hover text. Never the only place for required information. */
  title?: string;
  children: ReactNode;
}) {
  return (
    <Badge variant="outline" size="tag" className={cn("gap-1.5", TONE[tone].chip)} title={title}>
      <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", TONE[tone].dot)} />
      {children}
    </Badge>
  );
}
