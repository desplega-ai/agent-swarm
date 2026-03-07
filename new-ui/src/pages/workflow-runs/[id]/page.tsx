import { ArrowLeft, RefreshCw } from "lucide-react";
import { useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useRetryWorkflowRun, useWorkflow, useWorkflowRun } from "@/api/hooks/use-workflows";
import { StatusBadge } from "@/components/shared/status-badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { StepDetailSheet } from "@/components/workflows/step-detail-sheet";
import { WorkflowGraph } from "@/components/workflows/workflow-graph";
import { formatElapsed, formatSmartTime } from "@/lib/utils";

export default function WorkflowRunDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { data: run, isLoading } = useWorkflowRun(id!);
  const { data: workflow } = useWorkflow(run?.workflowId ?? "");
  const retryRun = useRetryWorkflowRun();

  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);

  const selectedStep = run?.steps?.find((s) => s.nodeId === selectedNodeId) ?? null;
  const selectedNode = workflow?.definition.nodes.find((n) => n.id === selectedNodeId) ?? null;

  const duration =
    run?.startedAt && run?.finishedAt ? formatElapsed(run.startedAt, run.finishedAt) : null;

  if (isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-[400px] w-full" />
      </div>
    );
  }

  if (!run) {
    return <p className="text-muted-foreground">Workflow run not found.</p>;
  }

  return (
    <div className="flex-1 min-h-0 overflow-y-auto space-y-4">
      <button
        type="button"
        onClick={() => navigate("/workflows?tab=runs")}
        className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors"
      >
        <ArrowLeft className="h-4 w-4" /> Back to Runs
      </button>

      <div className="flex items-center gap-3 flex-wrap">
        <h1 className="text-xl font-semibold">Run of {workflow?.name ?? "..."}</h1>
        <StatusBadge status={run.status} size="md" />
        <Badge
          variant="outline"
          className="text-[9px] px-1.5 py-0 h-5 font-medium leading-none items-center uppercase"
        >
          {formatSmartTime(run.startedAt)}
        </Badge>
        {duration && (
          <Badge
            variant="outline"
            className="text-[9px] px-1.5 py-0 h-5 font-medium leading-none items-center uppercase font-mono"
          >
            {duration}
          </Badge>
        )}
        {run.status === "failed" && (
          <div className="ml-auto">
            <Button
              variant="outline"
              size="sm"
              onClick={() => retryRun.mutate(run.id)}
              disabled={retryRun.isPending}
            >
              <RefreshCw className="h-3 w-3 mr-1" /> Retry
            </Button>
          </div>
        )}
      </div>

      {run.error && (
        <Alert variant="destructive">
          <AlertDescription className="text-xs font-mono whitespace-pre-wrap">
            {run.error}
          </AlertDescription>
        </Alert>
      )}

      {workflow && (
        <WorkflowGraph
          definition={workflow.definition}
          steps={run.steps}
          onNodeClick={(nodeId) => setSelectedNodeId(nodeId)}
        />
      )}

      <StepDetailSheet
        step={selectedStep}
        node={selectedNode}
        open={!!selectedNodeId && !!selectedStep}
        onOpenChange={(open) => {
          if (!open) setSelectedNodeId(null);
        }}
      />
    </div>
  );
}
