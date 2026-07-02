import { type QueryClient, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api } from "../client";
import type { AgentTask, AgentTaskSource, AgentTaskStatus, TaskWithLogs } from "../types";

export interface TaskFilters {
  status?: string;
  agentId?: string;
  scheduleId?: string;
  search?: string;
  includeHeartbeat?: boolean;
  limit?: number;
  offset?: number;
  /** Phase 2 (≥1.76.0): ISO 8601 timestamp; backend filters createdAt >= value. */
  createdAfter?: string;
  /** Filter to tasks whose `source` is in this list. Empty/undefined → all. */
  source?: string[];
}

export function useTasks(filters?: TaskFilters) {
  return useQuery({
    queryKey: ["tasks", filters],
    queryFn: () => api.fetchTasks(filters),
    select: (data) => ({ tasks: data.tasks, total: data.total }),
  });
}

export function useTask(id: string, opts?: { refetchInterval?: number | false }) {
  return useQuery({
    queryKey: ["task", id],
    queryFn: () => api.fetchTask(id),
    enabled: !!id,
    // Only set `refetchInterval` when a caller explicitly opts in. Passing
    // `refetchInterval: undefined` here would clobber the QueryClient's global
    // 10s default (object-spread merge keeps the present-but-undefined key),
    // freezing task status/output until window refocus. Omitting the key lets
    // the default apply, while an explicit `false`/number still overrides.
    ...(opts?.refetchInterval !== undefined ? { refetchInterval: opts.refetchInterval } : {}),
  });
}

export function useTaskSessionLogs(taskId: string) {
  return useQuery({
    queryKey: ["task", taskId, "session-logs"],
    queryFn: () => api.fetchTaskSessionLogs(taskId),
    enabled: !!taskId,
    refetchInterval: 5000,
  });
}

export function useTaskContext(taskId: string) {
  return useQuery({
    queryKey: ["task", taskId, "context"],
    queryFn: () => api.fetchTaskContext(taskId),
    enabled: !!taskId,
    refetchInterval: 10000,
  });
}

interface CreateTaskInput {
  task: string;
  agentId?: string;
  taskType?: string;
  tags?: string[];
  priority?: number;
  dependsOn?: string[];
  /** Phase 3 (≥1.76.0): parent task for grouped/parallel sub-tasks. */
  parentTaskId?: string;
  /** Phase 3 (≥1.76.0): override the wire `source` ("api"|"mcp"|"slack"). */
  source?: string;
  /** Phase 3 (≥1.76.0): identity of the requesting user. */
  requestedByUserId?: string;
  /** Phase 3 (≥1.76.0): cross-ingress conversation/thread context key. */
  contextKey?: string;
  model?: string;
  modelTier?: string;
  effort?: string;
}

interface TasksCache {
  tasks: AgentTask[];
  total: number;
}

interface TaskMutationContext {
  snapshots: Array<{ key: ReadonlyArray<unknown>; previous: unknown }>;
}

