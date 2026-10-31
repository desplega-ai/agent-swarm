import { Clock, KanbanSquare, Plus, Search, Table2, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useAgents } from "@/api/hooks/use-agents";
import { useFeatureGate } from "@/api/hooks/use-feature-gate";
import { useScheduledTasks } from "@/api/hooks/use-schedules";
import { useTaskTemplates } from "@/api/hooks/use-task-templates";
import { useCreateTask, useTasks } from "@/api/hooks/use-tasks";
import { useUsers } from "@/api/hooks/use-users";
import type { AgentTask } from "@/api/types";
import { FilterField, FiltersPopover } from "@/components/shared/filters-popover";
import { ListPager } from "@/components/shared/list-pager";
import { MobileList, MobileListRow } from "@/components/shared/mobile-list";
import { StatusBadge } from "@/components/shared/status-badge";
import { TasksKanban } from "@/components/shared/tasks-kanban";
import {
  ignoreRowClickFromInteractives,
  TasksColumnsMenu,
  TasksTable,
  useTasksColumns,
} from "@/components/shared/tasks-table";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PageHeader } from "@/components/ui/page-header";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { Switch } from "@/components/ui/switch";
import { useCurrentUser } from "@/contexts/current-user-context";
import { useIsMobile } from "@/hooks/use-mobile";
import { taskListTitle } from "@/lib/task-title";
import { useCan } from "@/lib/use-can";
import { formatRelativeTime } from "@/lib/utils";
import { CreateTaskDialog, type TaskFormData } from "./create-task-dialog";
import { useStalePageCorrection } from "./use-stale-page-correction";

const PAGE_SIZE_OPTIONS = [25, 50, 100, 200] as const;
const DEFAULT_PAGE_SIZE = 100;

