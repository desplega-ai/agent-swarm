import { ChevronDown, ChevronRight, CircleAlert, ExternalLink, LogIn, LogOut } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import type { ScriptRunJournalEntry } from "@/api/types";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn, formatSmartTime } from "@/lib/utils";
import { JsonView } from "./json-view";
import type { Selection, StepBlockMapping } from "./source-map";
import { buildSteps, formatDurationMs, stepTypeMeta, type TimelineStep } from "./step-shared";

function MetaItem({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
        {label}
      </span>
      <span className="text-xs">{children}</span>
    </div>
  );
}

function ValueBlock({ label, data }: { label: string; data: unknown }) {
  if (data === null || data === undefined) {
    return <span className="text-xs text-muted-foreground">No {label.toLowerCase()}.</span>;
  }
  return <JsonView data={data} defaultExpandDepth={1} maxHeight="280px" />;
}

/** A run-level Input (args) or Output (return) entry, bracketing the step list. */
function IoRow({
  kind,
  data,
  expanded,
  selected,
  onActivate,
  rowRef,
}: {
  kind: "input" | "output";
  data: unknown;
  expanded: boolean;
  selected: boolean;
  onActivate: () => void;
  rowRef: (el: HTMLDivElement | null) => void;
}) {
  const isInput = kind === "input";
  const accent = isInput ? "text-status-info-strong" : "text-status-success-strong";
  const railSel = isInput ? "border-l-status-info" : "border-l-status-success";
  const Icon = isInput ? LogIn : LogOut;
  return (
    <div
      ref={rowRef}
      className={cn(
        "border-b border-l-2 border-l-transparent",
        selected && `${railSel} bg-muted/40`,
      )}
    >
      <button
        type="button"
        onClick={onActivate}
        className="w-full px-3 py-2 text-left transition-colors hover:bg-muted/40"
      >
        <div className="flex items-center gap-2">
          {expanded ? (
            <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          ) : (
            <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          )}
          <Icon className={cn("h-3.5 w-3.5 shrink-0", accent)} />
          <span className="text-xs font-semibold">{isInput ? "Input" : "Output"}</span>
          <Badge variant="outline" size="tag" className="ml-auto">
            {isInput ? "args" : "return"}
          </Badge>
        </div>
      </button>
      {expanded && (
        <div className="border-t bg-surface/40 px-3 py-3">
          <ValueBlock label={isInput ? "args" : "output"} data={data} />
        </div>
      )}
    </div>
  );
}

function StepDetails({ step, hasTiming }: { step: TimelineStep; hasTiming: boolean }) {
  const { entry, offsetMs, durationMs } = step;
  const failed = entry.status === "failed";
  const taskId =
    entry.stepType === "agent-task" &&
    entry.result &&
    typeof entry.result === "object" &&
    typeof (entry.result as { taskId?: unknown }).taskId === "string"
      ? (entry.result as { taskId: string }).taskId
      : null;

  return (
    <div className="space-y-3 border-t bg-surface/40 px-3 py-3">
      <div className="flex flex-wrap gap-x-6 gap-y-2">
        <MetaItem label="Status">
          <span className={failed ? "text-status-error-strong" : "text-status-success-strong"}>
            {entry.status}
          </span>
        </MetaItem>
        {hasTiming && (
          <MetaItem label="Offset">
            <span className="font-mono tabular-nums">+{formatDurationMs(offsetMs)}</span>
          </MetaItem>
        )}
        <MetaItem label="Duration">
          <span className="font-mono tabular-nums">
            {typeof entry.durationMs === "number" ? formatDurationMs(durationMs) : "—"}
          </span>
        </MetaItem>
        <MetaItem label="Recorded">{formatSmartTime(entry.startedAt)}</MetaItem>
      </div>

      {entry.error && (
        <Alert variant="destructive">
          <AlertDescription className="max-h-[200px] overflow-y-auto whitespace-pre-wrap font-mono text-xs">
            {entry.error}
          </AlertDescription>
        </Alert>
      )}

      {entry.config && Object.keys(entry.config).length > 0 && (
        <div className="space-y-1.5">
          <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            Input
          </span>
          <ValueBlock label="input" data={entry.config} />
        </div>
      )}

      {entry.result !== undefined && (
        <div className="space-y-1.5">
          <div className="flex items-center justify-between">
            <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              Output
            </span>
            {taskId && (
              <Link
                to={`/tasks/${taskId}`}
                className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
              >
                View task <ExternalLink className="h-3 w-3" />
              </Link>
            )}
          </div>
          <ValueBlock label="output" data={entry.result} />
        </div>
      )}
    </div>
  );
}

