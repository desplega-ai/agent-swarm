import { ArrowLeft, Check, Crown, Pencil, Search, X } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useAgent, useUpdateAgentName, useUpdateAgentProfile } from "@/api/hooks/use-agents";
import { useSessionCosts } from "@/api/hooks/use-costs";
import { useAgentMcpServers, useUninstallMcpServer } from "@/api/hooks/use-mcp-servers";
import { useAgentSkills, useUninstallSkill } from "@/api/hooks/use-skills";
import { useTasks } from "@/api/hooks/use-tasks";
import type { Agent, AgentSkill, AgentTask, McpServerWithInstallInfo } from "@/api/types";
import { AgentRuntimeSettings } from "@/components/shared/agent-runtime-settings";
import { HarnessCell } from "@/components/shared/harness-cell";
import { StatusBadge } from "@/components/shared/status-badge";
import {
  ignoreRowClickFromInteractives,
  TasksColumnsMenu,
  TasksTable,
  useTasksColumns,
} from "@/components/shared/tasks-table";
import { UsageSummary } from "@/components/shared/usage-summary";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  DetailPageBody,
  DetailPageRail,
  QuickStat,
  QuickStats,
} from "@/components/ui/detail-page-layout";
import { DefinitionList, InfoRow } from "@/components/ui/info-row";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { formatSmartTime } from "@/lib/utils";
import { CredentialsPanel } from "./credentials-panel";

const PAGE_SIZE = 100;

type MdField = "soulMd" | "identityMd" | "claudeMd" | "toolsMd" | "setupScript" | "heartbeatMd";

const AGENT_TABS = [
  "profile",
  "credentials",
  "documents",
  "tasks",
  "skills",
  "mcp-servers",
  "usage",
] as const;

const DOCUMENT_FIELDS: Array<{ field: MdField; tab: string; label: string }> = [
  { field: "soulMd", tab: "soul", label: "SOUL.md" },
  { field: "identityMd", tab: "identity", label: "IDENTITY.md" },
  { field: "claudeMd", tab: "claude", label: "CLAUDE.md" },
  { field: "toolsMd", tab: "tools", label: "TOOLS.md" },
  { field: "setupScript", tab: "setup", label: "Setup script" },
  { field: "heartbeatMd", tab: "heartbeat", label: "HEARTBEAT.md" },
];

