import { Link } from "react-router-dom";
import {
  Bot,
  CheckCircle2,
  Clock,
  DollarSign,
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
  to?: string;
}

const variantStyles = {
  default: "text-foreground",
  success: "text-emerald-500",
  warning: "text-amber-500",
  danger: "text-red-500",
} as const;

function StatItem({ icon: Icon, label, value, variant = "default", to }: StatItemProps) {
  const content = (
    <>
      <Icon className={cn("h-3.5 w-3.5", variantStyles[variant])} />
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className={cn("text-sm font-bold font-mono tabular-nums", variantStyles[variant])}>
        {value}
      </span>
    </>
  );

  if (to) {
    return (
      <Link to={to} className="flex items-center gap-2 px-3 py-1.5 hover:bg-muted/50 transition-colors">
        {content}
      </Link>
    );
  }

  return (
    <div className="flex items-center gap-2 px-3 py-1.5">
      {content}
    </div>
  );
}

interface StatsBarProps {
  agents?: { total: number; idle: number; busy: number; offline: number };
  tasks?: { total: number; pending: number; in_progress: number; completed: number; failed: number };
  epics?: { active: number };
  healthy?: boolean;
  costToday?: number;
  costMtd?: number;
}

function formatCostCompact(usd: number): string {
  if (usd < 0.01) return "$0.00";
  return `$${usd.toFixed(2)}`;
}

export function StatsBar({ agents, tasks, healthy, costToday, costMtd }: StatsBarProps) {
  return (
    <div className="flex flex-wrap items-center gap-0 rounded-lg border border-border bg-muted/30 divide-x divide-border">
      <StatItem icon={Bot} label="Agents" value={agents?.total ?? 0} to="/agents" />
      <StatItem
        icon={Zap}
        label="Busy"
        value={agents?.busy ?? 0}
        variant={(agents?.busy ?? 0) > 0 ? "warning" : "default"}
        to="/agents?status=busy"
      />
      <StatItem icon={Clock} label="Pending" value={tasks?.pending ?? 0} to="/tasks?status=pending" />
      <StatItem
        icon={Loader2}
        label="Running"
        value={tasks?.in_progress ?? 0}
        variant={(tasks?.in_progress ?? 0) > 0 ? "warning" : "default"}
        to="/tasks?status=in_progress"
      />
      <StatItem
        icon={CheckCircle2}
        label="Done"
        value={tasks?.completed ?? 0}
        variant="success"
        to="/tasks?status=completed"
      />
      <StatItem
        icon={XCircle}
        label="Failed"
        value={tasks?.failed ?? 0}
        variant={(tasks?.failed ?? 0) > 0 ? "danger" : "default"}
        to="/tasks?status=failed"
      />
      <StatItem
        icon={DollarSign}
        label="Today"
        value={formatCostCompact(costToday ?? 0)}
        to="/usage"
      />
      <StatItem
        icon={DollarSign}
        label="MTD"
        value={formatCostCompact(costMtd ?? 0)}
        to="/usage"
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