function TimelineRow({
  step,
  hasTiming,
  maxMs,
  expanded,
  selected,
  blockActive,
  onActivate,
  rowRef,
}: {
  step: TimelineStep;
  hasTiming: boolean;
  maxMs: number;
  expanded: boolean;
  selected: boolean;
  blockActive: boolean;
  onActivate: () => void;
  rowRef: (el: HTMLDivElement | null) => void;
}) {
  const { entry, index, durationMs } = step;
  const meta = stepTypeMeta(entry.stepType);
  const failed = entry.status === "failed";
  const Icon = meta.Icon;
  const widthPct = maxMs > 0 ? Math.max((durationMs / maxMs) * 100, 2) : 0;

  return (
    <div
      ref={rowRef}
      className={cn(
        "border-b border-l-2 border-l-transparent last:border-b-0",
        selected && "border-l-primary bg-primary/5",
        !selected && blockActive && "border-l-border bg-muted/30",
      )}
    >
      <button
        type="button"
        onClick={onActivate}
        className="w-full px-3 py-2 text-left transition-colors hover:bg-muted/40"
      >
        <div className="flex items-center gap-2">
          {expanded ? (
            <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          ) : (
            <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          )}
          <span className="w-4 shrink-0 text-right font-mono text-[10px] text-muted-foreground/70">
            {index + 1}
          </span>
          <Icon
            className={cn("h-3.5 w-3.5 shrink-0", failed ? "text-status-error" : meta.accent)}
          />
          <span className="truncate font-mono text-xs font-medium">{entry.stepKey}</span>
          {failed && <CircleAlert className="h-3.5 w-3.5 shrink-0 text-status-error" />}
          <div className="ml-auto flex shrink-0 items-center gap-2">
            {hasTiming && (
              <span className="font-mono text-[11px] tabular-nums text-muted-foreground">
                {formatDurationMs(durationMs)}
              </span>
            )}
            <Badge variant="outline" size="tag" className={meta.badge}>
              {meta.name}
            </Badge>
          </div>
        </div>
        {hasTiming && (
          <div className="mt-1.5 h-1 w-full overflow-hidden rounded-full bg-muted">
            <div
              className={cn("h-full rounded-full", failed ? "bg-status-error" : meta.dot)}
              // inline-style: bar width proportional to the slowest step
              style={{ width: `${widthPct}%` }}
            />
          </div>
        )}
      </button>
      {expanded && <StepDetails step={step} hasTiming={hasTiming} />}
    </div>
  );
}

interface TimelinePanelProps {
  journal: ScriptRunJournalEntry[];
  mapping: StepBlockMapping;
  runArgs: unknown;
  runOutput: unknown;
  hasOutput: boolean;
  selection: Selection;
  onSelect: (sel: Selection) => void;
  className?: string;
}

