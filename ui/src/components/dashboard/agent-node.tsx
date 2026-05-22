import { Handle, type NodeProps, Position } from "@xyflow/react";
import { Crown } from "lucide-react";
import type { Agent } from "@/api/types";
import { HarnessIcon } from "@/components/shared/harness-icon";
import { Badge } from "@/components/ui/badge";
import { formatCost } from "@/lib/cost-format";
import { cn } from "@/lib/utils";

// Custom react-flow node for the dashboard agent canvas (Phase 5).
//
// The shape is similar to `WorkflowNodeShell` — bordered card, top input
// handle (workers only), bottom output handle (lead only) — but the body is
// agent-specific: a HarnessIcon + name + optional Lead crown + role pill +
// 24h activity stats (task count, cost). Width/height come from the activity
// score computed in `use-agent-activity.ts`; we forward those as inline
// width/height styles so xyflow's bounding box matches.

export interface AgentNodeData {
  agent: Agent;
  taskCount24h: number;
  cost24h: number;
  width: number;
  height: number;
  isLead: boolean;
  // dagre layout pre-computes positions, but we still want xyflow to see the
  // size for hit testing. Stored on `data` (not on the wrapper) because xyflow
  // re-uses the wrapper for handle positioning.
  [key: string]: unknown;
}

const STATUS_BORDER_CLASS: Record<string, string> = {
  idle: "border-status-success/40",
  busy: "border-status-active/60",
  offline: "border-status-neutral/30",
  waiting_for_credentials: "border-status-warning/50",
};

// Phase 12a — use the shared `formatCost` from `@/lib/cost-format`. The
// dashboard wants `auto` precision (sub-cent placeholder, 4dp under $1,
// 2dp above).

export function AgentNode({ data }: NodeProps) {
  const d = data as unknown as AgentNodeData;
  const { agent, taskCount24h, cost24h, width, height, isLead } = d;
  const borderClass = STATUS_BORDER_CLASS[agent.status] ?? "border-border";
  const harness = agent.harnessProvider ?? agent.provider ?? null;

  return (
    <div
      className={cn(
        "bg-card border-2 rounded-lg shadow-sm px-3 py-2 flex flex-col justify-between",
        borderClass,
      )}
      style={{ width, height }}
    >
      {!isLead ? (
        <Handle
          type="target"
          position={Position.Top}
          id="input"
          className="!bg-muted-foreground/40"
        />
      ) : null}

      <div className="flex items-center gap-2 min-w-0">
        {harness ? (
          <span className="shrink-0 flex h-5 w-5 items-center justify-center rounded bg-muted/40 text-muted-foreground">
            <HarnessIcon harness={harness} className="h-3.5 w-3.5 opacity-100" />
          </span>
        ) : null}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 min-w-0">
            <span className="text-xs font-semibold truncate">{agent.name}</span>
            {isLead ? <Crown className="h-3 w-3 text-primary shrink-0" /> : null}
          </div>
          {agent.role ? (
            <Badge variant="outline" size="tag" className="mt-0.5 max-w-full truncate">
              {agent.role}
            </Badge>
          ) : (
            <span className="block truncate text-[10px] text-muted-foreground uppercase">
              {agent.status.replace(/_/g, " ")}
            </span>
          )}
        </div>
      </div>

      <div className="flex items-center justify-between gap-2 mt-1.5 text-[10px] text-muted-foreground">
        <span className="truncate" title={`${taskCount24h} tasks in last 24h`}>
          <span className="font-mono text-foreground">{taskCount24h}</span> tasks
        </span>
        <span className="truncate" title={`${formatCost(cost24h, { precision: 4 })} in last 24h`}>
          <span className="font-mono text-foreground">{formatCost(cost24h)}</span> · 24h
        </span>
      </div>

      {isLead ? (
        <Handle type="source" position={Position.Bottom} id="default" className="!bg-primary" />
      ) : null}
    </div>
  );
}
