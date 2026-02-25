import {
  Activity,
  Bot,
  CheckCircle2,
  Clock,
  Loader2,
  Milestone,
  XCircle,
  Zap,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { formatCompactNumber } from "@/lib/utils";

interface StatCardProps {
  icon: LucideIcon;
  label: string;
  value: number | string;
  variant?: "default" | "success" | "warning" | "danger";
}

const variantStyles = {
  default: "text-foreground",
  success: "text-emerald-600 dark:text-emerald-400",
  warning: "text-amber-600 dark:text-amber-400",
  danger: "text-red-600 dark:text-red-400",
} as const;

function StatCard({ icon: Icon, label, value, variant = "default" }: StatCardProps) {
  return (
    <Card>
      <CardContent className="p-4">
        <div className="flex items-center gap-2 text-muted-foreground">
          <Icon className="h-4 w-4" />
          <span className="text-xs uppercase tracking-wider">{label}</span>
        </div>
        <div className="mt-2">
          <span
            className={cn(
              "font-mono tabular-nums text-2xl font-bold",
              variantStyles[variant],
            )}
          >
            {typeof value === "number" ? formatCompactNumber(value) : value}
          </span>
        </div>
      </CardContent>
    </Card>
  );
}

interface StatsBarProps {
  agents?: { total: number; idle: number; busy: number; offline: number };
  tasks?: { total: number; pending: number; in_progress: number; completed: number; failed: number };
  epics?: { active: number };
  healthy?: boolean;
}

export function StatsBar({ agents, tasks, epics, healthy }: StatsBarProps) {
  return (
    <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-5 gap-3">
      <StatCard
        icon={Bot}
        label="Agents"
        value={agents?.total ?? 0}
      />
      <StatCard
        icon={Zap}
        label="Busy"
        value={agents?.busy ?? 0}
        variant={(agents?.busy ?? 0) > 0 ? "warning" : "default"}
      />
      <StatCard
        icon={Clock}
        label="Pending"
        value={tasks?.pending ?? 0}
      />
      <StatCard
        icon={Loader2}
        label="Running"
        value={tasks?.in_progress ?? 0}
        variant={(tasks?.in_progress ?? 0) > 0 ? "warning" : "default"}
      />
      <StatCard
        icon={CheckCircle2}
        label="Done"
        value={tasks?.completed ?? 0}
        variant="success"
      />
      <StatCard
        icon={XCircle}
        label="Failed"
        value={tasks?.failed ?? 0}
        variant={(tasks?.failed ?? 0) > 0 ? "danger" : "default"}
      />
      <StatCard
        icon={Milestone}
        label="Epics"
        value={epics?.active ?? 0}
      />
      <StatCard
        icon={Activity}
        label="Health"
        value={healthy ? "OK" : "ERR"}
        variant={healthy ? "success" : "danger"}
      />
    </div>
  );
}
