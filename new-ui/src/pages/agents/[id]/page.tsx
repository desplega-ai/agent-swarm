import { useState, useMemo, useCallback } from "react";
import { useParams, useNavigate } from "react-router-dom";
import type { ColDef, RowClickedEvent } from "ag-grid-community";
import { useAgent, useUpdateAgentName } from "@/api/hooks/use-agents";
import { useTasks } from "@/api/hooks/use-tasks";
import { useAgentUsageSummary } from "@/api/hooks/use-costs";
import { StatusBadge } from "@/components/shared/status-badge";
import { JsonViewer } from "@/components/shared/json-viewer";
import { DataGrid } from "@/components/shared/data-grid";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { formatSmartTime, formatCurrency, formatCompactNumber, formatDuration } from "@/lib/utils";
import { Check, Pencil, X, ArrowLeft } from "lucide-react";
import type { AgentTask, AgentTaskStatus } from "@/api/types";

export default function AgentDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { data: agent, isLoading } = useAgent(id!);
  const { data: tasksData } = useTasks({ agentId: id });
  const { data: usage } = useAgentUsageSummary(id!);
  const updateName = useUpdateAgentName();

  const [editing, setEditing] = useState(false);
  const [editName, setEditName] = useState("");

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

  const taskColDefs = useMemo<ColDef<AgentTask>[]>(
    () => [
      {
        field: "task",
        headerName: "Description",
        flex: 1,
        minWidth: 300,
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
      { field: "taskType", headerName: "Type", width: 100 },
      { field: "priority", headerName: "Priority", width: 80 },
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
    <div className="flex-1 min-h-0 overflow-y-auto space-y-4">
      <button
        type="button"
        onClick={() => navigate("/agents")}
        className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors"
      >
        <ArrowLeft className="h-4 w-4" /> Back to Agents
      </button>

      <div className="flex items-center gap-3">
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

      <Tabs defaultValue="profile">
        <TabsList>
          <TabsTrigger value="profile">Profile</TabsTrigger>
          <TabsTrigger value="tasks">Tasks ({tasksData?.tasks.length ?? 0})</TabsTrigger>
          <TabsTrigger value="usage">Usage</TabsTrigger>
        </TabsList>

        <TabsContent value="profile" className="space-y-4 mt-4">
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

          {agent.soulMd && <JsonViewer data={agent.soulMd} title="SOUL.md" />}
          {agent.identityMd && <JsonViewer data={agent.identityMd} title="IDENTITY.md" />}
          {agent.claudeMd && <JsonViewer data={agent.claudeMd} title="CLAUDE.md" />}
        </TabsContent>

        <TabsContent value="tasks" className="mt-4">
          <DataGrid
            rowData={tasksData?.tasks ?? []}
            columnDefs={taskColDefs}
            onRowClicked={onTaskClicked}
            emptyMessage="No tasks for this agent"
          />
        </TabsContent>

        <TabsContent value="usage" className="mt-4">
          {usage ? (
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              {(["daily", "weekly", "monthly", "all"] as const).map((period) => (
                <Card key={period}>
                  <CardHeader className="pb-2">
                    <CardTitle className="text-xs uppercase text-muted-foreground tracking-wide">
                      {period === "all" ? "All Time" : period}
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-1">
                    <p className="text-lg font-bold font-mono">
                      {formatCurrency(usage[period].totalCostUsd)}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {formatCompactNumber(usage[period].totalTokens)} tokens &middot;{" "}
                      {usage[period].sessionCount} sessions
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {formatDuration(usage[period].totalDurationMs)} total
                    </p>
                  </CardContent>
                </Card>
              ))}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground py-4 text-center">
              No usage data available
            </p>
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}
