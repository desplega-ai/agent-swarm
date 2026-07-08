import Editor from "@monaco-editor/react";
import type { ColDef, RowClickedEvent } from "ag-grid-community";
import {
  ArrowLeft,
  Bell,
  Check,
  ChevronDown,
  ChevronRight,
  FolderGit2,
  GitBranch,
  Mail,
  Maximize2,
  MessageSquare,
  Play,
  Trash2,
  User,
  Webhook,
  X,
} from "lucide-react";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { toast } from "sonner";
import { api, TriggerSchemaApiError } from "@/api/client";
import { useFavoriteToggle } from "@/api/hooks/use-favorites";
import { useScheduledTasks } from "@/api/hooks/use-schedules";
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
  WebhookVerification,
  WorkflowNode,
  WorkflowRun,
  WorkflowRunStatus,
  WorkflowVersion,
} from "@/api/types";
import { AgentLink } from "@/components/shared/agent-link";
import { CollapsibleDescription } from "@/components/shared/collapsible-description";
import { CopyableField, CopyIconButton, SecretField } from "@/components/shared/copyable-fields";
import { DataGrid } from "@/components/shared/data-grid";
import { FavoriteButton } from "@/components/shared/favorite-button";
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
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { JsonTree } from "@/components/workflows/json-tree";
import { WorkflowGraph } from "@/components/workflows/workflow-graph";
import { useTheme } from "@/hooks/use-theme";
import { readBooleanParam, readStringParam, useUrlSearchState } from "@/hooks/use-url-search-state";
import { getConfig } from "@/lib/config";
import { modelTierLabel } from "@/lib/model-tiers";
import { monacoDarkTheme, monacoLightTheme } from "@/lib/monaco-themes";
import { formatElapsed, formatSmartTime } from "@/lib/utils";

