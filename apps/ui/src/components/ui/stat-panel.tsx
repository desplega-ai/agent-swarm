import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { InfoTip } from "@/components/ui/info-tip";
import { cn } from "@/lib/utils";

// StatPanel — a Card-sized stat tile with an icon-bg, label, and value. The
// canonical pre-Phase-9 form lives in api-keys/page.tsx (5 instances) where
// each summary card opens with:
//
//   <Card>
//     <CardContent className="p-3 flex items-center gap-3">
//       <div className="rounded-md bg-status-success/10 p-2">
//         <ShieldCheck className="h-4 w-4 text-status-success-strong" />
//       </div>
//       <div>
//         <p className="text-xs text-muted-foreground">{label}</p>
//         <p className="text-lg font-semibold text-status-success-strong">{value}</p>
//       </div>
//     </CardContent>
//   </Card>
//
// Distinct from `StatsBar` (compact horizontal strip used on the dashboard) —
// `StatPanel` is a Card-sized tile sized for grids of 2–5 columns.

export type StatPanelTone =
  | "neutral"
  | "success"
  | "active"
  | "error"
  | "warning"
  | "info"
  | "pending"
  | "paused";

interface ToneClasses {
  iconBg: string;
  iconText: string;
  valueText?: string;
}

const TONE_CLASSES: Record<StatPanelTone, ToneClasses> = {
  neutral: { iconBg: "bg-muted", iconText: "text-muted-foreground" },
  success: {
    iconBg: "bg-status-success/10",
    iconText: "text-status-success-strong",
    valueText: "text-status-success-strong",
  },
  active: {
    iconBg: "bg-status-active/10",
    iconText: "text-status-active-strong",
    valueText: "text-status-active-strong",
  },
  error: {
    iconBg: "bg-status-error/10",
    iconText: "text-status-error-strong",
    valueText: "text-status-error-strong",
  },
  warning: {
    iconBg: "bg-status-warning/10",
    iconText: "text-status-warning-strong",
    valueText: "text-status-warning-strong",
  },
  info: {
    iconBg: "bg-status-info/10",
    iconText: "text-status-info-strong",
    valueText: "text-status-info-strong",
  },
  pending: {
    iconBg: "bg-status-pending/10",
    iconText: "text-status-pending-strong",
    valueText: "text-status-pending-strong",
  },
  paused: {
    iconBg: "bg-status-paused/10",
    iconText: "text-status-paused-strong",
    valueText: "text-status-paused-strong",
  },
};

export interface StatPanelProps {
  icon: LucideIcon;
  label: ReactNode;
  value: ReactNode;
  // One-sentence plain-language explanation, shown in a hoverable InfoTip
  // next to the label.
  info?: ReactNode;
  tone?: StatPanelTone;
  // When true, the numeric value is tinted with the tone color (matches the
  // api-keys "Available" / "Rate Limited" cards). When false (default), only
  // the icon picks up the tone — the value stays foreground for legibility.
  colorValue?: boolean;
  className?: string;
}

export function StatPanel({
  icon: Icon,
  label,
  value,
  info,
  tone = "neutral",
  colorValue = false,
  className,
}: StatPanelProps) {
  const t = TONE_CLASSES[tone];
  return (
    <Card className={className}>
      <CardContent className="p-3 flex items-center gap-3">
        <div className={cn("rounded-md p-2", t.iconBg)}>
          <Icon className={cn("h-4 w-4", t.iconText)} />
        </div>
        <div className="min-w-0">
          <p className="flex items-center gap-1 text-xs text-muted-foreground">
            <span className="truncate">{label}</span>
            {info ? <InfoTip content={info} /> : null}
          </p>
          <p
            className={cn("text-lg font-semibold", colorValue && t.valueText ? t.valueText : null)}
          >
            {value}
          </p>
        </div>
      </CardContent>
    </Card>
  );
}