export default function TasksPage() {
  // A Viewer lists tasks but cannot create one.
  const mayCreate = useCan("task.create.own");
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();

  // Read all filter state from URL params
  const statusFilter = searchParams.get("status") ?? "all";
  const agentFilter = searchParams.get("agent") ?? "all";
  const scheduleFilter = searchParams.get("schedule") ?? "all";
  const requesterFilter = searchParams.get("requester") ?? "all";
  const searchParam = searchParams.get("search") ?? "";
  const view = searchParams.get("view") === "board" ? "board" : "table";
  const includeHeartbeat = searchParams.get("heartbeat") === "true";
  const page = searchParams.has("page") ? Number(searchParams.get("page")) : 0;
  // Page size is URL-driven so it survives reload / sharing. Falls back to the
  // default if the param is missing or not one of the allowed options.
  const pageSizeParam = Number(searchParams.get("pageSize"));
  const pageSize = (PAGE_SIZE_OPTIONS as readonly number[]).includes(pageSizeParam)
    ? pageSizeParam
    : DEFAULT_PAGE_SIZE;

  // Single setter that updates one key while preserving others
  const setParam = useCallback(
    (key: string, value: string, resetPage = true) => {
      setSearchParams((prev) => {
        const next = new URLSearchParams(prev);
        // Set or delete the key
        const defaultValues: Record<string, string> = {
          status: "all",
          agent: "all",
          schedule: "all",
          requester: "all",
          search: "",
          view: "table",
          page: "0",
          pageSize: String(DEFAULT_PAGE_SIZE),
        };
        if (value === (defaultValues[key] ?? "")) {
          next.delete(key);
        } else {
          next.set(key, value);
        }
        // Reset page when changing filters
        if (resetPage && key !== "page") next.delete("page");
        return next;
      });
    },
    [setSearchParams],
  );

  const { data: agents } = useAgents();
  const { data: schedules } = useScheduledTasks();
  const { data: users } = useUsers();
  const { userId: currentUserId, state: currentUserState } = useCurrentUser();
  const { supported: requesterFacetSupported } = useFeatureGate("1.127.0");
  const agentMapRef = useRef(new Map<string, string>());
  useMemo(() => {
    const m = new Map<string, string>();
    agents?.forEach((a) => {
      m.set(a.id, a.name);
    });
    agentMapRef.current = m;
  }, [agents]);

  // "me" resolves client-side to the current identity's user id before it
  // hits the API — the server only understands an exact user id or the
  // `none` sentinel (IS NULL). If identity isn't ready yet, "me" sends
  // nothing rather than an empty/invalid id.
  const filters = useMemo(() => {
    const f: {
      status?: string;
      agentId?: string;
      scheduleId?: string;
      search?: string;
      includeHeartbeat?: boolean;
      requestedByUserId?: string;
      limit: number;
      offset: number;
      includeTotal: true;
    } = {
      limit: pageSize,
      offset: page * pageSize,
      includeTotal: true,
    };
    if (statusFilter !== "all") f.status = statusFilter;
    if (agentFilter !== "all") f.agentId = agentFilter;
    if (scheduleFilter !== "all") f.scheduleId = scheduleFilter;
    if (searchParam) f.search = searchParam;
    if (includeHeartbeat) f.includeHeartbeat = true;
    if (requesterFilter === "me") {
      if (currentUserId) f.requestedByUserId = currentUserId;
    } else if (requesterFilter !== "all") {
      f.requestedByUserId = requesterFilter;
    }
    return f;
  }, [
    statusFilter,
    agentFilter,
    scheduleFilter,
    requesterFilter,
    currentUserId,
    searchParam,
    includeHeartbeat,
    page,
    pageSize,
  ]);

  const { data: tasksData, isLoading } = useTasks(filters);
  const createTask = useCreateTask();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [dialogInitialValues, setDialogInitialValues] = useState<Partial<TaskFormData> | undefined>(
    undefined,
  );

  // Templates list (Phase 6) — only fetched when a `prefill` param is in the
  // URL, so we don't pay for it on the cold path.
  const prefillId = searchParams.get("prefill");
  const { data: templates } = useTaskTemplates(prefillId ? { kind: "task" } : undefined);

  // Auto-open the create-task dialog when navigated with `?new=true`
  // (used by the home page's "First task" CTA AND the dashboard "To start"
  // inbox bucket via `?new=true&prefill=<template_id>`). Strips both params
  // after firing so refresh / back doesn't re-open.
  useEffect(() => {
    if (searchParams.get("new") === "true") {
      // If a `prefill` param is present and the templates query has resolved,
      // pre-fill the dialog from that template; otherwise open with empty
      // defaults. We wait for templates to land before opening so the user
      // doesn't briefly see an empty form on the prefill path.
      if (prefillId) {
        if (!templates) return;
        const template = templates.find((t) => t.id === prefillId) ?? null;
        if (template) {
          setDialogInitialValues({
            task: template.prompt || template.title,
            taskType: "",
            tags: template.tags.join(", "),
          });
        }
      } else {
        setDialogInitialValues({
          ...(searchParams.get("agentId") ? { agentId: searchParams.get("agentId") ?? "" } : {}),
        });
      }
      setDialogOpen(true);
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          next.delete("new");
          next.delete("prefill");
          next.delete("agentId");
          return next;
        },
        { replace: true },
      );
    }
  }, [searchParams, setSearchParams, prefillId, templates]);

  async function handleCreateSubmit(data: TaskFormData) {
    const tags = data.tags
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);
    await createTask.mutateAsync({
      task: data.task,
      agentId: data.agentId,
      routingReason: data.agentId ? "human_pinned" : undefined,
      ...(data.taskType && { taskType: data.taskType }),
      ...(tags.length > 0 && { tags }),
      ...(data.priority !== 50 && { priority: data.priority }),
      ...(data.dependsOn.length > 0 && { dependsOn: data.dependsOn }),
      ...(data.modelTier && { modelTier: data.modelTier }),
      ...(data.effort && { effort: data.effort }),
      // Phase 3: attribute the task to the current identity. `source` is left
      // unset so the server's "api" default applies.
      ...(currentUserId && { requestedByUserId: currentUserId }),
    });
  }

  const total = tasksData?.total ?? 0;
  const { page: listPage, stale: pageStale } = useStalePageCorrection(
    page,
    pageSize,
    tasksData?.total,
    setSearchParams,
  );
  const hasActiveFilters =
    statusFilter !== "all" ||
    agentFilter !== "all" ||
    scheduleFilter !== "all" ||
    requesterFilter !== "all" ||
    searchParam !== "" ||
    includeHeartbeat ||
    page !== 0;

  // Facets inside the Filters popover; search and page are counted apart.
  const activeFilterCount = [
    statusFilter !== "all",
    agentFilter !== "all",
    scheduleFilter !== "all",
    requesterFilter !== "all",
    includeHeartbeat,
  ].filter(Boolean).length;

  const clearFilters = useCallback(() => {
    setSearchParams(new URLSearchParams());
  }, [setSearchParams]);

  const onRowClicked = useMemo(
    () =>
      ignoreRowClickFromInteractives<AgentTask>((event) => {
        if (event.data) void navigate(`/tasks/${event.data.id}`);
      }),
    [navigate],
  );

  // Source and Effort start hidden so Description gets the width; Columns
  // brings them back. Only applies before the first saved column choice.
  const tasksColumns = useTasksColumns({
    storageKey: "tasks-page",
    defaultHiddenColumns: ["source", "deps", "tags"],
  });
  const isMobile = useIsMobile();

  return (
    <div className="flex flex-col flex-1 min-h-0 gap-4">
      <PageHeader title="Tasks" />

      {/* One toolbar row at 1440px: search, Filters (n), then Columns and
          New task. The four facet selects live in the Filters popover. */}
      <div className="flex items-center gap-2">
        <div className="relative min-w-0 flex-1 sm:max-w-sm">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Search by description or ID..."
            value={searchParam}
            onChange={(e) => setParam("search", e.target.value)}
            className="pl-9"
          />
        </div>
        <FiltersPopover
          activeCount={activeFilterCount}
          footer={
            <div className="flex items-center justify-between gap-2">
              <label className="flex items-center gap-1.5 text-xs text-muted-foreground cursor-pointer select-none">
                <Switch
                  size="sm"
                  checked={includeHeartbeat}
                  onCheckedChange={(checked) => setParam("heartbeat", checked ? "true" : "")}
                />
                Show system
              </label>
              {hasActiveFilters ? (
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-xs text-muted-foreground"
                  onClick={clearFilters}
                >
                  Clear all
                </Button>
              ) : null}
            </div>
          }
        >
          <FilterField label="Status">
            <SearchableSelect
              value={statusFilter}
              onChange={(v) => setParam("status", v)}
              triggerClassName="w-full"
              placeholder="Status"
              options={[
                { value: "all", label: "All Statuses" },
                { value: "pending", label: "Pending" },
                { value: "in_progress", label: "In Progress" },
                { value: "completed", label: "Completed" },
                { value: "failed", label: "Failed" },
                { value: "cancelled", label: "Cancelled" },
                { value: "superseded", label: "Superseded" },
              ]}
            />
          </FilterField>
          <FilterField label="Agent">
            <SearchableSelect
              value={agentFilter}
              onChange={(v) => setParam("agent", v)}
              triggerClassName="w-full"
              placeholder="Agent"
              searchPlaceholder="Search agents…"
              options={[
                { value: "all", label: "All Agents" },
                ...(agents ?? []).map((a) => ({
                  value: a.id,
                  label: a.name,
                  hint: a.isLead ? "lead" : undefined,
                })),
              ]}
            />
          </FilterField>
          <FilterField label="Schedule">
            <SearchableSelect
              value={scheduleFilter}
              onChange={(v) => setParam("schedule", v)}
              triggerClassName="w-full"
              placeholder="Schedule"
              searchPlaceholder="Search schedules…"
              options={[
                { value: "all", label: "All Schedules" },
                ...(schedules ?? []).map((s) => ({
                  value: s.id,
                  label: s.name,
                  icon: <Clock className="h-3 w-3 shrink-0 text-muted-foreground" />,
                })),
              ]}
            />
          </FilterField>
          {requesterFacetSupported && (
            <FilterField label="Requested by">
              <SearchableSelect
                value={requesterFilter}
                onChange={(v) => setParam("requester", v)}
                triggerClassName="w-full"
                placeholder="Requested by"
                searchPlaceholder="Search requesters…"
                options={[
                  { value: "all", label: "All requesters" },
                  ...(currentUserState === "ready" && currentUserId
                    ? [{ value: "me", label: "Me" }]
                    : []),
                  { value: "none", label: "Unattributed" },
                  ...(users ?? []).map((u) => ({
                    value: u.id,
                    label: u.name?.trim() || u.email?.trim() || u.id,
                    hint: u.role,
                  })),
                ]}
              />
            </FilterField>
          )}
        </FiltersPopover>
        {hasActiveFilters && (
          <Button
            variant="ghost"
            size="sm"
            className="hidden text-xs text-muted-foreground sm:inline-flex"
            onClick={clearFilters}
          >
            <X className="h-3 w-3 mr-1" />
            Clear filters
          </Button>
        )}
        <div className="ml-auto flex items-center gap-2">
          {isMobile ? null : (
            <fieldset
              className="m-0 flex items-center rounded-md border p-0"
              aria-label="Tasks view"
            >
              <Button
                variant={view === "table" ? "secondary" : "ghost"}
                size="sm"
                className="rounded-r-none"
                aria-pressed={view === "table"}
                aria-label="Table view"
                onClick={() => setParam("view", "table", false)}
              >
                <Table2 className="h-4 w-4" />
              </Button>
              <Button
                variant={view === "board" ? "secondary" : "ghost"}
                size="sm"
                className="rounded-l-none"
                aria-pressed={view === "board"}
                aria-label="Board view"
                onClick={() => setParam("view", "board", false)}
              >
                <KanbanSquare className="h-4 w-4" />
              </Button>
            </fieldset>
          )}
          {isMobile || view === "board" ? null : <TasksColumnsMenu state={tasksColumns} />}
          {mayCreate ? (
            <Button size="sm" onClick={() => setDialogOpen(true)}>
              <Plus className="h-4 w-4" />
              New task
            </Button>
          ) : null}
        </div>
      </div>

      {isMobile ? (
        <MobileList
          label="Tasks"
          loading={isLoading || pageStale}
          emptyMessage="No tasks match these filters"
        >
          {(tasksData?.tasks ?? []).map((task) => (
            <MobileListRow
              key={task.id}
              to={`/tasks/${task.id}`}
              live={task.status === "in_progress"}
              title={taskListTitle(task)}
              status={<StatusBadge status={task.status} />}
              meta={[
                task.agentId
                  ? (agentMapRef.current.get(task.agentId) ?? "Unknown agent")
                  : "Unassigned",
                formatRelativeTime(task.createdAt),
              ]}
            />
          ))}
        </MobileList>
      ) : view === "board" ? (
        <TasksKanban
          tasks={tasksData?.tasks ?? []}
          loading={isLoading || pageStale}
          agentNameById={agentMapRef.current}
        />
      ) : (
        <TasksTable
          rowData={tasksData?.tasks ?? []}
          loading={isLoading || pageStale}
          onRowClicked={onRowClicked}
          agentNameById={agentMapRef.current}
          columns={tasksColumns}
          // This page does server-side offset pagination — disable AG Grid's
          // own client-side pager so the two don't stack (which capped the view
          // at the server's page size, e.g. 100 rows).
          pagination={false}
        />
      )}

      <ListPager
        page={listPage}
        pageSize={pageSize}
        total={total}
        pageSizeOptions={PAGE_SIZE_OPTIONS}
        onPageChange={(next) => setParam("page", String(next), false)}
        onPageSizeChange={(size) => setParam("pageSize", String(size))}
        emptyLabel="0 tasks"
      />

      <CreateTaskDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        onSubmit={handleCreateSubmit}
        initialValues={dialogInitialValues}
        isPending={createTask.isPending}
      />
    </div>
  );
}