export default function WorkflowDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { data: workflow, isLoading } = useWorkflow(id!);
  const { data: runs, isLoading: runsLoading } = useWorkflowRuns(id!);
  const updateWorkflow = useUpdateWorkflow();
  const deleteWorkflow = useDeleteWorkflow();
  const triggerWorkflow = useTriggerWorkflow();
  const favoriteToggle = useFavoriteToggle("workflow");
  const { searchParams, setParam } = useUrlSearchState();
  const activeTab = readStringParam(searchParams, "tab", "definition");
  const selectedNodeId = readStringParam(searchParams, "node") || null;
  const graphMaximized = readBooleanParam(searchParams, "graph");
  const setActiveTab = useCallback(
    (tab: string) => setParam("tab", tab, { defaultValue: "definition" }),
    [setParam],
  );
  const setSelectedNodeId = useCallback(
    (nodeId: string | null) => setParam("node", nodeId),
    [setParam],
  );
  const setGraphMaximized = useCallback(
    (open: boolean) => setParam("graph", open ? "true" : ""),
    [setParam],
  );
  const [deleteOpen, setDeleteOpen] = useState(false);

  const selectedNode = useMemo(() => {
    if (!selectedNodeId || !workflow) return null;
    return workflow.definition.nodes.find((n) => n.id === selectedNodeId) ?? null;
  }, [selectedNodeId, workflow]);

  const handleNodeClick = useCallback(
    (nodeId: string) => {
      setSelectedNodeId(selectedNodeId === nodeId ? null : nodeId);
    },
    [selectedNodeId, setSelectedNodeId],
  );

  useEffect(() => {
    if (
      selectedNodeId &&
      workflow &&
      !workflow.definition.nodes.some((node) => node.id === selectedNodeId)
    ) {
      setSelectedNodeId(null);
    }
  }, [selectedNodeId, setSelectedNodeId, workflow]);

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
            <span className="text-status-error truncate text-xs">{params.value}</span>
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
          <Badge variant="outline" size="tag">
            {workflow.definition.nodes.length} nodes
          </Badge>
          <Badge variant="outline" size="tag">
            {workflow.definition.edges?.length ?? 0} edges
          </Badge>
          <div className="ml-auto flex items-center gap-1.5 shrink-0">
            <FavoriteButton
              favorite={workflow.favorite}
              disabled={favoriteToggle.isPending}
              onToggle={() =>
                favoriteToggle.mutate({ itemId: workflow.id, favorite: !workflow.favorite })
              }
            />
            <TopBarTriggerButton
              workflowId={workflow.id}
              enabled={workflow.enabled}
              triggerSchema={workflow.triggerSchema}
              triggerWorkflow={triggerWorkflow}
              onSchemaRequired={() => setActiveTab("triggers")}
            />
            <Button variant="destructive-outline" size="sm" onClick={() => setDeleteOpen(true)}>
              <Trash2 className="h-3 w-3 mr-1" /> Delete
            </Button>
          </div>
        </div>

        {workflow.description && (
          <CollapsibleDescription
            text={workflow.description}
            textClassName="text-muted-foreground"
          />
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
          <TabsTrigger value="triggers">Triggers ({workflow.triggers.length})</TabsTrigger>
          <TabsTrigger value="runs">Runs ({runs?.length ?? 0})</TabsTrigger>
          <TabsTrigger value="versions">Versions</TabsTrigger>
        </TabsList>

        {/* Definition tab */}
        <TabsContent value="definition" className="flex flex-col flex-1 min-h-0 gap-4">
          {/* Single-line summary; full detail lives in the Triggers tab */}
          <WorkflowMetaSummary
            triggers={workflow.triggers}
            cooldown={workflow.cooldown}
            input={workflow.input}
            triggerSchema={workflow.triggerSchema}
          />

          {/* Split view: graph + inspector */}
          <div className="flex flex-col md:flex-row flex-1 min-h-0 gap-4">
            {/* Graph panel */}
            <div className="relative flex-[3] min-h-[300px] md:min-h-0">
              <WorkflowGraph
                definition={workflow.definition}
                onNodeClick={handleNodeClick}
                selectedNodeId={selectedNodeId}
                className="h-full min-h-[300px]"
              />
              <Button
                type="button"
                variant="outline"
                size="icon"
                onClick={() => setGraphMaximized(true)}
                aria-label="Expand graph"
                title="Expand graph"
                className="absolute top-2 right-2 h-7 w-7 bg-background/80 backdrop-blur-sm shadow-sm"
              >
                <Maximize2 className="h-3.5 w-3.5" />
              </Button>
            </div>

            {/* Node inspector panel */}
            <div className="flex-[2] min-h-0 flex flex-col rounded-lg border bg-card">
              <div className="shrink-0 px-4 py-3 border-b flex items-center justify-between gap-2">
                <h2 className="text-sm font-semibold">
                  {selectedNode ? "Node Inspector" : "Inspector"}
                </h2>
                {selectedNode && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="h-6 w-6"
                    onClick={() => setSelectedNodeId(null)}
                    aria-label="Close inspector"
                    title="Close inspector"
                  >
                    <X className="h-3.5 w-3.5" />
                  </Button>
                )}
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

        {/* Triggers tab */}
        <TabsContent value="triggers" className="flex flex-col flex-1 min-h-0">
          <TriggersDetailPanel
            workflowId={workflow.id}
            triggers={workflow.triggers}
            cooldown={workflow.cooldown}
            input={workflow.input}
            triggerSchema={workflow.triggerSchema}
          />
        </TabsContent>

        {/* Runs tab */}
        <TabsContent value="runs" className="flex flex-col flex-1 min-h-0">
          <DataGrid
            rowData={runs ?? []}
            columnDefs={runColumns}
            onRowClicked={onRunRowClicked}
            loading={runsLoading}
            emptyMessage="No runs yet"
            paginationQueryKey="workflowRuns"
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
              variant="destructive"
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

      {/* Maximized graph dialog */}
      <Dialog open={graphMaximized} onOpenChange={setGraphMaximized}>
        <DialogContent className="max-w-[95vw] w-[95vw] sm:max-w-[95vw] h-[95vh] p-0 gap-0 flex flex-col">
          <DialogHeader className="shrink-0 px-4 py-3 border-b">
            <DialogTitle className="text-sm font-semibold">{workflow.name}</DialogTitle>
          </DialogHeader>
          <div className="flex-1 min-h-0 p-4">
            <WorkflowGraph
              definition={workflow.definition}
              onNodeClick={handleNodeClick}
              selectedNodeId={selectedNodeId}
              className="h-full border-0"
            />
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// --- Node Inspector ---

function NodeInspector({ node, allNodes }: { node: WorkflowNode; allNodes: WorkflowNode[] }) {
  const { data: executorInfo } = useExecutorType(node.type);
  const { searchParams, setParam } = useUrlSearchState();
  const rawConfigOpen = readBooleanParam(searchParams, "rawConfig");

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
            <Badge variant="outline" size="tag">
              {node.type}
            </Badge>
            {executorInfo && (
              <Badge variant="outline" size="tag" className="text-status-info">
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
                  <span className="text-status-active">{value}</span>
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
        ) : node.type === "property-match" ? (
          <PropertyMatchConfig config={node.config} />
        ) : Object.keys(node.config ?? {}).length > 0 ? (
          <InspectorSection label="Configuration">
            <JsonTree data={node.config} defaultExpandDepth={2} maxHeight="250px" />
          </InspectorSection>
        ) : null}

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
            onClick={() => setParam("rawConfig", rawConfigOpen ? "" : "true")}
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
          <span key={i} className="text-status-active">
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
  const { searchParams, setParam } = useUrlSearchState();
  const outputSchemaOpen = readBooleanParam(searchParams, "outputSchema");
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
  const modelTier = typeof config.modelTier === "string" ? config.modelTier : null;

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

        {(tags || priority != null || offerMode != null || model || modelTier) && (
          <div className="flex flex-wrap gap-1.5">
            {tags?.map((tag) => (
              <Badge key={tag} variant="outline" size="tag">
                {tag}
              </Badge>
            ))}
            {priority != null && (
              <Badge variant="outline" size="tag">
                priority: {priority}
              </Badge>
            )}
            {offerMode != null && (
              <Badge variant="outline" size="tag">
                offer: {String(offerMode)}
              </Badge>
            )}
            {model && (
              <Badge variant="outline" size="tag">
                {model}
              </Badge>
            )}
            {modelTier && (
              <Badge variant="outline" size="tag">
                tier: {modelTierLabel(modelTier)}
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
              onClick={() => setParam("outputSchema", outputSchemaOpen ? "" : "true")}
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
  const { theme } = useTheme();
  // Schema uses `script` (the code) + `runtime` ("bash" | "ts" | "python").
  // Tolerate `command` as a fallback for older/looser configs.
  const code =
    typeof config.script === "string"
      ? config.script
      : typeof config.command === "string"
        ? config.command
        : null;
  const runtime = typeof config.runtime === "string" ? config.runtime : null;
  const timeout = typeof config.timeout === "number" ? config.timeout : null;
  const cwd = typeof config.cwd === "string" ? config.cwd : null;
  const args = Array.isArray(config.args) ? (config.args as string[]) : null;
  const language = runtimeToLanguage(runtime, code ?? "");
  const lineCount = code ? code.split("\n").length : 0;
  const editorHeight = Math.min(Math.max(lineCount * 19 + 16, 100), 400);

  return (
    <InspectorSection label="Configuration">
      <div className="space-y-2">
        {code && (
          <div className="rounded-md border overflow-hidden bg-card">
            <div className="flex items-center justify-between px-3 py-1.5 border-b border-border bg-muted text-muted-foreground">
              <span className="text-[10px] font-mono uppercase tracking-wide">
                {runtime ?? language}
              </span>
              <div className="flex items-center gap-3">
                <span className="text-[10px] font-mono text-muted-foreground/70">
                  {lineCount} {lineCount === 1 ? "line" : "lines"}
                </span>
                <CopyIconButton value={code} />
              </div>
            </div>
            <Editor
              language={language}
              theme={theme === "dark" ? "github-dark" : "github-light"}
              value={code}
              height={`${editorHeight}px`}
              beforeMount={(monaco) => {
                monaco.editor.defineTheme("github-light", monacoLightTheme);
                monaco.editor.defineTheme("github-dark", monacoDarkTheme);
              }}
              options={{
                readOnly: true,
                minimap: { enabled: false },
                scrollBeyondLastLine: false,
                fontSize: 12,
                lineNumbers: "on",
                wordWrap: "on",
                automaticLayout: true,
                padding: { top: 8, bottom: 8 },
                folding: false,
                renderLineHighlight: "none",
                scrollbar: { vertical: "auto", horizontal: "auto" },
                overviewRulerLanes: 0,
              }}
            />
          </div>
        )}
        <div className="flex flex-wrap gap-1.5">
          {runtime && (
            <Badge variant="outline" size="tag" className="font-mono">
              runtime: {runtime}
            </Badge>
          )}
          {timeout != null && (
            <Badge variant="outline" size="tag">
              timeout: {timeout}ms
            </Badge>
          )}
          {cwd && (
            <Badge variant="outline" size="tag" className="font-mono">
              cwd: {cwd}
            </Badge>
          )}
        </div>
        {args && args.length > 0 && (
          <div className="text-xs">
            <span className="text-muted-foreground">Args: </span>
            <span className="font-mono">{args.join(" ")}</span>
          </div>
        )}
      </div>
    </InspectorSection>
  );
}

function runtimeToLanguage(runtime: string | null, code: string): string {
  if (runtime === "bash") return "shell";
  if (runtime === "python") return "python";
  if (runtime === "ts") return "typescript";
  // Fallback: shebang sniffing
  const trimmed = code.trimStart();
  if (trimmed.startsWith("#!/usr/bin/env python") || trimmed.startsWith("#!/usr/bin/python"))
    return "python";
  if (trimmed.startsWith("#!/usr/bin/env node") || trimmed.startsWith("#!/usr/bin/node"))
    return "javascript";
  if (trimmed.startsWith("#!/usr/bin/env bun") || trimmed.startsWith("#!/usr/bin/env ts"))
    return "typescript";
  return "shell";
}

function RawLlmConfig({ config }: { config: Record<string, unknown> }) {
  const prompt = typeof config.prompt === "string" ? config.prompt : null;
  const model = typeof config.model === "string" ? config.model : null;

  return (
    <InspectorSection label="Configuration">
      <div className="space-y-3">
        {prompt && <HighlightedTemplate text={prompt} />}
        {model && (
          <Badge variant="outline" size="tag">
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
                    <Badge variant="outline" size="tag" className="shrink-0">
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
  // Schema field is `template`. Tolerate `message` as a legacy alias.
  const template =
    typeof config.template === "string"
      ? config.template
      : typeof config.message === "string"
        ? config.message
        : null;
  const target = typeof config.target === "string" ? config.target : null;
  const ChannelIcon = channelIcon(channel);

  return (
    <InspectorSection label="Configuration">
      <div className="space-y-3">
        {template && <HighlightedTemplate text={template} />}

        {(channel || target) && (
          <div className="flex items-center gap-2 text-xs flex-wrap">
            {ChannelIcon && <ChannelIcon className="h-3.5 w-3.5 text-action-notify shrink-0" />}
            {channel && (
              <>
                <span className="text-muted-foreground">Channel:</span>
                <Badge variant="outline" size="tag" className="font-mono">
                  {channel}
                </Badge>
              </>
            )}
            {target && (
              <span className="font-mono text-muted-foreground truncate" title={target}>
                {target}
              </span>
            )}
          </div>
        )}
      </div>
    </InspectorSection>
  );
}

function channelIcon(channel: string | null): React.ElementType | null {
  if (!channel) return null;
  const c = channel.toLowerCase();
  if (c === "slack") return MessageSquare;
  if (c === "email" || c === "mail") return Mail;
  if (c === "webhook" || c === "http") return Webhook;
  return Bell;
}

function PropertyMatchConfig({ config }: { config: Record<string, unknown> }) {
  const conditions = Array.isArray(config.conditions)
    ? (config.conditions as Array<{ field?: string; op?: string; value?: unknown }>)
    : null;
  const mode = typeof config.mode === "string" ? config.mode : "all";

  return (
    <InspectorSection label="Configuration">
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground">Mode:</span>
          <Badge variant="outline" size="tag">
            {mode.toUpperCase()}
          </Badge>
        </div>
        {conditions && conditions.length > 0 && (
          <div className="space-y-1.5">
            {conditions.map((cond, i) => (
              <div
                key={i}
                className="rounded-md bg-muted px-3 py-2 font-mono text-xs flex items-center gap-2 flex-wrap"
              >
                <span className="text-foreground">{cond.field ?? "?"}</span>
                <span className="text-status-active">{cond.op ?? "?"}</span>
                {cond.value !== undefined && (
                  <span className="text-muted-foreground">{JSON.stringify(cond.value)}</span>
                )}
              </div>
            ))}
          </div>
        )}
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

/**
 * Single-line metadata strip shown at the top of the Definition tab. Just a
 * pulse-check — full details (HMAC secrets, trigger schema, etc.) live in the
 * Triggers tab.
 */
function WorkflowMetaSummary({
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
  const hasAny =
    triggers.length > 0 ||
    cooldown != null ||
    (input != null && Object.keys(input).length > 0) ||
    triggerSchema != null;
  if (!hasAny) return null;

  const triggerSummary =
    triggers.length === 0
      ? null
      : triggers
          .map((t) => {
            if (t.type === "webhook") return "webhook";
            if (t.type === "schedule")
              return t.scheduleId ? `schedule ${t.scheduleId}` : "schedule";
            return t.type;
          })
          .join(", ");

  const inputCount = input != null ? Object.keys(input).length : 0;

  return (
    <div className="shrink-0 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
      {triggerSummary && (
        <div className="flex items-center gap-1.5">
          <span className="uppercase tracking-wide text-[10px]">Triggers:</span>
          <span className="font-mono text-foreground">{triggerSummary}</span>
        </div>
      )}
      {cooldown != null && (
        <div className="flex items-center gap-1.5">
          <span className="uppercase tracking-wide text-[10px]">Cooldown:</span>
          <span className="font-mono text-foreground">{formatCooldown(cooldown)}</span>
        </div>
      )}
      {inputCount > 0 && (
        <div className="flex items-center gap-1.5">
          <span className="uppercase tracking-wide text-[10px]">Input:</span>
          <span className="font-mono text-foreground">
            {inputCount} {inputCount === 1 ? "variable" : "variables"}
          </span>
        </div>
      )}
      {triggerSchema != null && (
        <div className="flex items-center gap-1.5">
          <span className="uppercase tracking-wide text-[10px]">Schema:</span>
          <span className="font-mono text-foreground">defined</span>
        </div>
      )}
    </div>
  );
}

/**
 * Top-bar Trigger button.
 *
 * If the workflow has a `triggerSchema` with `required` fields, sending the
 * default `{}` payload is guaranteed to fail the validator → 400. We disable
 * the button and surface a tooltip pointing the user at the Triggers tab,
 * where the payload tester (Phase 5) lets them craft a matching object.
 *
 * If `triggerSchema == null` OR is present but has no `required` array, the
 * empty payload is accepted by the validator and the button keeps its
 * pre-existing one-click behavior.
 */
function TopBarTriggerButton({
  workflowId,
  enabled,
  triggerSchema,
  triggerWorkflow,
  onSchemaRequired,
}: {
  workflowId: string;
  enabled: boolean;
  triggerSchema?: Record<string, unknown>;
  triggerWorkflow: ReturnType<typeof useTriggerWorkflow>;
  onSchemaRequired: () => void;
}) {
  const required = useMemo<string[]>(() => {
    if (triggerSchema == null) return [];
    const r = (triggerSchema as { required?: unknown }).required;
    return Array.isArray(r) ? r.filter((x): x is string => typeof x === "string") : [];
  }, [triggerSchema]);
  const requiresPayload = required.length > 0;

  if (requiresPayload) {
    // Instead of disabling, route the click to the Triggers tab where the
    // payload tester lets the user craft a matching payload. Tooltip names
    // the required fields so the intent is visible without a click.
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="outline"
            size="sm"
            onClick={onSchemaRequired}
            data-testid="top-bar-trigger-button-guarded"
          >
            <Play className="h-3 w-3 mr-1" /> Trigger
          </Button>
        </TooltipTrigger>
        <TooltipContent>
          <p className="max-w-xs">
            Trigger schema requires {required.join(", ")}. Opens the Triggers tab so you can craft a
            matching payload.
          </p>
        </TooltipContent>
      </Tooltip>
    );
  }

  return (
    <Button
      variant="outline"
      size="sm"
      onClick={() => triggerWorkflow.mutate({ id: workflowId })}
      disabled={!enabled || triggerWorkflow.isPending}
      data-testid="top-bar-trigger-button"
    >
      <Play className="h-3 w-3 mr-1" /> Trigger
    </Button>
  );
}

/**
 * Full Triggers tab — one card per trigger plus cooldown, input variables, and
 * the trigger schema. Webhook triggers reuse the existing badge/modal so the
 * URL + HMAC secret remain copy-able.
 */
/**
 * Forward link: schedules with `targetType='workflow'` that natively target
 * this workflow. Complements the reverse link shown above (this workflow's
 * own `triggers[].scheduleId` bindings, which a schedule doesn't know about).
 */
function LinkedSchedulesSection({ workflowId }: { workflowId: string }) {
  const { data: schedules } = useScheduledTasks({ targetType: "workflow", workflowId });

  if (!schedules || schedules.length === 0) return null;

  return (
    <section className="space-y-2">
      <h3 className="text-sm font-semibold">Linked Schedules ({schedules.length})</h3>
      <div className="space-y-2">
        {schedules.map((s) => (
          <Link
            key={s.id}
            to={`/schedules/${s.id}`}
            className="flex items-center justify-between gap-2 rounded-lg border bg-card p-3 text-sm hover:bg-accent/50 transition-colors"
          >
            <span className="font-medium">{s.name}</span>
            <span className="text-xs text-muted-foreground">
              {s.nextRunAt ? `next: ${formatSmartTime(s.nextRunAt)}` : s.enabled ? "—" : "disabled"}
            </span>
          </Link>
        ))}
      </div>
    </section>
  );
}

function TriggersDetailPanel({
  workflowId,
  triggers,
  cooldown,
  input,
  triggerSchema,
}: {
  workflowId: string;
  triggers: TriggerConfig[];
  cooldown?: CooldownConfig;
  input?: Record<string, string>;
  triggerSchema?: Record<string, unknown>;
}) {
  return (
    <ScrollArea className="flex-1 min-h-0">
      <div className="p-4 space-y-4">
        <section className="space-y-2">
          <h3 className="text-sm font-semibold">Triggers ({triggers.length})</h3>
          {triggers.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No triggers configured. The workflow can only be invoked manually.
            </p>
          ) : (
            <div className="space-y-2">
              {triggers.map((t, i) => (
                <TriggerCard key={i} workflowId={workflowId} trigger={t} />
              ))}
            </div>
          )}
        </section>

        <LinkedSchedulesSection workflowId={workflowId} />

        {cooldown != null && (
          <section className="space-y-2">
            <h3 className="text-sm font-semibold">Cooldown</h3>
            <div className="rounded-lg border bg-card p-3 text-xs">
              <span className="text-muted-foreground">Minimum interval between runs: </span>
              <span className="font-mono font-medium">{formatCooldown(cooldown)}</span>
            </div>
          </section>
        )}

        {input != null && Object.keys(input).length > 0 && (
          <section className="space-y-2">
            <h3 className="text-sm font-semibold">Input variables</h3>
            <div className="rounded-lg border bg-card p-3">
              <JsonTree data={input} defaultExpandDepth={2} maxHeight="200px" />
            </div>
          </section>
        )}

        <TriggerSchemaSection workflowId={workflowId} triggerSchema={triggerSchema} />
      </div>
    </ScrollArea>
  );
}

/**
 * Editable Monaco JSON editor with the same theming as the read-only Editors
 * elsewhere in this file. Used by the trigger-schema editor and the payload
 * tester so both surfaces get JSON syntax highlighting + bracket matching.
 */
function JsonMonacoEditor({
  value,
  onChange,
  height,
  readOnly = false,
  testId,
}: {
  value: string;
  onChange: (next: string) => void;
  height: number;
  readOnly?: boolean;
  testId?: string;
}) {
  const { theme } = useTheme();
  return (
    <div className="rounded-md overflow-hidden border border-border" data-testid={testId}>
      <Editor
        language="json"
        theme={theme === "dark" ? "github-dark" : "github-light"}
        value={value}
        height={`${height}px`}
        onChange={(v) => onChange(v ?? "")}
        beforeMount={(monaco) => {
          monaco.editor.defineTheme("github-light", monacoLightTheme);
          monaco.editor.defineTheme("github-dark", monacoDarkTheme);
        }}
        options={{
          readOnly,
          minimap: { enabled: false },
          scrollBeyondLastLine: false,
          fontSize: 12,
          lineNumbers: "on",
          wordWrap: "on",
          automaticLayout: true,
          padding: { top: 8, bottom: 8 },
          folding: false,
          renderLineHighlight: "none",
          scrollbar: { vertical: "auto", horizontal: "auto" },
          overviewRulerLanes: 0,
        }}
      />
    </div>
  );
}

/**
 * Generate a placeholder JSON value that satisfies the supported subset of our
 * `triggerSchema` validator (`type`/`required`/`properties`/`enum`/`const`/`items`).
 * Honors `const` and the first `enum` value when present; otherwise picks a
 * type-appropriate default. Recurses into objects + arrays. Returns `null` for
 * unknown types so the user can spot what to fill in. This is a hint, not a
 * guarantee — the user is expected to edit before sending.
 */
function sampleFromSchema(schema: unknown): unknown {
  if (schema == null || typeof schema !== "object") return null;
  const s = schema as Record<string, unknown>;
  if ("const" in s) return s.const;
  if (Array.isArray(s.enum) && s.enum.length > 0) return s.enum[0];
  const type = typeof s.type === "string" ? s.type : "object";
  switch (type) {
    case "object": {
      const out: Record<string, unknown> = {};
      const props = (s.properties as Record<string, unknown> | undefined) ?? {};
      const required = Array.isArray(s.required)
        ? s.required.filter((k): k is string => typeof k === "string")
        : Object.keys(props);
      for (const key of required) {
        out[key] = sampleFromSchema(props[key]);
      }
      return out;
    }
    case "array":
      return [sampleFromSchema(s.items)];
    case "string":
      return "example";
    case "number":
    case "integer":
      return 0;
    case "boolean":
      return false;
    case "null":
      return null;
    default:
      return null;
  }
}

/**
 * Trigger-schema editor + payload tester for a workflow.
 *
 * Always rendered (so a schema-less workflow can have one added). Splits into:
 *   - Read view: `JsonTree` of the current schema, plus Edit / Clear buttons.
 *   - Edit view: Monaco JSON editor with Save / Cancel and inline parse errors.
 *   - Tester (only when a schema is set): Monaco JSON payload + debounced
 *     dry-run validation (calls `/trigger/validate`) + Send trigger button
 *     (creates a real run) + bulleted error list from `TriggerSchemaApiError`.
 */
function TriggerSchemaSection({
  workflowId,
  triggerSchema,
}: {
  workflowId: string;
  triggerSchema?: Record<string, unknown>;
}) {
  const updateWorkflow = useUpdateWorkflow();
  const triggerWorkflow = useTriggerWorkflow();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [parseError, setParseError] = useState<string | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);

  // Tester state — only meaningful when a schema is set.
  const [testPayload, setTestPayload] = useState("{}");
  const [testParseError, setTestParseError] = useState<string | null>(null);
  const [testValidationDetails, setTestValidationDetails] = useState<string[] | null>(null);
  const [testGenericError, setTestGenericError] = useState<string | null>(null);
  const [testSuccessRunId, setTestSuccessRunId] = useState<string | null>(null);

  // Live (debounced) dry-run validation as the user edits the payload.
  type LiveStatus = "idle" | "syntax-error" | "validating" | "valid" | "invalid";
  const [liveStatus, setLiveStatus] = useState<LiveStatus>("idle");
  const [liveDetails, setLiveDetails] = useState<string[]>([]);
  const liveSeqRef = useRef(0);

  useEffect(() => {
    if (triggerSchema == null) {
      setLiveStatus("idle");
      setLiveDetails([]);
      return;
    }
    // Try to parse first — if invalid JSON, mark syntax-error without hitting the server.
    let parsed: unknown;
    try {
      parsed = JSON.parse(testPayload);
    } catch {
      setLiveStatus("syntax-error");
      setLiveDetails([]);
      return;
    }
    setLiveStatus("validating");
    const mySeq = ++liveSeqRef.current;
    const handle = setTimeout(() => {
      api
        .validateTriggerData(workflowId, parsed)
        .then(() => {
          if (mySeq === liveSeqRef.current) {
            setLiveStatus("valid");
            setLiveDetails([]);
          }
        })
        .catch((err) => {
          if (mySeq !== liveSeqRef.current) return;
          if (err instanceof TriggerSchemaApiError) {
            setLiveStatus("invalid");
            setLiveDetails(err.details.length > 0 ? err.details : [err.validationMessage]);
          } else {
            // Network or other error — don't block sending; clear live status.
            setLiveStatus("idle");
            setLiveDetails([]);
          }
        });
    }, 300);
    return () => clearTimeout(handle);
  }, [testPayload, triggerSchema, workflowId]);

  function startEdit() {
    setDraft(JSON.stringify(triggerSchema ?? {}, null, 2));
    setParseError(null);
    setEditing(true);
  }

  function cancelEdit() {
    setEditing(false);
    setParseError(null);
  }

  function saveEdit() {
    let parsed: unknown;
    try {
      parsed = JSON.parse(draft);
    } catch (e) {
      setParseError(e instanceof Error ? e.message : String(e));
      return;
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      setParseError("triggerSchema must be a JSON object (use 'Clear schema' to remove it).");
      return;
    }
    setParseError(null);
    updateWorkflow.mutate(
      { id: workflowId, data: { triggerSchema: parsed as Record<string, unknown> } },
      {
        onSuccess: () => {
          toast.success("Trigger schema saved");
          setEditing(false);
        },
        onError: (err) => {
          toast.error(err instanceof Error ? err.message : "Failed to save trigger schema");
        },
      },
    );
  }

  function confirmClearSchema() {
    updateWorkflow.mutate(
      { id: workflowId, data: { triggerSchema: null } },
      {
        onSuccess: () => {
          toast.success("Trigger schema cleared");
          setConfirmClear(false);
          setEditing(false);
        },
        onError: (err) => {
          toast.error(err instanceof Error ? err.message : "Failed to clear trigger schema");
        },
      },
    );
  }

  function runTest() {
    setTestParseError(null);
    setTestValidationDetails(null);
    setTestGenericError(null);
    setTestSuccessRunId(null);
    let parsed: unknown;
    try {
      parsed = JSON.parse(testPayload);
    } catch (e) {
      setTestParseError(e instanceof Error ? e.message : String(e));
      return;
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      setTestParseError("Payload must be a JSON object.");
      return;
    }
    triggerWorkflow.mutate(
      { id: workflowId, triggerData: parsed as Record<string, unknown> },
      {
        onSuccess: (data) => {
          setTestSuccessRunId(data.runId);
          toast.success("Workflow triggered");
        },
        onError: (err) => {
          if (err instanceof TriggerSchemaApiError) {
            setTestValidationDetails(
              err.details.length > 0 ? err.details : [err.validationMessage],
            );
          } else {
            setTestGenericError(err instanceof Error ? err.message : String(err));
          }
        },
      },
    );
  }

  return (
    <section className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">Trigger schema</h3>
        {!editing && (
          <div className="flex items-center gap-1.5">
            <Button variant="outline" size="sm" onClick={startEdit}>
              Edit
            </Button>
            {triggerSchema != null && (
              <Button variant="destructive-outline" size="sm" onClick={() => setConfirmClear(true)}>
                Clear schema
              </Button>
            )}
          </div>
        )}
      </div>
      <p className="text-xs text-muted-foreground">
        Validates the payload sent to this workflow before any node runs. Validator supports{" "}
        <code className="font-mono">type</code>, <code className="font-mono">required</code>,{" "}
        <code className="font-mono">properties</code>, <code className="font-mono">enum</code>,{" "}
        <code className="font-mono">const</code>, <code className="font-mono">items</code>. Other
        JSON-Schema keywords are silently ignored.
      </p>

      {editing ? (
        <div className="space-y-2">
          <JsonMonacoEditor
            value={draft}
            onChange={(v) => {
              setDraft(v);
              if (parseError) setParseError(null);
            }}
            height={280}
            testId="trigger-schema-editor"
          />
          {parseError && (
            <p
              className="text-xs text-destructive font-mono"
              data-testid="trigger-schema-parse-error"
            >
              {parseError}
            </p>
          )}
          <div className="flex items-center gap-1.5">
            <Button size="sm" onClick={saveEdit} disabled={updateWorkflow.isPending}>
              {updateWorkflow.isPending ? "Saving…" : "Save"}
            </Button>
            <Button variant="outline" size="sm" onClick={cancelEdit}>
              Cancel
            </Button>
          </div>
        </div>
      ) : triggerSchema != null ? (
        <div className="rounded-lg border bg-card p-3">
          <JsonTree data={triggerSchema} defaultExpandDepth={2} maxHeight="400px" />
        </div>
      ) : (
        <div className="rounded-lg border border-dashed bg-card p-3 text-xs text-muted-foreground">
          No trigger schema set — this workflow accepts any payload. Click{" "}
          <span className="font-medium">Edit</span> to add one.
        </div>
      )}

      {/* Payload tester — only meaningful when a schema is set. */}
      {triggerSchema != null && !editing && (
        <div
          className="space-y-2 rounded-lg border bg-card p-3"
          data-testid="trigger-schema-tester"
        >
          <div className="flex items-center justify-between gap-2">
            <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Send trigger
            </h4>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                const sample = sampleFromSchema(triggerSchema);
                setTestPayload(JSON.stringify(sample, null, 2));
                setTestParseError(null);
              }}
              data-testid="trigger-schema-use-sample"
              title="Generate a sample payload that matches the current trigger schema"
            >
              Use sample
            </Button>
          </div>
          <div
            className="rounded-md border border-status-active/40 bg-status-active/10 px-2 py-1.5 text-xs text-status-active-strong"
            data-testid="trigger-schema-real-run-warning"
          >
            <strong className="font-semibold">Heads up:</strong> clicking <em>Send trigger</em>{" "}
            starts a <strong>real workflow run</strong> with this payload — any nodes (Slack
            messages, GitHub actions, agent tasks, etc.) will fire. Use the live validator below to
            check the payload before sending; nothing runs until you click the button.
          </div>
          <JsonMonacoEditor
            value={testPayload}
            onChange={(v) => {
              setTestPayload(v);
              if (testParseError) setTestParseError(null);
            }}
            height={200}
            testId="trigger-schema-test-payload"
          />
          {/* Live (debounced) dry-run validation result */}
          {liveStatus === "syntax-error" && (
            <p
              className="text-xs text-destructive font-mono"
              data-testid="trigger-schema-live-syntax-error"
            >
              Invalid JSON syntax — fix before sending.
            </p>
          )}
          {liveStatus === "validating" && (
            <p
              className="text-xs text-muted-foreground"
              data-testid="trigger-schema-live-validating"
            >
              Validating…
            </p>
          )}
          {liveStatus === "valid" && (
            <p
              className="text-xs text-status-success-strong flex items-center gap-1"
              data-testid="trigger-schema-live-valid"
            >
              <Check className="h-3 w-3" /> Payload matches the schema. Safe to send.
            </p>
          )}
          {liveStatus === "invalid" && liveDetails.length > 0 && (
            <div
              className="rounded-md border border-destructive/40 bg-destructive/5 p-2"
              data-testid="trigger-schema-live-invalid"
            >
              <p className="text-xs font-semibold text-destructive mb-1">
                Payload would be rejected:
              </p>
              <ul className="list-disc list-inside text-xs text-destructive font-mono space-y-0.5">
                {liveDetails.map((d, i) => (
                  <li key={`${i}-${d}`}>{d}</li>
                ))}
              </ul>
            </div>
          )}
          <div className="flex items-center gap-1.5">
            <Button
              size="sm"
              onClick={runTest}
              disabled={
                triggerWorkflow.isPending ||
                liveStatus === "syntax-error" ||
                liveStatus === "invalid"
              }
              data-testid="trigger-schema-send-button"
            >
              <Play className="h-3 w-3 mr-1" />
              {triggerWorkflow.isPending ? "Sending…" : "Send trigger"}
            </Button>
          </div>
          {testParseError && (
            <p
              className="text-xs text-destructive font-mono"
              data-testid="trigger-schema-test-parse-error"
            >
              {testParseError}
            </p>
          )}
          {testValidationDetails && (
            <div
              className="rounded-md border border-destructive/40 bg-destructive/5 p-2"
              data-testid="trigger-schema-test-validation-error"
            >
              <p className="text-xs font-semibold text-destructive mb-1">
                Trigger schema validation failed
              </p>
              <ul className="list-disc list-inside text-xs text-destructive font-mono space-y-0.5">
                {testValidationDetails.map((d, i) => (
                  <li key={`${i}-${d}`}>{d}</li>
                ))}
              </ul>
            </div>
          )}
          {testGenericError && (
            <p
              className="text-xs text-destructive font-mono"
              data-testid="trigger-schema-test-generic-error"
            >
              {testGenericError}
            </p>
          )}
          {testSuccessRunId && (
            <div
              className="rounded-md border border-status-success/30 bg-status-success/5 p-2 text-xs"
              data-testid="trigger-schema-test-success"
            >
              <span className="text-muted-foreground">Run started: </span>
              <a
                className="font-mono text-status-success-strong hover:underline"
                href={`/workflow-runs/${testSuccessRunId}`}
              >
                {testSuccessRunId}
              </a>
            </div>
          )}
        </div>
      )}

      <AlertDialog open={confirmClear} onOpenChange={setConfirmClear}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Clear trigger schema?</AlertDialogTitle>
            <AlertDialogDescription>
              The workflow will accept any payload until a new schema is set. Existing trigger
              configurations are unaffected.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={confirmClearSchema} disabled={updateWorkflow.isPending}>
              {updateWorkflow.isPending ? "Clearing…" : "Clear schema"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}

function TriggerCard({ workflowId, trigger }: { workflowId: string; trigger: TriggerConfig }) {
  if (trigger.type === "webhook") {
    const apiUrl = getConfig().apiUrl.replace(/\/$/, "");
    const webhookUrl = `${apiUrl}/api/webhooks/${workflowId}`;
    const verification = getWebhookVerificationDisplay(trigger);
    return (
      <div className="rounded-lg border bg-card p-4 space-y-3">
        <div className="flex items-center gap-2">
          <Webhook className="h-4 w-4 text-status-success" />
          <Badge variant="outline" size="tag" className="font-mono">
            webhook
          </Badge>
        </div>
        <div className="space-y-3">
          <CopyableField label="POST URL" value={webhookUrl} />
          {trigger.hmacSecret ? (
            <>
              <CopyableField label="Verification format" value={verification.formatLabel} />
              <CopyableField label="Verification header" value={verification.header} />
              {verification.toleranceSeconds !== undefined && (
                <CopyableField
                  label="Timestamp tolerance"
                  value={`${verification.toleranceSeconds}s`}
                />
              )}
              <SecretField label={verification.secretLabel} value={trigger.hmacSecret} />
              <p className="text-[11px] text-muted-foreground leading-relaxed">
                {verification.hint}
              </p>
            </>
          ) : (
            <p className="text-xs text-muted-foreground">
              No HMAC secret is configured for this trigger.
            </p>
          )}
        </div>
      </div>
    );
  }

  if (trigger.type === "schedule") {
    return (
      <div className="rounded-lg border bg-card p-4 space-y-2">
        <div className="flex items-center gap-2">
          <Badge variant="outline" size="tag" className="font-mono">
            schedule
          </Badge>
          {trigger.scheduleId && <span className="font-mono text-xs">{trigger.scheduleId}</span>}
        </div>
        <p className="text-xs text-muted-foreground">
          {trigger.scheduleId
            ? "Runs on the cron schedule defined by the linked schedule entry."
            : "Schedule trigger without a schedule ID — link a schedule to activate it."}
        </p>
      </div>
    );
  }

  return (
    <div className="rounded-lg border bg-card p-4">
      <Badge variant="outline" size="tag" className="font-mono">
        {(trigger as TriggerConfig).type}
      </Badge>
    </div>
  );
}

function getWebhookVerificationDisplay(trigger: TriggerConfig): {
  formatLabel: string;
  header: string;
  toleranceSeconds?: number;
  secretLabel: string;
  hint: ReactNode;
} {
  const verification: WebhookVerification | undefined = trigger.verification;

  if (!verification) {
    const header = trigger.hmacHeader ?? "X-Hub-Signature-256";
    return {
      formatLabel: "hmac-sha256 (legacy)",
      header,
      secretLabel: "HMAC secret",
      hint: (
        <>
          Sign the raw request body with HMAC-SHA256 using the secret, then send the digest as{" "}
          <code className="font-mono">{header}: sha256=&lt;hex&gt;</code>.
        </>
      ),
    };
  }

  if (verification.format === "timestamped-hmac-sha256") {
    const timestampKey = verification.timestampKey ?? "t";
    const signatureKey = verification.signatureKey ?? "v1";
    return {
      formatLabel: "timestamped-hmac-sha256",
      header: verification.header,
      toleranceSeconds: verification.toleranceSeconds ?? 300,
      secretLabel: "HMAC secret",
      hint: (
        <>
          Sign <code className="font-mono">&lt;timestamp&gt;.&lt;raw body&gt;</code> with
          HMAC-SHA256, then send{" "}
          <code className="font-mono">
            {verification.header}: {timestampKey}=&lt;timestamp&gt;,{signatureKey}=&lt;hex&gt;
          </code>
          .
        </>
      ),
    };
  }

  if (verification.format === "token-equality") {
    return {
      formatLabel: "token-equality",
      header: verification.header,
      secretLabel: "Shared token",
      hint: (
        <>
          Send the shared token in{" "}
          <code className="font-mono">{verification.header}: &lt;token&gt;</code>.
        </>
      ),
    };
  }

  const header = verification.header ?? "X-Hub-Signature-256";
  return {
    formatLabel: "hmac-sha256",
    header,
    secretLabel: "HMAC secret",
    hint: (
      <>
        Sign the raw request body with HMAC-SHA256 using the secret, then send the digest as{" "}
        <code className="font-mono">{header}: sha256=&lt;hex&gt;</code>.
      </>
    ),
  };
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
  const { searchParams, setParam } = useUrlSearchState();
  const expanded = readStringParam(searchParams, "version") === version.id;

  return (
    <div className="rounded-lg border bg-card">
      <button
        type="button"
        onClick={() => setParam("version", expanded ? "" : version.id)}
        className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-muted/50 transition-colors"
      >
        {expanded ? (
          <ChevronDown className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
        )}
        <Badge variant="outline" size="tag" className="font-mono shrink-0">
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

function formatCooldown(c: CooldownConfig): string {
  const parts: string[] = [];
  if (c.hours) parts.push(`${c.hours}h`);
  if (c.minutes) parts.push(`${c.minutes}m`);
  if (c.seconds) parts.push(`${c.seconds}s`);
  return parts.length > 0 ? parts.join(" ") : "none";
}

// CopyIconButton / CopyableField / SecretField now live in
// @/components/shared/copyable-fields (shared with the script API tab).
