import Editor from "@monaco-editor/react";
import type { ColDef, RowClickedEvent } from "ag-grid-community";
import {
  ArrowLeft,
  Bell,
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  Eye,
  EyeOff,
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
import { CollapsibleDescription } from "@/components/shared/collapsible-description";
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
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { JsonTree } from "@/components/workflows/json-tree";
import { WorkflowGraph } from "@/components/workflows/workflow-graph";
import { useTheme } from "@/hooks/use-theme";
import { getConfig } from "@/lib/config";
import { cn, formatElapsed, formatSmartTime } from "@/lib/utils";

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
  const [graphMaximized, setGraphMaximized] = useState(false);

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
          <Badge variant="outline" size="tag">
            {workflow.definition.nodes.length} nodes
          </Badge>
          <Badge variant="outline" size="tag">
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
            <Badge variant="outline" size="tag">
              {node.type}
            </Badge>
            {executorInfo && (
              <Badge variant="outline" size="tag" className="text-sky-400">
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

const GITHUB_LIGHT_THEME = {
  base: "vs" as const,
  inherit: true,
  rules: [
    { token: "comment", foreground: "6a737d", fontStyle: "italic" },
    { token: "string", foreground: "032f62" },
    { token: "keyword", foreground: "d73a49" },
    { token: "number", foreground: "005cc5" },
    { token: "type", foreground: "d73a49" },
    { token: "function", foreground: "6f42c1" },
    { token: "variable", foreground: "e36209" },
    { token: "constant", foreground: "005cc5" },
    { token: "operator", foreground: "d73a49" },
  ],
  colors: {
    "editor.background": "#ffffff",
    "editor.foreground": "#24292f",
    "editor.lineHighlightBackground": "#f6f8fa",
    "editorLineNumber.foreground": "#6e7781",
    "editorLineNumber.activeForeground": "#24292f",
    "editor.selectionBackground": "#0366d625",
    "editorCursor.foreground": "#24292f",
    "editor.inactiveSelectionBackground": "#0366d610",
  },
};

const GITHUB_DARK_THEME = {
  base: "vs-dark" as const,
  inherit: true,
  rules: [
    { token: "comment", foreground: "8b949e", fontStyle: "italic" },
    { token: "string", foreground: "a5d6ff" },
    { token: "keyword", foreground: "ff7b72" },
    { token: "number", foreground: "79c0ff" },
    { token: "type", foreground: "ffa657" },
    { token: "function", foreground: "d2a8ff" },
    { token: "variable", foreground: "ffa657" },
    { token: "constant", foreground: "79c0ff" },
    { token: "operator", foreground: "ff7b72" },
  ],
  colors: {
    "editor.background": "#0d1117",
    "editor.foreground": "#c9d1d9",
    "editor.lineHighlightBackground": "#161b22",
    "editorLineNumber.foreground": "#6e7681",
    "editorLineNumber.activeForeground": "#c9d1d9",
    "editor.selectionBackground": "#388bfd44",
    "editorCursor.foreground": "#c9d1d9",
    "editor.inactiveSelectionBackground": "#388bfd22",
  },
};

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
          <div
            className={cn(
              "rounded-md border overflow-hidden",
              theme === "dark" ? "bg-[#0d1117]" : "bg-white",
            )}
          >
            <div
              className={cn(
                "flex items-center justify-between px-3 py-1.5 border-b",
                theme === "dark"
                  ? "border-white/10 bg-black/20 text-white/60"
                  : "border-zinc-200 bg-zinc-50 text-zinc-600",
              )}
            >
              <span className="text-[10px] font-mono uppercase tracking-wide">
                {runtime ?? language}
              </span>
              <div className="flex items-center gap-3">
                <span
                  className={cn(
                    "text-[10px] font-mono",
                    theme === "dark" ? "text-white/40" : "text-zinc-400",
                  )}
                >
                  {lineCount} {lineCount === 1 ? "line" : "lines"}
                </span>
                <CopyIconButton value={code} darkMode={theme === "dark"} />
              </div>
            </div>
            <Editor
              language={language}
              theme={theme === "dark" ? "github-dark" : "github-light"}
              value={code}
              height={`${editorHeight}px`}
              beforeMount={(monaco) => {
                monaco.editor.defineTheme("github-light", GITHUB_LIGHT_THEME);
                monaco.editor.defineTheme("github-dark", GITHUB_DARK_THEME);
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
            {ChannelIcon && <ChannelIcon className="h-3.5 w-3.5 text-teal-400 shrink-0" />}
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
                <span className="text-amber-500">{cond.op ?? "?"}</span>
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
 * Full Triggers tab — one card per trigger plus cooldown, input variables, and
 * the trigger schema. Webhook triggers reuse the existing badge/modal so the
 * URL + HMAC secret remain copy-able.
 */
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

        {triggerSchema != null && (
          <section className="space-y-2">
            <h3 className="text-sm font-semibold">Trigger schema</h3>
            <p className="text-xs text-muted-foreground">
              Validates the payload sent to this workflow before any node runs.
            </p>
            <div className="rounded-lg border bg-card p-3">
              <JsonTree data={triggerSchema} defaultExpandDepth={2} maxHeight="400px" />
            </div>
          </section>
        )}
      </div>
    </ScrollArea>
  );
}

function TriggerCard({ workflowId, trigger }: { workflowId: string; trigger: TriggerConfig }) {
  if (trigger.type === "webhook") {
    const apiUrl = getConfig().apiUrl.replace(/\/$/, "");
    const webhookUrl = `${apiUrl}/api/webhooks/${workflowId}`;
    const hmacHeader = trigger.hmacHeader ?? "X-Hub-Signature-256";
    return (
      <div className="rounded-lg border bg-card p-4 space-y-3">
        <div className="flex items-center gap-2">
          <Webhook className="h-4 w-4 text-emerald-500" />
          <Badge variant="outline" size="tag" className="font-mono">
            webhook
          </Badge>
        </div>
        <div className="space-y-3">
          <CopyableField label="POST URL" value={webhookUrl} />
          {trigger.hmacSecret ? (
            <>
              <CopyableField label="HMAC header" value={hmacHeader} />
              <SecretField label="HMAC secret" value={trigger.hmacSecret} />
              <p className="text-[11px] text-muted-foreground leading-relaxed">
                Sign the raw request body with HMAC-SHA256 using the secret, then send the digest as{" "}
                <code className="font-mono">{hmacHeader}: sha256=&lt;hex&gt;</code>.
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

function CopyIconButton({ value, darkMode }: { value: string; darkMode: boolean }) {
  const [copied, setCopied] = useState(false);
  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // ignore — clipboard not available
    }
  };
  return (
    <button
      type="button"
      onClick={handleCopy}
      aria-label={copied ? "Copied" : "Copy code"}
      title={copied ? "Copied" : "Copy code"}
      className={cn(
        "rounded p-1 transition-colors focus:outline-none focus:ring-1",
        darkMode
          ? "text-white/50 hover:text-white hover:bg-white/10 focus:ring-white/30"
          : "text-zinc-500 hover:text-zinc-900 hover:bg-zinc-200 focus:ring-zinc-400",
      )}
    >
      {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
    </button>
  );
}

function CopyableField({
  label,
  value,
  mono = true,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  const [copied, setCopied] = useState(false);
  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // ignore — clipboard not available
    }
  };
  return (
    <div className="space-y-1.5">
      <Label className="text-xs text-muted-foreground uppercase tracking-wide">{label}</Label>
      <div className="flex items-center gap-2">
        <Input
          readOnly
          value={value}
          className={cn("h-9", mono && "font-mono text-xs")}
          onFocus={(e) => e.currentTarget.select()}
        />
        <Button
          type="button"
          variant="outline"
          size="icon"
          onClick={handleCopy}
          aria-label={`Copy ${label}`}
          className="shrink-0"
        >
          {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
        </Button>
      </div>
    </div>
  );
}

function SecretField({ label, value }: { label: string; value: string }) {
  const [revealed, setRevealed] = useState(false);
  const [copied, setCopied] = useState(false);
  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // ignore
    }
  };
  return (
    <div className="space-y-1.5">
      <Label className="text-xs text-muted-foreground uppercase tracking-wide">{label}</Label>
      <div className="flex items-center gap-2">
        <Input
          readOnly
          type={revealed ? "text" : "password"}
          value={value}
          className="h-9 font-mono text-xs"
          onFocus={(e) => e.currentTarget.select()}
        />
        <Button
          type="button"
          variant="outline"
          size="icon"
          onClick={() => setRevealed((v) => !v)}
          aria-label={revealed ? "Hide secret" : "Reveal secret"}
          className="shrink-0"
        >
          {revealed ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
        </Button>
        <Button
          type="button"
          variant="outline"
          size="icon"
          onClick={handleCopy}
          aria-label={`Copy ${label}`}
          className="shrink-0"
        >
          {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
        </Button>
      </div>
    </div>
  );
}