function matchesTaskFilters(task: AgentTask, filters?: TaskFilters): boolean {
  if (!filters) return true;
  if (filters.status && task.status !== filters.status) return false;
  if (filters.agentId && task.agentId !== filters.agentId) return false;
  if (filters.scheduleId && task.scheduleId !== filters.scheduleId) return false;
  if (filters.createdAfter && task.createdAt < filters.createdAfter) return false;
  if (filters.source && filters.source.length > 0 && !filters.source.includes(task.source)) {
    return false;
  }
  if (filters.search) {
    const needle = filters.search.toLowerCase();
    const haystack = [
      task.id,
      task.task,
      task.status,
      task.agentId,
      task.taskType,
      task.output,
      task.progress,
      ...(task.tags ?? []),
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    if (!haystack.includes(needle)) return false;
  }
  return true;
}

function sortTasksByUpdatedAt(tasks: AgentTask[]): AgentTask[] {
  return [...tasks].sort(
    (a, b) => new Date(b.lastUpdatedAt).getTime() - new Date(a.lastUpdatedAt).getTime(),
  );
}

function applyTaskToTaskLists(queryClient: QueryClient, task: AgentTask) {
  const matches = queryClient.getQueriesData<TasksCache>({ queryKey: ["tasks"] });
  for (const [key] of matches) {
    const filters = (key as ReadonlyArray<unknown>)[1] as TaskFilters | undefined;
    queryClient.setQueryData<TasksCache>(key, (prev) => {
      if (!prev) return prev;
      const previousIndex = prev.tasks.findIndex((row) => row.id === task.id);
      const existed = previousIndex >= 0;
      const nextRows = existed
        ? prev.tasks.map((row) => (row.id === task.id ? task : row))
        : prev.tasks;
      const filteredRows = nextRows.filter((row) => matchesTaskFilters(row, filters));
      const shouldAdd = !existed && matchesTaskFilters(task, filters);
      const rows = shouldAdd ? [task, ...filteredRows] : filteredRows;
      const limitedRows = filters?.limit ? rows.slice(0, filters.limit) : rows;
      const total =
        prev.total +
        (shouldAdd ? 1 : 0) -
        (existed && filteredRows.length < nextRows.length ? 1 : 0);
      return { tasks: sortTasksByUpdatedAt(limitedRows), total: Math.max(0, total) };
    });
  }
}

function applyTaskDetail(queryClient: QueryClient, task: AgentTask) {
  queryClient.setQueryData<TaskWithLogs>(["task", task.id], (prev) =>
    prev ? { ...prev, ...task } : prev,
  );
}

function replaceTaskInLists(queryClient: QueryClient, optimisticId: string, task: AgentTask) {
  const matches = queryClient.getQueriesData<TasksCache>({ queryKey: ["tasks"] });
  for (const [key] of matches) {
    const filters = (key as ReadonlyArray<unknown>)[1] as TaskFilters | undefined;
    queryClient.setQueryData<TasksCache>(key, (prev) => {
      if (!prev) return prev;
      const withoutOptimistic = prev.tasks.filter(
        (row) => row.id !== optimisticId && row.id !== task.id,
      );
      const shouldAdd = matchesTaskFilters(task, filters);
      const rows = shouldAdd ? [task, ...withoutOptimistic] : withoutOptimistic;
      const limitedRows = filters?.limit ? rows.slice(0, filters.limit) : rows;
      return { tasks: sortTasksByUpdatedAt(limitedRows), total: prev.total };
    });
  }
}

function snapshotTaskQueries(queryClient: QueryClient, taskId?: string): TaskMutationContext {
  const snapshots: TaskMutationContext["snapshots"] = queryClient
    .getQueriesData<TasksCache>({ queryKey: ["tasks"] })
    .map(([key, previous]) => ({ key, previous }));
  if (taskId) {
    snapshots.push({ key: ["task", taskId], previous: queryClient.getQueryData(["task", taskId]) });
  }
  return { snapshots };
}

function rollbackTaskQueries(queryClient: QueryClient, context?: TaskMutationContext) {
  if (!context) return;
  for (const { key, previous } of context.snapshots) {
    queryClient.setQueryData(key, previous);
  }
}

function optimisticCreatedTask(input: CreateTaskInput): TaskWithLogs {
  const now = new Date().toISOString();
  return {
    id: `optimistic:${crypto.randomUUID()}`,
    agentId: input.agentId ?? null,
    task: input.task,
    status: input.agentId ? "pending" : "unassigned",
    source: (input.source as AgentTaskSource | undefined) ?? "ui",
    taskType: input.taskType,
    tags: input.tags ?? [],
    priority: input.priority ?? 50,
    dependsOn: input.dependsOn ?? [],
    createdAt: now,
    lastUpdatedAt: now,
    model: input.model,
    modelTier: input.modelTier as TaskWithLogs["modelTier"],
    effort: input.effort as TaskWithLogs["effort"],
    parentTaskId: input.parentTaskId,
    requestedByUserId: input.requestedByUserId,
    contextKey: input.contextKey,
    logs: [],
    attachments: [],
  };
}

function patchTaskStatus(task: AgentTask, status: AgentTaskStatus): AgentTask {
  const now = new Date().toISOString();
  return {
    ...task,
    status,
    lastUpdatedAt: now,
    ...(status === "cancelled" ? { finishedAt: now } : {}),
  };
}

export function useCreateTask() {
  const queryClient = useQueryClient();
  return useMutation<
    TaskWithLogs,
    Error,
    CreateTaskInput,
    TaskMutationContext & { optimisticId: string }
  >({
    mutationFn: (data) => api.createTask(data),
    onMutate: async (input) => {
      await queryClient.cancelQueries({ queryKey: ["tasks"] });
      const optimistic = optimisticCreatedTask(input);
      const context = snapshotTaskQueries(queryClient);
      applyTaskToTaskLists(queryClient, optimistic);
      return { ...context, optimisticId: optimistic.id };
    },
    onError: (err, _input, context) => {
      rollbackTaskQueries(queryClient, context);
      toast.error(err.message || "Failed to create task");
    },
    onSuccess: (task, _input, context) => {
      replaceTaskInLists(queryClient, context.optimisticId, task);
      queryClient.setQueryData(["task", task.id], task);
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ["tasks"] });
    },
  });
}

