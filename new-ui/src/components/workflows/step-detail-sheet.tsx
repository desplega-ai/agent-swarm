import type { WorkflowNode, WorkflowRunStep } from "@/api/types";
import { StatusBadge } from "@/components/shared/status-badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { formatElapsed, formatSmartTime } from "@/lib/utils";

interface StepDetailSheetProps {
  step: WorkflowRunStep | null;
  node: WorkflowNode | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

function JsonViewer({ data, label }: { data: unknown; label: string }) {
  if (data === undefined || data === null) return null;
  return (
    <div className="space-y-1">
      <span className="text-xs text-muted-foreground uppercase tracking-wide">{label}</span>
      <pre className="whitespace-pre-wrap text-xs font-mono leading-relaxed rounded-md bg-muted p-3 text-muted-foreground max-h-[300px] overflow-y-auto">
        {typeof data === "string" ? data : JSON.stringify(data, null, 2)}
      </pre>
    </div>
  );
}

export function StepDetailSheet({ step, node, open, onOpenChange }: StepDetailSheetProps) {
  if (!step || !node) return null;

  const duration =
    step.startedAt && step.finishedAt ? formatElapsed(step.startedAt, step.finishedAt) : null;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="overflow-y-auto sm:max-w-lg">
        <SheetHeader>
          <SheetTitle className="flex items-center gap-2 flex-wrap">
            <span>{node.label || node.type}</span>
            <Badge
              variant="outline"
              className="text-[9px] px-1.5 py-0 h-5 font-medium leading-none items-center uppercase"
            >
              {node.type}
            </Badge>
            <StatusBadge status={step.status as "completed"} />
          </SheetTitle>
        </SheetHeader>

        <div className="space-y-4 mt-4">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <span className="text-xs text-muted-foreground uppercase tracking-wide">Started</span>
              <p className="text-sm">{formatSmartTime(step.startedAt)}</p>
            </div>
            {step.finishedAt && (
              <div>
                <span className="text-xs text-muted-foreground uppercase tracking-wide">
                  Finished
                </span>
                <p className="text-sm">{formatSmartTime(step.finishedAt)}</p>
              </div>
            )}
            {duration && (
              <div>
                <span className="text-xs text-muted-foreground uppercase tracking-wide">
                  Duration
                </span>
                <p className="text-sm font-mono">{duration}</p>
              </div>
            )}
          </div>

          {step.error && (
            <Alert variant="destructive">
              <AlertDescription className="text-xs font-mono whitespace-pre-wrap">
                {step.error}
              </AlertDescription>
            </Alert>
          )}

          <JsonViewer data={step.input} label="Input" />
          <JsonViewer data={step.output} label="Output" />
        </div>
      </SheetContent>
    </Sheet>
  );
}
