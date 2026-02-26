import { useState, useMemo, useCallback } from "react";
import { useParams, useNavigate } from "react-router-dom";
import type { ColDef, RowClickedEvent } from "ag-grid-community";
import { useAgent, useUpdateAgentName, useUpdateAgentProfile } from "@/api/hooks/use-agents";
import { useTasks } from "@/api/hooks/use-tasks";
import { useSessionCosts } from "@/api/hooks/use-costs";
import { StatusBadge } from "@/components/shared/status-badge";
import { UsageSummary } from "@/components/shared/usage-summary";
import { DataGrid } from "@/components/shared/data-grid";
import { Card, CardContent } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { formatSmartTime, formatElapsed } from "@/lib/utils";
import { Check, Pencil, X, ArrowLeft, Search, GitBranch, ChevronDown, ChevronRight } from "lucide-react";
import type { Agent, AgentTask, AgentTaskStatus } from "@/api/types";

const PAGE_SIZE = 100;

type MdField = "soulMd" | "identityMd" | "claudeMd" | "toolsMd" | "setupScript";

function EditableMarkdownField({
  title,
  field,
  agent,
  onSave,
  saving,
}: {
  title: string;
  field: MdField;
  agent: Agent;
  onSave: (field: MdField, value: string) => void;
  saving: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const value = agent[field] ?? "";

  function startEditing() {
    setDraft(value);
    setEditing(true);
    setExpanded(true);
  }

  function cancel() {
    setEditing(false);
  }

  function save() {
    onSave(field, draft);
    setEditing(false);
  }

  return (
    <div className="rounded-md border border-border/50">
      <div className="flex w-full items-center gap-2 px-3 py-2">
        <button
          type="button"
          onClick={() => setExpanded(!expanded)}
          className="flex flex-1 items-center gap-2 text-sm font-medium text-muted-foreground hover:text-foreground transition-colors"
        >
          {expanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
          {title}
          {!value && (
            <span className="text-xs font-normal italic text-muted-foreground/60">empty</span>
          )}
        </button>
        {!editing && (
          <Button size="icon" variant="ghost" className="h-7 w-7" onClick={startEditing}>
            <Pencil className="h-3.5 w-3.5" />
          </Button>
        )}
      </div>
      {expanded && (
        <div className="border-t border-border/50">
          {editing ? (
            <div className="p-3 space-y-2">
              <Textarea
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                className="min-h-40 font-mono text-xs"
                autoFocus
              />
              <div className="flex items-center gap-2">
                <Button size="sm" onClick={save} disabled={saving}>
                  <Check className="h-3.5 w-3.5 mr-1" />
                  Save
                </Button>
                <Button size="sm" variant="ghost" onClick={cancel}>
                  <X className="h-3.5 w-3.5 mr-1" />
                  Cancel
                </Button>
              </div>
            </div>
          ) : value ? (
            <pre className="overflow-auto bg-muted/30 p-3 text-xs font-mono leading-relaxed text-foreground/80 max-h-96">
              {value}
            </pre>
          ) : (
            <p className="px-3 py-4 text-sm text-muted-foreground/60 italic">
              No content — click Edit to add
            </p>
          )}
        </div>
      )}
    </div>
  );
}

export default function AgentDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { data: agent, isLoading } = useAgent(id!);
  const updateName = useUpdateAgentName();
  const updateProfile = useUpdateAgentProfile();

  const [editing, setEditing] = useState(false);
  const [editName, setEditName] = useState("");

  // Task tab filters
  const [taskSearch, setTaskSearch] = useState("");
  const [taskStatus, setTaskStatus] = useState("all");
  const [taskPage, setTaskPage] = useState(0);

  const taskFilters = useMemo(() => {
    const f: { agentId?: string; status?: string; search?: string; limit: number; offset: number } = {
      agentId: id,
      limit: PAGE_SIZE,
      offset: taskPage * PAGE_SIZE,
    };
    if (taskStatus !== "all") f.status = taskStatus;
    if (taskSearch) f.search = taskSearch;
    return f;
  }, [id, taskStatus, taskSearch, taskPage]);

  const { data: tasksData, isLoading: tasksLoading } = useTasks(taskFilters);
  const { data: agentCosts } = useSessionCosts({ agentId: id, limit: 1000 });

  const taskTotal = tasksData?.total ?? 0;
  const taskTotalPages = Math.max(1, Math.ceil(taskTotal / PAGE_SIZE));

  function startEditing() {
    setEditName(agent?.name ?? "");
    setEditing(true);
  }

  function saveName() {
    if (id && editName.trim()) {
      updateName.mutate({ id, name: editName.trim() });
    }
    setEditing(false);
  }

  function saveField(field: MdField, value: string) {
    if (id) {
      updateProfile.mutate({ id, profile: { [field]: value } });
    }
  }

  const taskColDefs = useMemo<ColDef<AgentTask>[]>(
    () => [
      {
        field: "task",
        headerName: "Description",
        flex: 1,
        minWidth: 250,
        cellRenderer: (params: { value: string }) => (
          <span className="truncate">{params.value}</span>
        ),
      },
      {
        field: "status",
        headerName: "Status",
        width: 130,
        cellRenderer: (params: { value: AgentTaskStatus }) => (
          <StatusBadge status={params.value} />
        ),
      },
      {
        field: "taskType",
        headerName: "Type",
        width: 110,
        cellRenderer: (params: { value: string | undefined }) =>
          params.value ? (
            <Badge variant="outline" className="text-[9px] px-1.5 py-0 h-5 font-medium leading-none items-center uppercase">
              {params.value}
            </Badge>
          ) : null,
      },
      {
        headerName: "Elapsed",
        width: 100,
        valueGetter: (params) => {
          const task = params.data;
          if (!task) return "";
          const start = task.acceptedAt ?? task.createdAt;
          const end = task.finishedAt;
          const isActive = !end && (task.status === "in_progress" || task.status === "pending" || task.status === "offered");
          return isActive ? formatElapsed(start) : end ? formatElapsed(start, end) : "—";
        },
      },
      {
        field: "dependsOn",
        headerName: "Deps",
        width: 90,
        cellRenderer: (params: { value: string[] | undefined }) => {
          const deps = params.value;
          if (!deps || deps.length === 0) return null;
          return (
            <div className="flex items-center gap-1 text-muted-foreground">
              <GitBranch className="h-3 w-3 shrink-0" />
              <span className="text-[10px] font-mono">{deps.length}</span>
            </div>
          );
        },
        sortable: false,
      },
      {
        field: "createdAt",
        headerName: "Created",
        width: 150,
        valueFormatter: (params) => (params.value ? formatSmartTime(params.value) : ""),
      },
    ],
    [],
  );

  const onTaskClicked = useCallback(
    (event: RowClickedEvent<AgentTask>) => {
      if (event.data) navigate(`/tasks/${event.data.id}`);
    },
    [navigate],
  );

  if (isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  if (!agent) {
    return <p className="text-muted-foreground">Agent not found.</p>;
  }

  return (
    <div className="flex flex-col flex-1 min-h-0 overflow-hidden gap-3">
      <div className="shrink-0">
        <button
          type="button"
          onClick={() => navigate("/agents")}
          className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors"
        >
          <ArrowLeft className="h-4 w-4" /> Back to Agents
        </button>
      </div>

      <div className="flex items-center gap-3 shrink-0">
        {editing ? (
          <div className="flex items-center gap-2">
            <Input
              value={editName}
              onChange={(e) => setEditName(e.target.value)}
              className="h-9 w-64"
              onKeyDown={(e) => {
                if (e.key === "Enter") saveName();
                if (e.key === "Escape") setEditing(false);
              }}
              autoFocus
            />
            <Button size="icon" variant="ghost" onClick={saveName}>
              <Check className="h-4 w-4" />
            </Button>
            <Button size="icon" variant="ghost" onClick={() => setEditing(false)}>
              <X className="h-4 w-4" />
            </Button>
          </div>
        ) : (
          <div className="flex items-center gap-2">
            <h1 className="text-xl font-semibold">{agent.name}</h1>
            <Button size="icon" variant="ghost" onClick={startEditing}>
              <Pencil className="h-4 w-4" />
            </Button>
          </div>
        )}
        <StatusBadge status={agent.status} size="md" />
      </div>

      <Tabs defaultValue="profile" className="flex flex-col flex-1 min-h-0">
        <TabsList className="shrink-0">
          <TabsTrigger value="profile">Profile</TabsTrigger>
          <TabsTrigger value="tasks">Tasks ({taskTotal})</TabsTrigger>
          <TabsTrigger value="usage">Usage</TabsTrigger>
        </TabsList>

        <TabsContent value="profile" className="space-y-4 mt-4 overflow-y-auto">
          <Card>
            <CardContent className="p-4 space-y-3">
              {agent.role && (
                <div>
                  <span className="text-xs text-muted-foreground uppercase tracking-wide">Role</span>
                  <p className="text-sm">{agent.role}</p>
                </div>
              )}
              {agent.description && (
                <div>
                  <span className="text-xs text-muted-foreground uppercase tracking-wide">Description</span>
                  <p className="text-sm">{agent.description}</p>
                </div>
              )}
              {agent.capabilities && agent.capabilities.length > 0 && (
                <div>
                  <span className="text-xs text-muted-foreground uppercase tracking-wide">Capabilities</span>
                  <div className="flex flex-wrap gap-1 mt-1">
                    {agent.capabilities.map((cap) => (
                      <Badge key={cap} variant="outline" className="text-[9px] px-1.5 py-0 h-5 font-medium leading-none items-center uppercase">
                        {cap}
                      </Badge>
                    ))}
                  </div>
                </div>
              )}
              <div className="text-xs text-muted-foreground">
                Joined {formatSmartTime(agent.createdAt)} &middot; Updated{" "}
                {formatSmartTime(agent.lastUpdatedAt)}
              </div>
            </CardContent>
          </Card>

          <EditableMarkdownField title="SOUL.md" field="soulMd" agent={agent} onSave={saveField} saving={updateProfile.isPending} />
          <EditableMarkdownField title="IDENTITY.md" field="identityMd" agent={agent} onSave={saveField} saving={updateProfile.isPending} />
          <EditableMarkdownField title="CLAUDE.md" field="claudeMd" agent={agent} onSave={saveField} saving={updateProfile.isPending} />
          <EditableMarkdownField title="TOOLS.md" field="toolsMd" agent={agent} onSave={saveField} saving={updateProfile.isPending} />
          <EditableMarkdownField title="Setup Script" field="setupScript" agent={agent} onSave={saveField} saving={updateProfile.isPending} />
        </TabsContent>

        <TabsContent value="tasks" className="flex flex-col flex-1 min-h-0 mt-4 gap-3">
          <div className="flex items-center gap-3 shrink-0">
            <div className="relative flex-1 max-w-sm">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                placeholder="Search tasks..."
                value={taskSearch}
                onChange={(e) => { setTaskSearch(e.target.value); setTaskPage(0); }}
                className="pl-9"
              />
            </div>
            <Select value={taskStatus} onValueChange={(v) => { setTaskStatus(v); setTaskPage(0); }}>
              <SelectTrigger className="w-[160px]">
                <SelectValue placeholder="Status" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Statuses</SelectItem>
                <SelectItem value="pending">Pending</SelectItem>
                <SelectItem value="in_progress">In Progress</SelectItem>
                <SelectItem value="completed">Completed</SelectItem>
                <SelectItem value="failed">Failed</SelectItem>
                <SelectItem value="cancelled">Cancelled</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <DataGrid
            rowData={tasksData?.tasks ?? []}
            columnDefs={taskColDefs}
            onRowClicked={onTaskClicked}
            loading={tasksLoading}
            emptyMessage="No tasks for this agent"
            pagination={false}
          />

          <div className="flex items-center justify-between shrink-0 text-sm text-muted-foreground">
            <span>
              {taskTotal > 0
                ? `${taskPage * PAGE_SIZE + 1}–${Math.min((taskPage + 1) * PAGE_SIZE, taskTotal)} of ${taskTotal}`
                : "0 tasks"}
            </span>
            <div className="flex items-center gap-1">
              <Button
                variant="outline"
                size="icon"
                className="h-8 w-8"
                disabled={taskPage === 0}
                onClick={() => setTaskPage(taskPage - 1)}
              >
                <ArrowLeft className="h-4 w-4" />
              </Button>
              <span className="px-2 text-xs">
                Page {taskPage + 1} of {taskTotalPages}
              </span>
              <Button
                variant="outline"
                size="icon"
                className="h-8 w-8"
                disabled={taskPage >= taskTotalPages - 1}
                onClick={() => setTaskPage(taskPage + 1)}
              >
                <ArrowLeft className="h-4 w-4 rotate-180" />
              </Button>
            </div>
          </div>
        </TabsContent>

        <TabsContent value="usage" className="mt-4">
          <UsageSummary costs={agentCosts ?? []} daysBack={30} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