export function useCancelTask() {
  const queryClient = useQueryClient();
  return useMutation<
    { success: boolean; task: TaskWithLogs },
    Error,
    { id: string; reason?: string },
    TaskMutationContext
  >({
    mutationFn: ({ id, reason }: { id: string; reason?: string }) => api.cancelTask(id, reason),
    onMutate: async ({ id }) => {
      await Promise.all([
        queryClient.cancelQueries({ queryKey: ["tasks"] }),
        queryClient.cancelQueries({ queryKey: ["task", id] }),
      ]);
      const context = snapshotTaskQueries(queryClient, id);
      const cachedTask = queryClient.getQueryData<TaskWithLogs>(["task", id]);
      if (cachedTask) {
        const optimistic = patchTaskStatus(cachedTask, "cancelled");
        applyTaskToTaskLists(queryClient, optimistic);
        applyTaskDetail(queryClient, optimistic);
      } else {
        for (const [, cache] of queryClient.getQueriesData<TasksCache>({ queryKey: ["tasks"] })) {
          const row = cache?.tasks.find((task) => task.id === id);
          if (row) applyTaskToTaskLists(queryClient, patchTaskStatus(row, "cancelled"));
        }
      }
      return context;
    },
    onError: (err, _input, context) => {
      rollbackTaskQueries(queryClient, context);
      toast.error(err.message || "Failed to cancel task");
    },
    onSuccess: ({ task }) => {
      applyTaskToTaskLists(queryClient, task);
      queryClient.setQueryData(["task", task.id], task);
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ["tasks"] });
      queryClient.invalidateQueries({ queryKey: ["task"] });
      queryClient.invalidateQueries({ queryKey: ["stats"] });
    },
  });
}

export function usePauseTask() {
  const queryClient = useQueryClient();
  return useMutation<{ success: boolean; task: TaskWithLogs }, Error, string, TaskMutationContext>({
    mutationFn: (id: string) => api.pauseTask(id),
    onMutate: async (id) => {
      await Promise.all([
        queryClient.cancelQueries({ queryKey: ["tasks"] }),
        queryClient.cancelQueries({ queryKey: ["task", id] }),
      ]);
      const context = snapshotTaskQueries(queryClient, id);
      const cachedTask = queryClient.getQueryData<TaskWithLogs>(["task", id]);
      if (cachedTask) {
        const optimistic = patchTaskStatus(cachedTask, "paused");
        applyTaskToTaskLists(queryClient, optimistic);
        applyTaskDetail(queryClient, optimistic);
      } else {
        for (const [, cache] of queryClient.getQueriesData<TasksCache>({ queryKey: ["tasks"] })) {
          const row = cache?.tasks.find((task) => task.id === id);
          if (row) applyTaskToTaskLists(queryClient, patchTaskStatus(row, "paused"));
        }
      }
      return context;
    },
    onError: (err, _input, context) => {
      rollbackTaskQueries(queryClient, context);
      toast.error(err.message || "Failed to pause task");
    },
    onSuccess: ({ task }) => {
      applyTaskToTaskLists(queryClient, task);
      queryClient.setQueryData(["task", task.id], task);
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ["tasks"] });
      queryClient.invalidateQueries({ queryKey: ["task"] });
    },
  });
}

export function useResumeTask() {
  const queryClient = useQueryClient();
  return useMutation<{ success: boolean; task: TaskWithLogs }, Error, string, TaskMutationContext>({
    mutationFn: (id: string) => api.resumeTask(id),
    onMutate: async (id) => {
      await Promise.all([
        queryClient.cancelQueries({ queryKey: ["tasks"] }),
        queryClient.cancelQueries({ queryKey: ["task", id] }),
      ]);
      const context = snapshotTaskQueries(queryClient, id);
      const cachedTask = queryClient.getQueryData<TaskWithLogs>(["task", id]);
      if (cachedTask) {
        const optimistic = patchTaskStatus(cachedTask, "in_progress");
        applyTaskToTaskLists(queryClient, optimistic);
        applyTaskDetail(queryClient, optimistic);
      } else {
        for (const [, cache] of queryClient.getQueriesData<TasksCache>({ queryKey: ["tasks"] })) {
          const row = cache?.tasks.find((task) => task.id === id);
          if (row) applyTaskToTaskLists(queryClient, patchTaskStatus(row, "in_progress"));
        }
      }
      return context;
    },
    onError: (err, _input, context) => {
      rollbackTaskQueries(queryClient, context);
      toast.error(err.message || "Failed to resume task");
    },
    onSuccess: ({ task }) => {
      applyTaskToTaskLists(queryClient, task);
      queryClient.setQueryData(["task", task.id], task);
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ["tasks"] });
      queryClient.invalidateQueries({ queryKey: ["task"] });
    },
  });
}