export function TimelinePanel({
  journal,
  mapping,
  runArgs,
  runOutput,
  hasOutput,
  selection,
  onSelect,
  className,
}: TimelinePanelProps) {
  const { steps, totalMs, maxMs, hasTiming } = useMemo(() => buildSteps(journal), [journal]);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const rowRefs = useRef(new Map<string, HTMLDivElement>());
  const scrollRef = useRef<HTMLDivElement>(null);

  const selectionKey: string | null =
    selection?.kind === "step" ? selection.stepId : (selection?.kind ?? null);
  const selectedBlock =
    selection?.kind === "step" ? mapping.stepToBlock[selection.stepId] : undefined;

  // When something becomes selected (e.g. by clicking its code block), reveal it
  // and scroll it to the top of the panel — without scrolling the whole page.
  useEffect(() => {
    if (!selectionKey) return;
    setExpanded((prev) => (prev.has(selectionKey) ? prev : new Set(prev).add(selectionKey)));
    const row = rowRefs.current.get(selectionKey);
    const container = scrollRef.current;
    if (!row || !container) return;
    const offset = row.getBoundingClientRect().top - container.getBoundingClientRect().top;
    container.scrollTo({ top: Math.max(0, container.scrollTop + offset - 12), behavior: "smooth" });
  }, [selectionKey]);

  const allKeys = useMemo(() => {
    const keys = journal.map((e) => e.id);
    keys.unshift("input");
    if (hasOutput) keys.push("output");
    return keys;
  }, [journal, hasOutput]);
  const allExpanded = expanded.size >= allKeys.length && allKeys.length > 0;
  const toggleAll = () => setExpanded(allExpanded ? new Set() : new Set(allKeys));

  const toggleExpand = (key: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const activateStep = (id: string) => {
    if (selection?.kind === "step" && selection.stepId === id) {
      onSelect(null);
      toggleExpand(id);
    } else {
      onSelect({ kind: "step", stepId: id });
    }
  };

  const activateIo = (kind: "input" | "output") => {
    if (selection?.kind === kind) {
      onSelect(null);
      toggleExpand(kind);
    } else {
      onSelect({ kind });
    }
  };

  return (
    <div
      className={cn("flex min-h-0 flex-col overflow-hidden rounded-lg border bg-card", className)}
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b px-4 py-2">
        <h2 className="text-sm font-semibold">Timeline</h2>
        {hasTiming && (
          <span className="font-mono text-xs tabular-nums text-muted-foreground">
            {formatDurationMs(totalMs)} total
          </span>
        )}
        <div className="ml-auto flex items-center gap-1">
          {selection && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => onSelect(null)}
              className="h-7 text-xs"
            >
              Clear
            </Button>
          )}
          <Button variant="ghost" size="sm" onClick={toggleAll} className="h-7 text-xs">
            {allExpanded ? "Collapse all" : "Expand all"}
          </Button>
        </div>
      </div>

      <div ref={scrollRef} className="min-h-0 flex-1 overflow-auto">
        <IoRow
          kind="input"
          data={runArgs}
          expanded={expanded.has("input")}
          selected={selection?.kind === "input"}
          onActivate={() => activateIo("input")}
          rowRef={(el) => {
            if (el) rowRefs.current.set("input", el);
            else rowRefs.current.delete("input");
          }}
        />

        {steps.map((step) => (
          <TimelineRow
            key={step.entry.id}
            step={step}
            hasTiming={hasTiming}
            maxMs={maxMs}
            expanded={expanded.has(step.entry.id)}
            selected={selection?.kind === "step" && selection.stepId === step.entry.id}
            blockActive={
              selectedBlock !== undefined && mapping.stepToBlock[step.entry.id] === selectedBlock
            }
            onActivate={() => activateStep(step.entry.id)}
            rowRef={(el) => {
              if (el) rowRefs.current.set(step.entry.id, el);
              else rowRefs.current.delete(step.entry.id);
            }}
          />
        ))}

        {hasOutput && (
          <IoRow
            kind="output"
            data={runOutput}
            expanded={expanded.has("output")}
            selected={selection?.kind === "output"}
            onActivate={() => activateIo("output")}
            rowRef={(el) => {
              if (el) rowRefs.current.set("output", el);
              else rowRefs.current.delete("output");
            }}
          />
        )}
      </div>

      {!hasTiming && journal.length > 0 && (
        <div className="border-t px-4 py-2 text-[11px] text-muted-foreground">
          Per-step timing wasn&rsquo;t recorded for this run.
        </div>
      )}
    </div>
  );
}
