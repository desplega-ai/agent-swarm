import { LogIn, LogOut } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import type { Selection, StepBlockMapping } from "./source-map";
import { formatDurationMs, stepTypeMeta, type TimelineStep } from "./step-shared";

// Shared column widths so the ruler ticks line up with the bar track across rows.
const NAME_COL = "w-44 shrink-0";
const DUR_COL = "w-14 shrink-0";

/** Time axis above the bars — labels at start / midpoint / end of the run. */
function Ruler({ totalMs }: { totalMs: number }) {
  return (
    <div className="flex items-center border-b px-3 py-1">
      <div className={NAME_COL} />
      <div className="relative h-3 flex-1">
        <span className="absolute left-0 font-mono text-[10px] tabular-nums text-muted-foreground/70">
          0
        </span>
        <span className="absolute left-1/2 -translate-x-1/2 font-mono text-[10px] tabular-nums text-muted-foreground/70">
          {formatDurationMs(totalMs / 2)}
        </span>
        <span className="absolute right-0 font-mono text-[10px] tabular-nums text-muted-foreground/70">
          {formatDurationMs(totalMs)}
        </span>
      </div>
      <div className={DUR_COL} />
    </div>
  );
}

function GridLines() {
  return (
    <>
      {[25, 50, 75].map((p) => (
        <div
          key={p}
          className="absolute inset-y-0 w-px bg-border/40"
          // inline-style: gridline at a fixed fraction of the track width
          style={{ left: `${p}%` }}
        />
      ))}
    </>
  );
}

function WaterfallRow({
  step,
  totalMs,
  selected,
  blockActive,
  onActivate,
}: {
  step: TimelineStep;
  totalMs: number;
  selected: boolean;
  blockActive: boolean;
  onActivate: () => void;
}) {
  const { entry, index, offsetMs, durationMs } = step;
  const meta = stepTypeMeta(entry.stepType);
  const failed = entry.status === "failed";
  const Icon = meta.Icon;
  const leftPct = totalMs > 0 ? (offsetMs / totalMs) * 100 : 0;
  const widthPct = totalMs > 0 ? Math.min(Math.max((durationMs / totalMs) * 100, 1.5), 100) : 0;

  return (
    <button
      type="button"
      onClick={onActivate}
      className={cn(
        "flex w-full items-center gap-2 border-l-2 border-l-transparent px-3 py-1.5 text-left transition-colors hover:bg-muted/40",
        selected && "border-l-primary bg-primary/5",
        !selected && blockActive && "border-l-border bg-muted/30",
      )}
    >
      <div className={cn("flex items-center gap-2", NAME_COL)}>
        <span className="w-4 shrink-0 text-right font-mono text-[10px] text-muted-foreground/70">
          {index + 1}
        </span>
        <Icon className={cn("h-3.5 w-3.5 shrink-0", failed ? "text-status-error" : meta.accent)} />
        <span className="truncate font-mono text-xs">{entry.stepKey}</span>
      </div>

      <Tooltip>
        <TooltipTrigger asChild>
          <div className="relative h-4 flex-1 overflow-hidden rounded bg-muted/30">
            <GridLines />
            <div
              className={cn(
                "absolute inset-y-[3px] rounded-sm border-l-2",
                failed ? "border-l-status-error bg-status-error/30" : meta.bar,
              )}
              // inline-style: bar offset by cumulative start, width by measured duration
              style={{ left: `${leftPct}%`, width: `${widthPct}%` }}
            />
          </div>
        </TooltipTrigger>
        <TooltipContent side="top" className="space-y-0.5">
          <div className="font-medium">{entry.stepKey}</div>
          <div className="text-muted-foreground">
            {meta.name} · {entry.status}
          </div>
          <div className="font-mono text-[11px] tabular-nums">
            starts +{formatDurationMs(offsetMs)} · runs {formatDurationMs(durationMs)}
          </div>
        </TooltipContent>
      </Tooltip>

      <span className="w-14 shrink-0 text-right font-mono text-[11px] tabular-nums text-muted-foreground">
        {formatDurationMs(durationMs)}
      </span>
    </button>
  );
}

