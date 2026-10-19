import type { ReactNode } from "react";
import { Badge } from "@/components/ui/badge";

/** `done` is amber like the stepper: progress never uses the green success tone. */
export type SetupChipTone = "neutral" | "done" | "error" | "info";

const CHIP_TONE: Record<SetupChipTone, string> = {
  neutral: "border-border text-muted-foreground",
  done: "border-primary/30 text-primary",
  error: "border-status-error/30 text-status-error-strong",
  info: "border-status-info/30 text-status-info-strong",
};

/** The 9px uppercase status chip ("DONE", "RECOMMENDED", ...). */
export function SetupChip({
  tone = "neutral",
  children,
}: {
  tone?: SetupChipTone;
  children: ReactNode;
}) {
  return (
    <Badge variant="outline" size="tag" className={CHIP_TONE[tone]}>
      {children}
    </Badge>
  );
}
