import {
  Bot,
  CheckCircle2,
  Clock,
  Heart,
  Loader2,
  XCircle,
  Zap,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

interface StatItemProps {
  icon: LucideIcon;
  label: string;
  value: number | string;
  variant?: "default" | "success" | "warning" | "danger";
}

const variantStyles = {
  default: "text-foreground",
  success: "text-emerald-500",
  warning: "text-amber-500",
  danger: "text-red-500",
} as const;

function StatItem({ icon: Icon, label, value, variant = "default" }: StatItemProps) {
  return (
    <div className="flex items-center gap-2 px-3 py-1.5">
      <Icon className={cn("h-3.5 w-3.5", variantStyles[variant])} />
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className={cn("text-sm font-bold font-mono tabular-nums", variantStyles[variant])}>
        {value}
      </span>
    </div>
  );
}

interface StatsBarProps {
  agents?: { total: number; idle: number; busy: number; offline: number };
  tasks?: { total: number; pending: number; in_progress: number; completed: number; failed: number };
  epics?: { active: number };
  healthy?: boolean;
}

export function StatsBar({ agents, tasks, healthy }: StatsBarProps) {
  return (
    <div className="flex flex-wrap items-center gap-0 rounded-lg border border-border bg-muted/30 divide-x divide-border">
      <StatItem icon={Bot} label="Agents" value={agents?.total ?? 0} />
      <StatItem
        icon={Zap}
        label="Busy"
        value={agents?.busy ?? 0}
        variant={(agents?.busy ?? 0) > 0 ? "warning" : "default"}
      />
      <StatItem icon={Clock} label="Pending" value={tasks?.pending ?? 0} />
      <StatItem
        icon={Loader2}
        label="Running"
        value={tasks?.in_progress ?? 0}
        variant={(tasks?.in_progress ?? 0) > 0 ? "warning" : "default"}
      />
      <StatItem
        icon={CheckCircle2}
        label="Done"
        value={tasks?.completed ?? 0}
        variant="success"
      />
      <StatItem
        icon={XCircle}
        label="Failed"
        value={tasks?.failed ?? 0}
        variant={(tasks?.failed ?? 0) > 0 ? "danger" : "default"}
      />
      <StatItem
        icon={Heart}
        label="Health"
        value={healthy ? "OK" : "ERR"}
        variant={healthy ? "success" : "danger"}
      />
    </div>
  );
}
