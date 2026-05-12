import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

// AlertCallout — an inline status-toned callout box. shadcn's `Alert` only
// supports `default` / `destructive` variants; this primitive covers the
// success/active/warning/info/error/neutral spectrum that we hand-rolled in
// 4+ places (mcp-oauth-panel, workflows/[id], config).
//
// Pre-Phase-9 canonical form:
//
//   <div className="flex items-start gap-2 rounded-md border border-status-error/30 bg-status-error/5 p-3 text-status-error">
//     <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
//     <span>{message}</span>
//   </div>
//
// Use this for status-toned callouts. For default informational alerts and
// the destructive shadcn variant, the existing `Alert` primitive is still
// the right pick.

export type AlertCalloutTone =
  | "success"
  | "active"
  | "error"
  | "warning"
  | "info"
  | "pending"
  | "paused"
  | "neutral";

interface ToneClasses {
  border: string;
  bg: string;
  text: string;
}

const TONE_CLASSES: Record<AlertCalloutTone, ToneClasses> = {
  success: {
    border: "border-status-success/30",
    bg: "bg-status-success/5",
    text: "text-status-success-strong",
  },
  active: {
    border: "border-status-active/30",
    bg: "bg-status-active/5",
    text: "text-status-active-strong",
  },
  error: {
    border: "border-status-error/30",
    bg: "bg-status-error/5",
    text: "text-status-error-strong",
  },
  warning: {
    border: "border-status-warning/30",
    bg: "bg-status-warning/5",
    text: "text-status-warning-strong",
  },
  info: {
    border: "border-status-info/30",
    bg: "bg-status-info/5",
    text: "text-status-info-strong",
  },
  pending: {
    border: "border-status-pending/30",
    bg: "bg-status-pending/5",
    text: "text-status-pending-strong",
  },
  paused: {
    border: "border-status-paused/30",
    bg: "bg-status-paused/5",
    text: "text-status-paused-strong",
  },
  neutral: {
    border: "border-border",
    bg: "bg-muted/30",
    text: "text-muted-foreground",
  },
};

export interface AlertCalloutProps {
  tone: AlertCalloutTone;
  icon?: LucideIcon;
  title?: ReactNode;
  className?: string;
  children: ReactNode;
}

export function AlertCallout({ tone, icon: Icon, title, className, children }: AlertCalloutProps) {
  const t = TONE_CLASSES[tone];
  return (
    <div
      role="alert"
      className={cn(
        "flex items-start gap-2 rounded-md border p-3 text-sm",
        t.border,
        t.bg,
        t.text,
        className,
      )}
    >
      {Icon ? <Icon className="h-4 w-4 mt-0.5 shrink-0" /> : null}
      <div className="min-w-0 flex-1">
        {title ? <p className="font-medium">{title}</p> : null}
        {title ? <div className="text-xs mt-0.5">{children}</div> : <div>{children}</div>}
      </div>
    </div>
  );
}
