import { ArrowLeft, Check, Pencil, Search, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useAgent, useUpdateAgentName, useUpdateAgentProfile } from "@/api/hooks/use-agents";
import { useSessionCosts } from "@/api/hooks/use-costs";
import { useAgentMcpServers, useUninstallMcpServer } from "@/api/hooks/use-mcp-servers";
import { useAgentSkills, useUninstallSkill } from "@/api/hooks/use-skills";
import { useTasks } from "@/api/hooks/use-tasks";
import type {
  Agent,
  AgentAvatar,
  AgentSkill,
  AgentTask,
  McpServerWithInstallInfo,
} from "@/api/types";
import { AgentActivityGraph } from "@/components/shared/agent-activity-graph";
import { AgentAppearancePicker } from "@/components/shared/agent-appearance-picker";
import { AgentAvatar as AgentAvatarDisc } from "@/components/shared/agent-avatar";
import { AgentRuntimeSettings } from "@/components/shared/agent-runtime-settings";
import { HarnessCell } from "@/components/shared/harness-cell";
import { MobileList, MobileListRow } from "@/components/shared/mobile-list";
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
import { useIsMobile } from "@/hooks/use-mobile";
import { readNumberParam, readStringParam, useUrlSearchState } from "@/hooks/use-url-search-state";
import { taskListTitle } from "@/lib/task-title";
import { cn, formatRelativeTime, formatSmartTime } from "@/lib/utils";
import { CredentialsPanel } from "./credentials-panel";
import { RuntimeInstancesSection } from "./runtime-instances-section";

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

// Seven tabs do not fit a phone: the list scrolls sideways inside itself
// instead of clipping the last tabs or widening the page.
const SCROLLABLE_TABS_LIST =
  "w-full justify-start overflow-x-auto overflow-y-hidden [scrollbar-width:none] [&::-webkit-scrollbar]:hidden sm:w-fit";

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
        <EmptyPanel>No content yet. Click Edit to add it.</EmptyPanel>
      )}
    </div>
  );
}

function EmptyPanel({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-dashed border-border px-4 py-8 text-center">
      <p className="text-sm text-muted-foreground text-pretty">{children}</p>
    </div>
  );
}

/** Skill and MCP server rows: name and badges wrap, the action stays right. */
function InstalledItemRow({
  name,
  description,
  badges,
  action,
}: {
  name: string;
  description?: string | null;
  badges: React.ReactNode;
  action: React.ReactNode;
}) {
  return (
    <Card className="gap-0 py-0">
      <CardContent className="flex items-center gap-3 p-3">
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <p className="font-medium text-sm break-words">{name}</p>
            {badges}
          </div>
          {description ? (
            <p className="text-xs text-muted-foreground line-clamp-2">{description}</p>
          ) : null}
        </div>
        <div className="shrink-0">{action}</div>
      </CardContent>
    </Card>
  );
}

