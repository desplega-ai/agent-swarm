import type { ColDef, RowClickedEvent } from "ag-grid-community";
import {
  ArrowLeft,
  ChevronDown,
  ChevronRight,
  FolderGit2,
  GitBranch,
  Play,
  Trash2,
  User,
} from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import {
  useDeleteWorkflow,
  useExecutorType,
  useTriggerWorkflow,
  useUpdateWorkflow,
  useWorkflow,
  useWorkflowRuns,
  useWorkflowVersions,
} from "@/api/hooks/use-workflows";
import type {
  CooldownConfig,
  TriggerConfig,
  WorkflowNode,
  WorkflowRun,
  WorkflowRunStatus,
  WorkflowVersion,
} from "@/api/types";
import { AgentLink } from "@/components/shared/agent-link";
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
  const [searchParams, setSearchParams] = useSearchParams();
  const activeTab = searchParams.get("tab") ?? "definition";
  const setActiveTab = useCallback(
    (tab: string) => setSearchParams({ tab }, { replace: true }),
    [setSearchParams],
  );
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

        {/* Created by + Workspace info */}
        {(workflow.createdByAgentId || workflow.dir || workflow.vcsRepo) && (
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
            {workflow.createdByAgentId && (
              <div className="flex items-center gap-1.5">
                <User className="h-3.5 w-3.5 text-muted-foreground" />
                <span className="text-xs text-muted-foreground">Created by:</span>
                <AgentLink agentId={workflow.createdByAgentId} />
              </div>
            )}
            {workflow.dir && (
              <div className="flex items-center gap-1.5">
                <FolderGit2 className="h-3.5 w-3.5 text-muted-foreground" />
                <span className="text-xs text-muted-foreground">Dir:</span>
                <span className="font-mono text-xs">{workflow.dir}</span>
              </div>
            )}
            {workflow.vcsRepo && (
              <div className="flex items-center gap-1.5">
                <GitBranch className="h-3.5 w-3.5 text-muted-foreground" />
                <span className="text-xs text-muted-foreground">Repo:</span>
                <span className="font-mono text-xs">{workflow.vcsRepo}</span>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Tabs */}
      <Tabs value={activeTab} onValueChange={setActiveTab} className="flex flex-col flex-1 min-h-0">
        <TabsList className="shrink-0">
          <TabsTrigger value="definition">Definition</TabsTrigger>
          <TabsTrigger value="runs">Runs ({runs?.length ?? 0})</TabsTrigger>
          <TabsTrigger value="versions">Versions</TabsTrigger>
        </TabsList>

        {/* Definition tab */}
        <TabsContent value="definition" className="flex flex-col flex-1 min-h-0 gap-4">
          {/* Workflow metadata */}
          <WorkflowMeta
            triggers={workflow.triggers}
            cooldown={workflow.cooldown}
            input={workflow.input}
            triggerSchema={workflow.triggerSchema}
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
                <NodeInspector node={selectedNode} allNodes={workflow.definition.nodes} />
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

        {/* Versions tab */}
        <TabsContent value="versions" className="flex flex-col flex-1 min-h-0">
          <VersionHistory workflowId={workflow.id} />
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

function NodeInspector({ node, allNodes }: { node: WorkflowNode; allNodes: WorkflowNode[] }) {
  const { data: executorInfo } = useExecutorType(node.type);
  const [rawConfigOpen, setRawConfigOpen] = useState(false);

  const resolveNodeLabel = useCallback(
    (nodeId: string) => {
      const target = allNodes.find((n) => n.id === nodeId);
      return target?.label ?? nodeId;
    },
    [allNodes],
  );

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

        {/* Inputs Mapping */}
        {node.inputs != null && Object.keys(node.inputs).length > 0 && (
          <InspectorSection label="Inputs Mapping">
            <div className="rounded-md bg-muted p-3 space-y-1">
              {Object.entries(node.inputs).map(([key, value]) => (
                <div key={key} className="flex items-center gap-2 text-xs font-mono">
                  <span className="text-foreground">{key}</span>
                  <span className="text-muted-foreground">&rarr;</span>
                  <span className="text-amber-500">{value}</span>
                </div>
              ))}
            </div>
          </InspectorSection>
        )}

        {/* Type-specific configuration */}
        {node.type === "agent-task" ? (
          <AgentTaskConfig config={node.config} />
        ) : node.type === "script" ? (
          <ScriptConfig config={node.config} />
        ) : node.type === "raw-llm" ? (
          <RawLlmConfig config={node.config} />
        ) : node.type === "human-in-the-loop" ? (
          <HitlNodeConfig config={node.config} />
        ) : node.type === "notify" ? (
          <NotifyNodeConfig config={node.config} />
        ) : (
          <InspectorSection label="Configuration">
            <JsonTree data={node.config} defaultExpandDepth={2} maxHeight="250px" />
          </InspectorSection>
        )}

        {/* Node-level inputSchema / outputSchema */}
        {node.inputSchema != null && Object.keys(node.inputSchema).length > 0 && (
          <InspectorSection label="Input Schema">
            <JsonTree data={node.inputSchema} defaultExpandDepth={1} maxHeight="200px" />
          </InspectorSection>
        )}
        {node.outputSchema != null && Object.keys(node.outputSchema).length > 0 && (
          <InspectorSection label="Output Schema">
            <JsonTree data={node.outputSchema} defaultExpandDepth={1} maxHeight="200px" />
          </InspectorSection>
        )}

        {/* Raw Configuration (collapsed) */}
        <div className="space-y-1.5">
          <button
            type="button"
            onClick={() => setRawConfigOpen((o) => !o)}
            className="flex items-center gap-1 text-xs text-muted-foreground uppercase tracking-wide hover:text-foreground transition-colors"
          >
            {rawConfigOpen ? (
              <ChevronDown className="h-3 w-3" />
            ) : (
              <ChevronRight className="h-3 w-3" />
            )}
            Raw Configuration
          </button>
          {rawConfigOpen && (
            <JsonTree data={node.config} defaultExpandDepth={2} maxHeight="250px" />
          )}
        </div>

        {/* Connections */}
        {node.next != null && (
          <InspectorSection label="Connections">
            <ConnectionsDisplay next={node.next} resolveLabel={resolveNodeLabel} />
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

// --- Type-specific config renderers ---

/** Highlight {{interpolation}} tokens in a template string. */
function HighlightedTemplate({ text }: { text: string }) {
  const parts = text.split(/({{[^}]*}})/g);
  return (
    <div className="bg-muted rounded-md p-3 font-mono text-xs whitespace-pre-wrap">
      {parts.map((part, i) =>
        /^{{[^}]*}}$/.test(part) ? (
          <span key={i} className="text-amber-500">
            {part}
          </span>
        ) : (
          <span key={i}>{part}</span>
        ),
      )}
    </div>
  );
}

function AgentTaskConfig({ config }: { config: Record<string, unknown> }) {
  const [outputSchemaOpen, setOutputSchemaOpen] = useState(false);
  const template = typeof config.template === "string" ? config.template : null;
  const agentId = typeof config.agentId === "string" ? config.agentId : null;
  const outputSchema =
    config.outputSchema != null && typeof config.outputSchema === "object"
      ? config.outputSchema
      : null;
  const tags = Array.isArray(config.tags) ? (config.tags as string[]) : null;
  const priority = typeof config.priority === "number" ? config.priority : null;
  const offerMode = typeof config.offerMode === "boolean" ? config.offerMode : null;
  const dir = typeof config.dir === "string" ? config.dir : null;
  const vcsRepo = typeof config.vcsRepo === "string" ? config.vcsRepo : null;
  const model = typeof config.model === "string" ? config.model : null;

  return (
    <InspectorSection label="Configuration">
      <div className="space-y-3">
        {template && <HighlightedTemplate text={template} />}

        {agentId && (
          <div className="text-xs">
            <span className="text-muted-foreground">Agent: </span>
            <AgentLink agentId={agentId} />
          </div>
        )}

        {(tags || priority != null || offerMode != null || model) && (
          <div className="flex flex-wrap gap-1.5">
            {tags?.map((tag) => (
              <Badge
                key={tag}
                variant="outline"
                className="text-[9px] px-1.5 py-0 h-5 font-medium leading-none items-center uppercase"
              >
                {tag}
              </Badge>
            ))}
            {priority != null && (
              <Badge
                variant="outline"
                className="text-[9px] px-1.5 py-0 h-5 font-medium leading-none items-center uppercase"
              >
                priority: {priority}
              </Badge>
            )}
            {offerMode != null && (
              <Badge
                variant="outline"
                className="text-[9px] px-1.5 py-0 h-5 font-medium leading-none items-center uppercase"
              >
                offer: {String(offerMode)}
              </Badge>
            )}
            {model && (
              <Badge
                variant="outline"
                className="text-[9px] px-1.5 py-0 h-5 font-medium leading-none items-center uppercase"
              >
                {model}
              </Badge>
            )}
          </div>
        )}

        {dir && (
          <div className="text-xs">
            <span className="text-muted-foreground">Dir: </span>
            <span className="font-mono">{dir}</span>
          </div>
        )}

        {vcsRepo && (
          <div className="text-xs">
            <span className="text-muted-foreground">Repo: </span>
            <span className="font-mono">{vcsRepo}</span>
          </div>
        )}

        {outputSchema && (
          <div className="space-y-1.5">
            <button
              type="button"
              onClick={() => setOutputSchemaOpen((o) => !o)}
              className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
            >
              {outputSchemaOpen ? (
                <ChevronDown className="h-3 w-3" />
              ) : (
                <ChevronRight className="h-3 w-3" />
              )}
              Output Schema
            </button>
            {outputSchemaOpen && (
              <JsonTree data={outputSchema} defaultExpandDepth={2} maxHeight="200px" />
            )}
          </div>
        )}
      </div>
    </InspectorSection>
  );
}

function ScriptConfig({ config }: { config: Record<string, unknown> }) {
  const command = typeof config.command === "string" ? config.command : null;
  const timeout = typeof config.timeout === "number" ? config.timeout : null;

  return (
    <InspectorSection label="Configuration">
      <div className="space-y-3">
        {command && (
          <pre className="bg-muted rounded-md p-3 font-mono text-xs whitespace-pre-wrap overflow-auto">
            {command}
          </pre>
        )}
        {timeout != null && (
          <Badge
            variant="outline"
            className="text-[9px] px-1.5 py-0 h-5 font-medium leading-none items-center uppercase"
          >
            timeout: {timeout}ms
          </Badge>
        )}
      </div>
    </InspectorSection>
  );
}

function RawLlmConfig({ config }: { config: Record<string, unknown> }) {
  const prompt = typeof config.prompt === "string" ? config.prompt : null;
  const model = typeof config.model === "string" ? config.model : null;

  return (
    <InspectorSection label="Configuration">
      <div className="space-y-3">
        {prompt && <HighlightedTemplate text={prompt} />}
        {model && (
          <Badge
            variant="outline"
            className="text-[9px] px-1.5 py-0 h-5 font-medium leading-none items-center uppercase"
          >
            {model}
          </Badge>
        )}
      </div>
    </InspectorSection>
  );
}

function HitlNodeConfig({ config }: { config: Record<string, unknown> }) {
  const title = typeof config.title === "string" ? config.title : null;
  const questions = Array.isArray(config.questions)
    ? (config.questions as Array<{
        id?: string;
        type?: string;
        label?: string;
        description?: string;
        options?: string[];
      }>)
    : null;

  return (
    <InspectorSection label="Configuration">
      <div className="space-y-3">
        {title && (
          <div className="space-y-1">
            <span className="text-[10px] text-muted-foreground uppercase tracking-wide">
              Approval Title
            </span>
            <div className="bg-muted rounded-md p-3 text-xs">{title}</div>
          </div>
        )}
        {questions && questions.length > 0 && (
          <div className="space-y-1.5">
            <span className="text-[10px] text-muted-foreground uppercase tracking-wide">
              Questions ({questions.length})
            </span>
            <div className="space-y-1.5">
              {questions.map((q, i) => (
                <div
                  key={q.id ?? i}
                  className="rounded-md border border-border/50 px-3 py-2 space-y-1"
                >
                  <div className="flex items-center gap-2">
                    <Badge
                      variant="outline"
                      className="text-[9px] px-1.5 py-0 h-5 font-medium leading-none items-center uppercase shrink-0"
                    >
                      {q.type ?? "unknown"}
                    </Badge>
                    <span className="text-xs font-medium">
                      {q.label ?? q.id ?? `Question ${i + 1}`}
                    </span>
                  </div>
                  {q.description && (
                    <p className="text-[10px] text-muted-foreground">{q.description}</p>
                  )}
                  {q.options && q.options.length > 0 && (
                    <div className="flex flex-wrap gap-1 pt-0.5">
                      {q.options.map((opt) => (
                        <Badge
                          key={opt}
                          variant="outline"
                          className="text-[8px] px-1 py-0 h-4 font-normal leading-none items-center text-muted-foreground"
                        >
                          {opt}
                        </Badge>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </InspectorSection>
  );
}

function NotifyNodeConfig({ config }: { config: Record<string, unknown> }) {
  const channel = typeof config.channel === "string" ? config.channel : null;
  const message = typeof config.message === "string" ? config.message : null;
  const target = typeof config.target === "string" ? config.target : null;

  return (
    <InspectorSection label="Configuration">
      <div className="space-y-3">
        {channel && (
          <div className="flex items-center gap-2 text-xs">
            <span className="text-muted-foreground">Channel:</span>
            <Badge
              variant="outline"
              className="text-[9px] px-1.5 py-0 h-5 font-medium leading-none items-center uppercase"
            >
              {channel}
            </Badge>
            {target && <span className="font-mono text-muted-foreground">{target}</span>}
          </div>
        )}
        {message && <HighlightedTemplate text={message} />}
      </div>
    </InspectorSection>
  );
}

// --- Connections display ---

function ConnectionsDisplay({
  next,
  resolveLabel,
}: {
  next: string | string[] | Record<string, string>;
  resolveLabel: (id: string) => string;
}) {
  if (typeof next === "string") {
    return (
      <div className="text-xs flex items-center gap-2 font-mono">
        <span className="text-muted-foreground">Next:</span>
        <span className="text-muted-foreground">&rarr;</span>
        <span>{resolveLabel(next)}</span>
      </div>
    );
  }

  if (Array.isArray(next)) {
    return (
      <div className="space-y-1">
        {next.map((nodeId) => (
          <div key={nodeId} className="text-xs flex items-center gap-2 font-mono">
            <span className="text-muted-foreground">Next:</span>
            <span className="text-muted-foreground">&rarr;</span>
            <span>{resolveLabel(nodeId)}</span>
          </div>
        ))}
      </div>
    );
  }

  // Record<string, string> — port-based routing
  const entries = Object.entries(next);
  return (
    <div className="space-y-1">
      {entries.map(([port, nodeId]) => (
        <div key={port} className="text-xs flex items-center gap-2 font-mono">
          <span className="text-muted-foreground">Port &ldquo;{port}&rdquo;:</span>
          <span className="text-muted-foreground">&rarr;</span>
          <span>{resolveLabel(nodeId)}</span>
        </div>
      ))}
    </div>
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
  triggerSchema,
}: {
  triggers: TriggerConfig[];
  cooldown?: CooldownConfig;
  input?: Record<string, string>;
  triggerSchema?: Record<string, unknown>;
}) {
  const [schemaOpen, setSchemaOpen] = useState(false);
  const hasMeta =
    triggers.length > 0 ||
    cooldown != null ||
    (input != null && Object.keys(input).length > 0) ||
    triggerSchema != null;
  if (!hasMeta) return null;

  return (
    <div className="shrink-0 space-y-3">
      <div className="flex flex-wrap items-start gap-4">
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
                  {t.type === "webhook" && t.hmacSecret
                    ? ` (hmac: ${maskSecret(t.hmacSecret)})`
                    : ""}
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

      {/* Trigger Schema (collapsible) */}
      {triggerSchema != null && (
        <div className="space-y-1">
          <button
            type="button"
            onClick={() => setSchemaOpen((v) => !v)}
            className="flex items-center gap-1 text-xs text-muted-foreground uppercase tracking-wide hover:text-foreground transition-colors"
          >
            {schemaOpen ? (
              <ChevronDown className="h-3 w-3" />
            ) : (
              <ChevronRight className="h-3 w-3" />
            )}
            Trigger Schema
          </button>
          {schemaOpen && <JsonTree data={triggerSchema} defaultExpandDepth={2} maxHeight="250px" />}
        </div>
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

// --- Version History ---

function VersionHistory({ workflowId }: { workflowId: string }) {
  const { data: versions, isLoading } = useWorkflowVersions(workflowId);

  if (isLoading) {
    return (
      <div className="space-y-3 p-4">
        <Skeleton className="h-12 w-full" />
        <Skeleton className="h-12 w-full" />
      </div>
    );
  }

  if (!versions || versions.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center p-4">
        <p className="text-sm text-muted-foreground">No version history available</p>
      </div>
    );
  }

  return (
    <ScrollArea className="flex-1 min-h-0">
      <div className="p-4 space-y-2">
        {versions.map((v) => (
          <VersionEntry key={v.id} version={v} />
        ))}
      </div>
    </ScrollArea>
  );
}

function VersionEntry({ version }: { version: WorkflowVersion }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="rounded-lg border bg-card">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-muted/50 transition-colors"
      >
        {expanded ? (
          <ChevronDown className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
        )}
        <Badge
          variant="outline"
          className="text-[9px] px-1.5 py-0 h-5 font-medium leading-none items-center uppercase font-mono shrink-0"
        >
          v{version.version}
        </Badge>
        <span className="text-xs text-muted-foreground">{formatSmartTime(version.createdAt)}</span>
        {version.changedByAgentId && (
          <span className="text-xs text-muted-foreground">
            by <AgentLink agentId={version.changedByAgentId} onClick={(e) => e.stopPropagation()} />
          </span>
        )}
      </button>
      {expanded && (
        <div className="px-4 pb-4 pt-0">
          <JsonTree data={version.snapshot} defaultExpandDepth={1} maxHeight="400px" />
        </div>
      )}
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
