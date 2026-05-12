import { Handle, Position } from "@xyflow/react";
import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

// WorkflowNodeShell — shared bordered card shell + icon-tile + label + type
// row + handle layout used by all three workflow node types (action,
// condition, trigger). Pre-Phase-9 each file hand-rolled an identical shell:
//
//   <div className="bg-card border-2 rounded-lg shadow-sm px-3 py-2 min-w-[240px] max-w-[280px] {borderColor}">
//     <Handle type="target" position={Position.Top} id="input" className={handleClass} />
//     <div className="flex items-center gap-2">
//       <div className="p-1 rounded bg-action-X/10">
//         <Icon className="h-4 w-4 text-action-X" />
//       </div>
//       <div className="flex-1 min-w-0">
//         <div className="text-xs font-medium truncate">{label}</div>
//         <div className="text-[10px] text-muted-foreground uppercase">{nodeType}</div>
//       </div>
//     </div>
//     {/* output handle(s) — single or multi */}
//   </div>
//
// Trigger nodes omit the target handle; action nodes can render an "async"
// badge alongside the label. Multi-port output handles render evenly-spaced
// labels along the bottom edge — react-flow needs an inline `style` for the
// per-index left position (already exempt-noted in node-styles.ts).

export interface WorkflowNodeShellProps {
  icon: LucideIcon;
  label: ReactNode;
  nodeType: string;
  /** Border class — typically `border-action-X/50` or a status-override. */
  borderClass: string;
  /** Icon background class, e.g. `bg-action-script/10`. */
  iconBgClass: string;
  /** Icon foreground class, e.g. `text-action-script`. */
  iconClass: string;
  /** Output-handle background (react-flow needs `!bg-...`). */
  handleClass: string;
  selected?: boolean;
  /** Trigger nodes set this to false. Defaults to true. */
  showTargetHandle?: boolean;
  /** Output-port labels. Length 1 → single bottom handle; >1 → labeled multi-port row. */
  outputPorts?: string[];
  /** Optional inline badge (e.g. "async" for action nodes). */
  badge?: ReactNode;
  className?: string;
}

export function WorkflowNodeShell({
  icon: Icon,
  label,
  nodeType,
  borderClass,
  iconBgClass,
  iconClass,
  handleClass,
  selected = false,
  showTargetHandle = true,
  outputPorts = ["default"],
  badge,
  className,
}: WorkflowNodeShellProps) {
  const ports = outputPorts.length > 0 ? outputPorts : ["default"];
  const isMulti = ports.length > 1;

  return (
    <div
      className={cn(
        "bg-card border-2 rounded-lg shadow-sm px-3 py-2 min-w-[240px] max-w-[280px]",
        borderClass,
        selected && "ring-2 ring-status-active ring-offset-1 ring-offset-background",
        className,
      )}
    >
      {showTargetHandle ? (
        <Handle type="target" position={Position.Top} id="input" className={handleClass} />
      ) : null}
      <div className="flex items-center gap-2">
        <div className={cn("p-1 rounded", iconBgClass)}>
          <Icon className={cn("h-4 w-4", iconClass)} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5">
            <span className="text-xs font-medium truncate">{label}</span>
            {badge}
          </div>
          <div className="text-[10px] text-muted-foreground uppercase">{nodeType}</div>
        </div>
      </div>
      {isMulti ? (
        <div className="flex justify-around mt-1">
          {ports.map((port, i) => (
            <div key={port} className="flex flex-col items-center">
              <span className="text-[9px] text-muted-foreground">{port}</span>
              <Handle
                type="source"
                position={Position.Bottom}
                id={port}
                className={handleClass}
                // react-flow port position computed per-index
                style={{ left: `${((i + 1) / (ports.length + 1)) * 100}%` }}
              />
            </div>
          ))}
        </div>
      ) : (
        <Handle type="source" position={Position.Bottom} id="default" className={handleClass} />
      )}
    </div>
  );
}
