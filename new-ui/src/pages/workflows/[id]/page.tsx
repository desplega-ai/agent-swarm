import type { ColDef, RowClickedEvent } from "ag-grid-community";
import { ArrowLeft, Play, Trash2 } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import {
  useDeleteWorkflow,
  useExecutorType,
  useTriggerWorkflow,
  useUpdateWorkflow,
  useWorkflow,
  useWorkflowRuns,
} from "@/api/hooks/use-workflows";
import type {
  CooldownConfig,
  TriggerConfig,
  WorkflowNode,
  WorkflowRun,
  WorkflowRunStatus,
} from "@/api/types";
import { DataGrid } from "@/components/shared/data-grid";
import { StatusBadge } from "@/components/shared/status-badge";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { JsonTree } from "@/components/workflows/json-tree";
import { WorkflowGraph } from "@/components/workflows/workflow-graph";
import { formatElapsed, formatSmartTime } from "@/lib/utils";

export default function WorkflowDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { data: workflow, isLoading } = useWorkflow(id!);
  const { data: runs, isLoading: runsLoading } = useWorkflowRuns(id!);
  const updateWorkflow = useUpdateWorkflow();
  const deleteWorkflow = useDeleteWorkflow();
  const triggerWorkflow = useTriggerWorkflow();
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);

  const selectedNode = useMemo(() => {
    if (!selectedNodeId || !workflow) return null;
    return workflow.definition.nodes.find((n) => n.id === selectedNodeId) ?? null;
  }, [selectedNodeId, workflow]);

  const handleNodeClick = useCallback((nodeId: string) => {
    setSelectedNodeId((prev) => (prev === nodeId ? null : nodeId));
  }, []);

  const runColumns = useMemo<ColDef<WorkflowRun>[]>(
    () => [
      {
        field: "status",
        headerName: "Status",
        width: 130,
        cellRenderer: (params: { value: WorkflowRunStatus }) => (
          <StatusBadge status={params.value} />
        ),
      },
      {
        field: "startedAt",
        headerName: "Started",
        width: 150,
        valueFormatter: (params) => (params.value ? formatSmartTime(params.value) : ""),
      },
      {
        headerName: "Duration",
        width: 120,
        valueGetter: (params) =>
          params.data?.finishedAt
            ? formatElapsed(params.data.startedAt, params.data.finishedAt)
            : "\u2014",
      },
      {
        field: "error",
        headerName: "Error",
        flex: 1,
        cellRenderer: (params: { value?: string }) =>
          params.value ? (
            <span className="text-red-500 truncate text-xs">{params.value}</span>
          ) : null,
      },
    ],
    [],
  );

  const onRunRowClicked = useCallback(
    (event: RowClickedEvent<WorkflowRun>) => {
      if (event.data) navigate(`/workflow-runs/${event.data.id}`);
    },
    [navigate],
  );

  if (isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-48 w-full" />
      </div>
    );
  }

  if (!workflow) {
    return <p className="text-muted-foreground">Workflow not found.</p>;
  }

  return (
    <div className="flex flex-col flex-1 min-h-0 gap-4">
      {/* Header */}
      <div className="shrink-0 space-y-3">
        <button
          type="button"
          onClick={() => navigate("/workflows")}
          className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors"
        >
          <ArrowLeft className="h-4 w-4" /> Back to Workflows
        </button>

        <div className="flex items-center gap-3 flex-wrap">
          <h1 className="text-xl font-semibold">{workflow.name}</h1>
          <div className="flex items-center gap-2">
            <Switch
              checked={workflow.enabled}
              onCheckedChange={(checked) =>
                updateWorkflow.mutate({ id: workflow.id, data: { enabled: checked } })
              }
            />
            <span className="text-xs text-muted-foreground">
              {workflow.enabled ? "Enabled" : "Disabled"}
            </span>
          </div>
          <Badge
            variant="outline"
            className="text-[9px] px-1.5 py-0 h-5 font-medium leading-none items-center uppercase"
          >
            {workflow.definition.nodes.length} nodes
          </Badge>
          <Badge
            variant="outline"
            className="text-[9px] px-1.5 py-0 h-5 font-medium leading-none items-center uppercase"
          >
            {workflow.definition.edges?.length ?? 0} edges
          </Badge>
          <div className="ml-auto flex items-center gap-1.5 shrink-0">
            <Button
              variant="outline"
              size="sm"
              onClick={() => triggerWorkflow.mutate({ id: workflow.id })}
              disabled={!workflow.enabled || triggerWorkflow.isPending}
            >
              <Play className="h-3 w-3 mr-1" /> Trigger
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="border-red-500/30 text-red-400 hover:bg-red-500/10"
              onClick={() => setDeleteOpen(true)}
            >
              <Trash2 className="h-3 w-3 mr-1" /> Delete
            </Button>
          </div>
        </div>

        {workflow.description && (
          <p className="text-sm text-muted-foreground">{workflow.description}</p>
        )}
      </div>

      {/* Tabs */}
      <Tabs defaultValue="definition" className="flex flex-col flex-1 min-h-0">
        <TabsList className="shrink-0">
          <TabsTrigger value="definition">Definition</TabsTrigger>
          <TabsTrigger value="runs">Runs ({runs?.length ?? 0})</TabsTrigger>
        </TabsList>

        {/* Definition tab */}
        <TabsContent value="definition" className="flex flex-col flex-1 min-h-0 gap-4">
          {/* Workflow metadata */}
          <WorkflowMeta
            triggers={workflow.triggers}
            cooldown={workflow.cooldown}
            input={workflow.input}
          />

          {/* Split view: graph + inspector */}
          <div className="flex flex-col md:flex-row flex-1 min-h-0 gap-4">
            {/* Graph panel */}
            <div className="flex-[3] min-h-[300px] md:min-h-0">
              <WorkflowGraph
                definition={workflow.definition}
                onNodeClick={handleNodeClick}
                selectedNodeId={selectedNodeId}
                className="h-full min-h-[300px]"
              />
            </div>

            {/* Node inspector panel */}
            <div className="flex-[2] min-h-0 flex flex-col rounded-lg border bg-card">
              <div className="shrink-0 px-4 py-3 border-b">
                <h2 className="text-sm font-semibold">
                  {selectedNode ? "Node Inspector" : "Inspector"}
                </h2>
              </div>
              {selectedNode ? (
                <NodeInspector node={selectedNode} />
              ) : (
                <div className="flex-1 flex items-center justify-center p-4">
                  <p className="text-sm text-muted-foreground">
                    Click a node to inspect its definition
                  </p>
                </div>
              )}
            </div>
          </div>
        </TabsContent>

        {/* Runs tab */}
        <TabsContent value="runs" className="flex flex-col flex-1 min-h-0">
          <DataGrid
            rowData={runs ?? []}
            columnDefs={runColumns}
            onRowClicked={onRunRowClicked}
            loading={runsLoading}
            emptyMessage="No runs yet"
          />
        </TabsContent>
      </Tabs>

      {/* Delete dialog */}
      <AlertDialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Workflow</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete <strong>{workflow.name}</strong>? This action cannot
              be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-red-600 hover:bg-red-700"
              onClick={() => {
                deleteWorkflow.mutate(workflow.id, {
                  onSuccess: () => navigate("/workflows"),
                });
              }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

// --- Node Inspector ---

function NodeInspector({ node }: { node: WorkflowNode }) {
  const { data: executorInfo } = useExecutorType(node.type);

  return (
    <ScrollArea className="flex-1 min-h-0">
      <div className="p-4 space-y-4">
        {/* Header: ID + type + mode */}
        <div className="space-y-1.5">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-medium font-mono">{node.id}</span>
            <Badge
              variant="outline"
              className="text-[9px] px-1.5 py-0 h-5 font-medium leading-none items-center uppercase"
            >
              {node.type}
            </Badge>
            {executorInfo && (
              <Badge
                variant="outline"
                className="text-[9px] px-1.5 py-0 h-5 font-medium leading-none items-center uppercase text-sky-400"
              >
                {executorInfo.mode}
              </Badge>
            )}
          </div>
          {node.label && <p className="text-xs text-muted-foreground">{node.label}</p>}
        </div>

        {/* Configuration */}
        <InspectorSection label="Configuration">
          <JsonTree data={node.config} defaultExpandDepth={2} maxHeight="250px" />
        </InspectorSection>

        {/* Next */}
        {node.next != null && (
          <InspectorSection label="Next">
            <JsonTree data={node.next} defaultExpandDepth={2} maxHeight="150px" />
          </InspectorSection>
        )}

        {/* Validation */}
        {node.validation != null && (
          <InspectorSection label="Validation">
            <JsonTree data={node.validation} defaultExpandDepth={2} maxHeight="200px" />
          </InspectorSection>
        )}

        {/* Retry */}
        {node.retry != null && (
          <InspectorSection label="Retry">
            <JsonTree data={node.retry} defaultExpandDepth={2} maxHeight="150px" />
          </InspectorSection>
        )}
      </div>
    </ScrollArea>
  );
}

function InspectorSection({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <span className="text-xs text-muted-foreground uppercase tracking-wide">{label}</span>
      {children}
    </div>
  );
}

// --- Workflow Metadata ---

function WorkflowMeta({
  triggers,
  cooldown,
  input,
}: {
  triggers: TriggerConfig[];
  cooldown?: CooldownConfig;
  input?: Record<string, string>;
}) {
  const hasMeta =
    triggers.length > 0 || cooldown != null || (input != null && Object.keys(input).length > 0);
  if (!hasMeta) return null;

  return (
    <div className="shrink-0 flex flex-wrap items-start gap-4">
      {/* Triggers */}
      {triggers.length > 0 && (
        <MetaBlock label="Triggers">
          <div className="flex flex-wrap gap-1.5">
            {triggers.map((t, i) => (
              <Badge
                key={i}
                variant="outline"
                className="text-[9px] px-1.5 py-0 h-5 font-medium leading-none items-center uppercase font-mono"
              >
                {t.type}
                {t.type === "webhook" && t.hmacSecret ? ` (hmac: ${maskSecret(t.hmacSecret)})` : ""}
                {t.type === "schedule" && t.scheduleId ? ` ${t.scheduleId}` : ""}
              </Badge>
            ))}
          </div>
        </MetaBlock>
      )}

      {/* Cooldown */}
      {cooldown != null && (
        <MetaBlock label="Cooldown">
          <Badge
            variant="outline"
            className="text-[9px] px-1.5 py-0 h-5 font-medium leading-none items-center uppercase font-mono"
          >
            {formatCooldown(cooldown)}
          </Badge>
        </MetaBlock>
      )}

      {/* Input variables */}
      {input != null && Object.keys(input).length > 0 && (
        <MetaBlock label="Input">
          <JsonTree data={input} defaultExpandDepth={1} maxHeight="100px" />
        </MetaBlock>
      )}
    </div>
  );
}

function MetaBlock({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <span className="text-xs text-muted-foreground uppercase tracking-wide">{label}</span>
      {children}
    </div>
  );
}

function maskSecret(secret: string): string {
  if (secret.length <= 4) return "****";
  return `${secret.slice(0, 2)}${"*".repeat(Math.min(secret.length - 4, 8))}${secret.slice(-2)}`;
}

function formatCooldown(c: CooldownConfig): string {
  const parts: string[] = [];
  if (c.hours) parts.push(`${c.hours}h`);
  if (c.minutes) parts.push(`${c.minutes}m`);
  if (c.seconds) parts.push(`${c.seconds}s`);
  return parts.length > 0 ? parts.join(" ") : "none";
}