export default function AgentDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const isMobile = useIsMobile();
  const { data: agent, isLoading } = useAgent(id!);
  const updateName = useUpdateAgentName();
  const updateProfile = useUpdateAgentProfile();

  const [editing, setEditing] = useState(false);
  const [editName, setEditName] = useState("");

  const { searchParams, setParam } = useUrlSearchState();
  const tabParam = searchParams.get("tab");
  const activeTab = AGENT_TABS.includes(tabParam as (typeof AGENT_TABS)[number])
    ? (tabParam as string)
    : "profile";
  const setActiveTab = useCallback(
    (value: string) => {
      setParam("tab", value, { defaultValue: "profile" });
    },
    [setParam],
  );

  const docTypeParam = searchParams.get("docType");
  const activeDocType = DOCUMENT_FIELDS.some((d) => d.tab === docTypeParam)
    ? (docTypeParam as string)
    : "soul";
  const setActiveDocType = useCallback(
    (value: string) => {
      setParam("docType", value, { defaultValue: "soul" });
    },
    [setParam],
  );

  // Task tab filters
  const taskSearch = readStringParam(searchParams, "taskSearch");
  const taskStatus = readStringParam(searchParams, "taskStatus", "all");
  const taskPage = readNumberParam(searchParams, "taskPage", 0, { min: 0 });

  const taskFilters = useMemo(() => {
    const f: {
      agentId?: string;
      status?: string;
      search?: string;
      limit: number;
      offset: number;
      includeTotal: true;
    } = {
      agentId: id,
      limit: PAGE_SIZE,
      offset: taskPage * PAGE_SIZE,
      includeTotal: true,
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

  useEffect(() => {
    const lastPage = Math.max(0, taskTotalPages - 1);
    if (taskPage > lastPage) setParam("taskPage", lastPage, { defaultValue: "0" });
  }, [setParam, taskPage, taskTotalPages]);

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

  function saveAvatar(avatar: AgentAvatar | null) {
    if (id) {
      updateProfile.mutate({ id, profile: { avatar } });
    }
  }

  const onTaskClicked = useMemo(
    () =>
      ignoreRowClickFromInteractives<AgentTask>((event) => {
        if (event.data) void navigate(`/tasks/${event.data.id}`);
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

      {/* Name row wraps on a phone: role and status drop under the name
          instead of squeezing it to one word per line. */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 shrink-0">
        {editing ? (
          <div className="flex w-full min-w-0 items-center gap-2 sm:w-auto">
            <AgentAppearancePicker
              avatar={agent.avatar}
              onChange={saveAvatar}
              trigger={
                <button
                  type="button"
                  title="Edit avatar"
                  className="shrink-0 rounded-full ring-offset-2 ring-offset-background transition-shadow hover:ring-2 hover:ring-ring"
                >
                  <AgentAvatarDisc agentId={id} agentName={agent.name} size="md" />
                </button>
              }
            />
            <Input
              value={editName}
              onChange={(e) => setEditName(e.target.value)}
              className="h-10 min-w-0 flex-1 text-xl font-semibold sm:h-11 sm:w-72 sm:flex-none sm:text-2xl"
              onKeyDown={(e) => {
                if (e.key === "Enter") saveName();
                if (e.key === "Escape") setEditing(false);
              }}
              autoFocus
            />
            <Button size="icon" variant="ghost" onClick={saveName} aria-label="Save name">
              <Check className="h-4 w-4" />
            </Button>
            <Button
              size="icon"
              variant="ghost"
              onClick={() => setEditing(false)}
              aria-label="Cancel rename"
            >
              <X className="h-4 w-4" />
            </Button>
          </div>
        ) : (
          <div className="flex min-w-0 items-center gap-2.5">
            <AgentAvatarDisc agentId={id} agentName={agent.name} size="md" />
            <h1 className="min-w-0 break-words text-2xl font-bold tracking-tight text-balance sm:text-3xl">
              {agent.name}
            </h1>
            <Button
              size="icon"
              variant="ghost"
              className="shrink-0"
              onClick={startEditing}
              aria-label="Rename agent"
            >
              <Pencil className="h-4 w-4" />
            </Button>
          </div>
        )}
        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
          {agent.role && (
            <span className="text-sm text-muted-foreground font-medium sm:text-base">
              {agent.role}
            </span>
          )}
          <StatusBadge status={agent.status} size="md" />
        </div>
      </div>

      <Tabs value={activeTab} onValueChange={setActiveTab} className="flex flex-col flex-1 min-h-0">
        <TabsList className={cn("shrink-0", SCROLLABLE_TABS_LIST)}>
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
              <div className="space-y-4">
                <Card className="gap-0 py-0">
                  <CardContent className="p-4">
                    <DefinitionList>
                      {/* An unreported harness rendered a lone "—" right above
                          the Runtime harness picker. */}
                      {agent.harnessProvider && (
                        <InfoRow label="Harness">
                          <HarnessCell
                            harnessProvider={agent.harnessProvider}
                            credStatus={agent.credStatus}
                            claudeTransport={agent.claudeTransport}
                          />
                        </InfoRow>
                      )}
                      <InfoRow label="Runtime">
                        <AgentRuntimeSettings agent={agent} />
                      </InfoRow>
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
                <Card className="gap-0 py-0">
                  <CardContent className="space-y-3 p-4">
                    <h3 className="font-medium text-sm">Task activity</h3>
                    <AgentActivityGraph agentId={agent.id} />
                  </CardContent>
                </Card>
                <RuntimeInstancesSection agent={agent} />
              </div>
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
            <TabsList className={cn("shrink-0", SCROLLABLE_TABS_LIST, "sm:w-full")}>
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
          <div className="flex flex-wrap items-center gap-2 shrink-0 sm:gap-3">
            <div className="relative min-w-0 flex-1 basis-48 sm:max-w-sm">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                placeholder="Search tasks..."
                value={taskSearch}
                onChange={(e) => setParam("taskSearch", e.target.value, { reset: ["taskPage"] })}
                className="pl-9"
              />
            </div>
            <Select
              value={taskStatus}
              onValueChange={(value) =>
                setParam("taskStatus", value, {
                  defaultValue: "all",
                  reset: ["taskPage"],
                })
              }
            >
              <SelectTrigger className="w-[140px] sm:w-[160px]">
                <SelectValue placeholder="Status" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Statuses</SelectItem>
                <SelectItem value="pending">Pending</SelectItem>
                <SelectItem value="in_progress">In Progress</SelectItem>
                <SelectItem value="completed">Completed</SelectItem>
                <SelectItem value="failed">Failed</SelectItem>
                <SelectItem value="cancelled">Cancelled</SelectItem>
                <SelectItem value="superseded">Superseded</SelectItem>
              </SelectContent>
            </Select>
            {isMobile ? null : (
              <div className="ml-auto">
                <TasksColumnsMenu state={taskColumns} />
              </div>
            )}
          </div>

          {/* The grid clips its columns at phone width; the tasks list page
              renders the same rows as cards below md. */}
          {isMobile ? (
            <MobileList
              label="Agent tasks"
              loading={tasksLoading}
              emptyMessage="No tasks for this agent"
              className="min-h-0 overflow-y-auto"
            >
              {(tasksData?.tasks ?? []).map((task) => (
                <MobileListRow
                  key={task.id}
                  to={`/tasks/${task.id}`}
                  live={task.status === "in_progress"}
                  title={taskListTitle(task)}
                  status={<StatusBadge status={task.status} />}
                  meta={[formatRelativeTime(task.createdAt)]}
                />
              ))}
            </MobileList>
          ) : (
            <TasksTable
              rowData={tasksData?.tasks ?? []}
              loading={tasksLoading}
              onRowClicked={onTaskClicked}
              columns={taskColumns}
              emptyMessage="No tasks for this agent"
              pagination={false}
            />
          )}

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
                onClick={() => setParam("taskPage", taskPage - 1, { defaultValue: "0" })}
                aria-label="Previous page"
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
                onClick={() => setParam("taskPage", taskPage + 1, { defaultValue: "0" })}
                aria-label="Next page"
              >
                <ArrowLeft className="h-4 w-4 rotate-180" />
              </Button>
            </div>
          </div>
        </TabsContent>

        <TabsContent value="skills" className="mt-4 overflow-y-auto">
          {agentSkillsList.length === 0 ? (
            <EmptyPanel>No skills installed for this agent.</EmptyPanel>
          ) : (
            <div className="space-y-2">
              {agentSkillsList.map((skill: AgentSkill) => (
                <InstalledItemRow
                  key={skill.id}
                  name={skill.name}
                  description={skill.description}
                  badges={
                    <>
                      <Badge variant="outline" size="tag">
                        {skill.type}
                      </Badge>
                      <Badge
                        variant="outline"
                        size="tag"
                        className={
                          skill.isActive
                            ? "border-status-success/30 text-status-success-strong"
                            : "border-status-neutral/30 text-status-neutral-strong"
                        }
                      >
                        {skill.isActive ? "Active" : "Inactive"}
                      </Badge>
                    </>
                  }
                  action={
                    <Button
                      variant="destructive-outline"
                      size="sm"
                      onClick={() => uninstallSkill.mutate({ skillId: skill.id, agentId: id! })}
                    >
                      Uninstall
                    </Button>
                  }
                />
              ))}
            </div>
          )}
        </TabsContent>

        <TabsContent value="mcp-servers" className="mt-4 overflow-y-auto">
          {agentMcpServersList.length === 0 ? (
            <EmptyPanel>No MCP servers installed for this agent.</EmptyPanel>
          ) : (
            <div className="space-y-2">
              {agentMcpServersList.map((server: McpServerWithInstallInfo) => (
                <InstalledItemRow
                  key={server.id}
                  name={server.name}
                  description={server.description || server.transport}
                  badges={
                    <>
                      <Badge
                        variant="outline"
                        size="tag"
                        className={
                          server.transport === "stdio"
                            ? "border-action-default/30 text-action-default"
                            : server.transport === "http"
                              ? "border-action-delegate-to-agent/30 text-action-delegate-to-agent"
                              : "border-action-script/30 text-action-script"
                        }
                      >
                        {server.transport}
                      </Badge>
                      <Badge
                        variant="outline"
                        size="tag"
                        className={
                          server.isActive
                            ? "border-status-success/30 text-status-success-strong"
                            : "border-status-neutral/30 text-status-neutral-strong"
                        }
                      >
                        {server.isActive ? "Active" : "Inactive"}
                      </Badge>
                    </>
                  }
                  action={
                    <Button
                      variant="destructive-outline"
                      size="sm"
                      onClick={() =>
                        uninstallMcpServer.mutate({ serverId: server.id, agentId: id! })
                      }
                    >
                      Uninstall
                    </Button>
                  }
                />
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