/** Run boundary marker (Input at t=0, Output at t=end) — a diamond on the track. */
function BoundaryRow({
  kind,
  selected,
  onActivate,
}: {
  kind: "input" | "output";
  selected: boolean;
  onActivate: () => void;
}) {
  const isInput = kind === "input";
  const Icon = isInput ? LogIn : LogOut;
  return (
    <button
      type="button"
      onClick={onActivate}
      className={cn(
        "flex w-full items-center gap-2 border-l-2 border-l-transparent px-3 py-1.5 text-left transition-colors hover:bg-muted/40",
        selected &&
          (isInput ? "border-l-status-info bg-muted/40" : "border-l-status-success bg-muted/40"),
      )}
    >
      <div className={cn("flex items-center gap-2", NAME_COL)}>
        <span className="w-4 shrink-0" />
        <Icon
          className={cn(
            "h-3.5 w-3.5 shrink-0",
            isInput ? "text-status-info-strong" : "text-status-success-strong",
          )}
        />
        <span className="text-xs font-semibold">{isInput ? "Input" : "Output"}</span>
      </div>
      <div className="relative h-4 flex-1">
        <div
          className={cn(
            "absolute top-1/2 h-2 w-2 -translate-x-1/2 -translate-y-1/2 rotate-45 rounded-[2px]",
            isInput ? "bg-status-info" : "bg-status-success",
          )}
          // inline-style: marker pinned to the run's start (0%) or end (100%)
          style={{ left: isInput ? "0%" : "100%" }}
        />
      </div>
      <span className="w-14 shrink-0 text-right font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
        {isInput ? "args" : "return"}
      </span>
    </button>
  );
}

interface WaterfallViewProps {
  steps: TimelineStep[];
  totalMs: number;
  hasTiming: boolean;
  mapping: StepBlockMapping;
  selection: Selection;
  onSelect: (sel: Selection) => void;
  hasOutput: boolean;
}

export function WaterfallView({
  steps,
  totalMs,
  hasTiming,
  mapping,
  selection,
  onSelect,
  hasOutput,
}: WaterfallViewProps) {
  if (steps.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center p-8 text-center text-sm text-muted-foreground">
        No steps to chart — this run executed in a single call.
      </div>
    );
  }
  if (!hasTiming) {
    return (
      <div className="flex flex-1 items-center justify-center p-8 text-center text-sm text-muted-foreground">
        Per-step timing wasn&rsquo;t recorded for this run.
      </div>
    );
  }

  const selectedBlock =
    selection?.kind === "step" ? mapping.stepToBlock[selection.stepId] : undefined;
  const activateStep = (id: string) =>
    onSelect(
      selection?.kind === "step" && selection.stepId === id ? null : { kind: "step", stepId: id },
    );
  const activateIo = (kind: "input" | "output") =>
    onSelect(selection?.kind === kind ? null : { kind });

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <Ruler totalMs={totalMs} />
      <div className="min-h-0 flex-1 overflow-auto py-1">
        <BoundaryRow
          kind="input"
          selected={selection?.kind === "input"}
          onActivate={() => activateIo("input")}
        />
        {steps.map((step) => (
          <WaterfallRow
            key={step.entry.id}
            step={step}
            totalMs={totalMs}
            selected={selection?.kind === "step" && selection.stepId === step.entry.id}
            blockActive={
              selectedBlock !== undefined && mapping.stepToBlock[step.entry.id] === selectedBlock
            }
            onActivate={() => activateStep(step.entry.id)}
          />
        ))}
        {hasOutput && (
          <BoundaryRow
            kind="output"
            selected={selection?.kind === "output"}
            onActivate={() => activateIo("output")}
          />
        )}
      </div>
    </div>
  );
}
