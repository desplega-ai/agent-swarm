import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";

// StatPanel — a Card-sized stat tile with an icon-bg, label, and value. The
// canonical pre-Phase-9 form lives in api-keys/page.tsx (5 instances) where
// each summary card opens with:
//
//   <Card>
//     <CardContent className="p-3 flex items-center gap-3">
//       <div className="rounded-md bg-status-success/10 p-2">
//         <ShieldCheck className="h-4 w-4 text-status-success" />
//       </div>
//       <div>
//         <p className="text-xs text-muted-foreground">{label}</p>
//         <p className="text-lg font-semibold text-status-success">{value}</p>
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
    iconText: "text-status-success",
    valueText: "text-status-success",
  },
  active: {
    iconBg: "bg-status-active/10",
    iconText: "text-status-active",
    valueText: "text-status-active",
  },
  error: {
    iconBg: "bg-status-error/10",
    iconText: "text-status-error",
    valueText: "text-status-error",
  },
  warning: {
    iconBg: "bg-status-warning/10",
    iconText: "text-status-warning",
    valueText: "text-status-warning",
  },
  info: {
    iconBg: "bg-status-info/10",
    iconText: "text-status-info",
    valueText: "text-status-info",
  },
  pending: {
    iconBg: "bg-status-pending/10",
    iconText: "text-status-pending",
    valueText: "text-status-pending",
  },
  paused: {
    iconBg: "bg-status-paused/10",
    iconText: "text-status-paused",
    valueText: "text-status-paused",
  },
};

export interface StatPanelProps {
  icon: LucideIcon;
  label: ReactNode;
  value: ReactNode;
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
          <p className="text-xs text-muted-foreground truncate">{label}</p>
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