function MarkdownDocumentEditor({
  field,
  label,
  agent,
  onSave,
  saving,
}: {
  field: MdField;
  label: string;
  agent: Agent;
  onSave: (field: MdField, value: string) => void;
  saving: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const value = agent[field] ?? "";

  function start() {
    setDraft(value);
    setEditing(true);
  }
  function cancel() {
    setEditing(false);
  }
  function save() {
    onSave(field, draft);
    setEditing(false);
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-muted-foreground">{label}</h3>
        {!editing ? (
          <Button size="sm" variant="ghost" onClick={start}>
            <Pencil className="h-3.5 w-3.5 mr-1.5" />
            Edit
          </Button>
        ) : (
          <div className="flex items-center gap-1">
            <Button size="sm" onClick={save} disabled={saving}>
              <Check className="h-3.5 w-3.5 mr-1.5" />
              Save
            </Button>
            <Button size="sm" variant="ghost" onClick={cancel}>
              <X className="h-3.5 w-3.5 mr-1.5" />
              Cancel
            </Button>
          </div>
        )}
      </div>
      {editing ? (
        <Textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          className="min-h-[420px] font-mono text-xs"
          autoFocus
        />
      ) : value ? (
        <pre className="rounded-md border border-border/50 bg-muted/30 p-3 text-xs font-mono leading-relaxed text-foreground/80 overflow-auto max-h-[60vh]">
          {value}
        </pre>
      ) : (
        <div className="rounded-md border border-dashed border-border/50 p-6 text-center">
          <p className="text-sm text-muted-foreground italic">
            No content yet — click Edit to add.
          </p>
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

  const [searchParams, setSearchParams] = useSearchParams();
  const tabParam = searchParams.get("tab");
  const activeTab = AGENT_TABS.includes(tabParam as (typeof AGENT_TABS)[number])
    ? (tabParam as string)
    : "profile";
  const setActiveTab = useCallback(
    (value: string) => {
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          next.set("tab", value);
          return next;
        },
        { replace: true },
      );
    },
    [setSearchParams],
  );

  const docTypeParam = searchParams.get("docType");
  const activeDocType = DOCUMENT_FIELDS.some((d) => d.tab === docTypeParam)
    ? (docTypeParam as string)
    : "soul";
  const setActiveDocType = useCallback(
    (value: string) => {
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          next.set("docType", value);
          return next;
        },
        { replace: true },
      );
    },
    [setSearchParams],
  );

  // Task tab filters
  const [taskSearch, setTaskSearch] = useState("");
  const [taskStatus, setTaskStatus] = useState("all");
  const [taskPage, setTaskPage] = useState(0);

  const taskFilters = useMemo(() => {
    const f: { agentId?: string; status?: string; search?: string; limit: number; offset: number } =
      {
        agentId: id,
        limit: PAGE_SIZE,
        offset: taskPage * PAGE_SIZE,
      };
    if (taskStatus !== "all") f.status = taskStatus;
    if (taskSearch) f.search = taskSearch;
    return f;
  }, [id, taskStatus, taskSearch, taskPage]);

  const { data: tasksData, isLoading: tasksLoading } = useTasks(taskFilters);
  const { data: agentCosts } = useSessionCosts({
    agentId: id,
    limit: 1000,
    enabled: activeTab === "usage",
  });
  const { data: agentSkillsData } = useAgentSkills(id!, activeTab === "skills");
  const uninstallSkill = useUninstallSkill();
  const agentSkillsList = agentSkillsData?.skills ?? [];
  const { data: agentMcpServersData } = useAgentMcpServers(id!, activeTab === "mcp-servers");
  const uninstallMcpServer = useUninstallMcpServer();
  const agentMcpServersList = agentMcpServersData?.servers ?? [];

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

  const onTaskClicked = useMemo(
    () =>
      ignoreRowClickFromInteractives<AgentTask>((event) => {
        if (event.data) navigate(`/tasks/${event.data.id}`);
      }),
    [navigate],
  );

  const taskColumns = useTasksColumns({
    storageKey: "agent-detail-tasks",
    hiddenColumns: ["agent"],
    defaultHiddenColumns: ["cost", "deps", "tags"],
    defaultHiddenForNewColumns: ["cost"],
  });

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
            {agent.isLead && <Crown className="h-7 w-7 text-primary shrink-0" />}
            <Input
              value={editName}
              onChange={(e) => setEditName(e.target.value)}
              className="h-11 w-72 text-2xl font-semibold"
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
          <div className="flex items-center gap-2.5">
            {agent.isLead && <Crown className="h-7 w-7 text-primary shrink-0" />}
            <h1 className="text-3xl font-bold tracking-tight">{agent.name}</h1>
            <Button size="icon" variant="ghost" onClick={startEditing}>
              <Pencil className="h-4 w-4" />
            </Button>
          </div>
        )}
        {agent.role && (
          <span className="text-base text-muted-foreground font-medium">{agent.role}</span>
        )}
        <StatusBadge status={agent.status} size="md" />
      </div>

      <Tabs value={activeTab} onValueChange={setActiveTab} className="flex flex-col flex-1 min-h-0">
        <TabsList className="shrink-0">
          <TabsTrigger value="profile">Profile</TabsTrigger>
          <TabsTrigger value="credentials">Credentials</TabsTrigger>
          <TabsTrigger value="documents">Documents</TabsTrigger>
          <TabsTrigger value="tasks">Tasks ({taskTotal})</TabsTrigger>
          <TabsTrigger value="skills">Skills ({agentSkillsList.length})</TabsTrigger>
          <TabsTrigger value="mcp-servers">MCP Servers ({agentMcpServersList.length})</TabsTrigger>
          <TabsTrigger value="usage">Usage</TabsTrigger>
        </TabsList>

        <TabsContent value="profile" className="mt-4 overflow-y-auto">
          <DetailPageBody
            main={
              <Card>
                <CardContent className="p-4">
                  <DefinitionList>
                    <InfoRow label="Harness">
                      <HarnessCell
                        harnessProvider={agent.harnessProvider}
                        credStatus={agent.credStatus}
                      />
                    </InfoRow>
                    <InfoRow label="Runtime">
                      <AgentRuntimeSettings agent={agent} />
                    </InfoRow>
                    {agent.role && <InfoRow label="Role">{agent.role}</InfoRow>}
                    {agent.description && (
                      <InfoRow label="Description">{agent.description}</InfoRow>
                    )}
                    {agent.capabilities && agent.capabilities.length > 0 && (
                      <InfoRow label="Capabilities">
                        <div className="flex flex-wrap gap-1 mt-1">
                          {agent.capabilities.map((cap) => (
                            <Badge key={cap} variant="outline" size="tag">
                              {cap}
                            </Badge>
                          ))}
                        </div>
                      </InfoRow>
                    )}
                    <InfoRow label="Joined">{formatSmartTime(agent.createdAt)}</InfoRow>
                    <InfoRow label="Last update">{formatSmartTime(agent.lastUpdatedAt)}</InfoRow>
                  </DefinitionList>
                </CardContent>
              </Card>
            }
            rail={
              <DetailPageRail>
                <QuickStats>
                  <QuickStat label="Status" value={agent.status} />
                  {agent.harnessProvider && (
                    <QuickStat label="Harness" value={agent.harnessProvider} mono />
                  )}
                  {(agent.capacity || agent.maxTasks != null) && (
                    <QuickStat
                      label="Capacity"
                      value={
                        agent.capacity
                          ? `${agent.capacity.current} / ${agent.capacity.max}`
                          : `Max ${agent.maxTasks}`
                      }
                      mono
                    />
                  )}
                  <QuickStat label="Joined" value={formatSmartTime(agent.createdAt)} />
                  <QuickStat label="Updated" value={formatSmartTime(agent.lastUpdatedAt)} />
                </QuickStats>
              </DetailPageRail>
            }
          />
        </TabsContent>

        <TabsContent value="credentials" className="mt-4 overflow-y-auto">
          <CredentialsPanel agent={agent} />
        </TabsContent>

        <TabsContent
          value="documents"
          className="mt-4 flex flex-col flex-1 min-h-0 overflow-hidden"
        >
          <Tabs
            value={activeDocType}
            onValueChange={setActiveDocType}
            className="flex flex-col flex-1 min-h-0"
          >
            <TabsList className="shrink-0 w-full justify-start">
              {DOCUMENT_FIELDS.map(({ tab, label, field }) => {
                const empty = !agent[field];
                return (
                  <TabsTrigger key={tab} value={tab} className="gap-1.5">
                    {label}
                    {empty && (
                      <span className="text-[9px] uppercase tracking-wide text-muted-foreground/60">
                        empty
                      </span>
                    )}
                  </TabsTrigger>
                );
              })}
            </TabsList>
            {DOCUMENT_FIELDS.map(({ tab, label, field }) => (
              <TabsContent key={tab} value={tab} className="mt-3 overflow-y-auto">
                <MarkdownDocumentEditor
                  field={field}
                  label={label}
                  agent={agent}
                  onSave={saveField}
                  saving={updateProfile.isPending}
                />
              </TabsContent>
            ))}
          </Tabs>
        </TabsContent>

        <TabsContent value="tasks" className="flex flex-col flex-1 min-h-0 mt-4 gap-3">
          <div className="flex items-center gap-3 shrink-0">
            <div className="relative flex-1 max-w-sm">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                placeholder="Search tasks..."
                value={taskSearch}
                onChange={(e) => {
                  setTaskSearch(e.target.value);
                  setTaskPage(0);
                }}
                className="pl-9"
              />
            </div>
            <Select
              value={taskStatus}
              onValueChange={(v) => {
                setTaskStatus(v);
                setTaskPage(0);
              }}
            >
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
            <div className="ml-auto">
              <TasksColumnsMenu state={taskColumns} />
            </div>
          </div>

          <TasksTable
            rowData={tasksData?.tasks ?? []}
            loading={tasksLoading}
            onRowClicked={onTaskClicked}
            columns={taskColumns}
            emptyMessage="No tasks for this agent"
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

        <TabsContent value="skills" className="mt-4 overflow-y-auto">
          {agentSkillsList.length === 0 ? (
            <p className="text-sm text-muted-foreground">No skills installed for this agent.</p>
          ) : (
            <div className="space-y-2">
              {agentSkillsList.map((skill: AgentSkill) => (
                <Card key={skill.id}>
                  <CardContent className="p-3 flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <div>
                        <p className="font-medium text-sm">{skill.name}</p>
                        <p className="text-xs text-muted-foreground">{skill.description}</p>
                      </div>
                      <Badge variant="outline" size="tag">
                        {skill.type}
                      </Badge>
                      <Badge
                        variant="outline"
                        size="tag"
                        className={`${
                          skill.isActive
                            ? "border-status-success/30 text-status-success"
                            : "border-status-neutral/30 text-status-neutral"
                        }`}
                      >
                        {skill.isActive ? "Active" : "Inactive"}
                      </Badge>
                    </div>
                    <Button
                      variant="destructive-outline"
                      size="sm"
                      onClick={() => uninstallSkill.mutate({ skillId: skill.id, agentId: id! })}
                    >
                      Uninstall
                    </Button>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </TabsContent>

        <TabsContent value="mcp-servers" className="mt-4 overflow-y-auto">
          {agentMcpServersList.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No MCP servers installed for this agent.
            </p>
          ) : (
            <div className="space-y-2">
              {agentMcpServersList.map((server: McpServerWithInstallInfo) => (
                <Card key={server.id}>
                  <CardContent className="p-3 flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <div>
                        <p className="font-medium text-sm">{server.name}</p>
                        <p className="text-xs text-muted-foreground">
                          {server.description || server.transport}
                        </p>
                      </div>
                      <Badge
                        variant="outline"
                        size="tag"
                        className={`${
                          server.transport === "stdio"
                            ? "border-action-default/30 text-action-default"
                            : server.transport === "http"
                              ? "border-action-delegate-to-agent/30 text-action-delegate-to-agent"
                              : "border-action-script/30 text-action-script"
                        }`}
                      >
                        {server.transport}
                      </Badge>
                      <Badge
                        variant="outline"
                        size="tag"
                        className={`${
                          server.isActive
                            ? "border-status-success/30 text-status-success"
                            : "border-status-neutral/30 text-status-neutral"
                        }`}
                      >
                        {server.isActive ? "Active" : "Inactive"}
                      </Badge>
                    </div>
                    <Button
                      variant="destructive-outline"
                      size="sm"
                      onClick={() =>
                        uninstallMcpServer.mutate({ serverId: server.id, agentId: id! })
                      }
                    >
                      Uninstall
                    </Button>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </TabsContent>

        <TabsContent value="usage" className="mt-4">
          <UsageSummary costs={agentCosts ?? []} daysBack={30} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
