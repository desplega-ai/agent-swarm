/**
 * Cmd+K search providers: one per entity type, keyed by the ids the route
 * handles name (`route-meta.ts`). The `Record` type makes a new id fail the
 * build until it has a provider here.
 *
 * Every provider searches on the server with a bounded `limit`. The results
 * are matched again on the client, so an older API that ignores `q` still
 * shows only matching rows.
 */
import { useQuery } from "@tanstack/react-query";
import type { LucideIcon } from "lucide-react";
import {
  BookOpen,
  Cable,
  Clock,
  FileSearch,
  FileText,
  Globe,
  LayoutGrid,
  ListTodo,
  Users,
  Workflow,
} from "lucide-react";
import { api } from "@/api/client";
import { useCombSearch } from "@/api/hooks/use-agent-fs";
import type {
  AgentTask,
  AgentWithTasks,
  AppListItem,
  McpServer,
  PageListItem,
  ScheduledTaskSummary,
  Skill,
  WorkflowSummary,
} from "@/api/types";
import { useAgentFs } from "@/contexts/agent-fs-context";
import { combPath } from "@/lib/comb/paths";
import type { SnippetPart } from "@/lib/comb/search";
import { keepPreviousWithin, paletteSearchKey } from "@/lib/command-palette/identity";
import type { PaletteNav, SearchProviderId } from "@/lib/command-palette/route-meta";
import { taskResult } from "@/lib/command-palette/task-result";
import { getConfig } from "@/lib/config";

/** One search hit. */
export interface PaletteResult {
  /** Unique within its provider. */
  id: string;
  title: string;
  /** Muted text at the right of the row (a status, a role). */
  detail?: string;
  /** More text the client-side match reads (a description). */
  keywords?: string[];
  href: string;
  /** A content hit with its matched words (file content search). */
  snippet?: SnippetPart[];
  /** Kept when the client matcher misses it (see `rankResults`). */
  serverMatched?: boolean;
}

export interface ProviderState {
  results: PaletteResult[];
  /** A request for the current query is in flight. */
  loading: boolean;
  error: boolean;
}

export interface SearchProvider {
  /** The group heading. */
  label: string;
  icon: LucideIcon;
  /** The type-filter chip it belongs to. */
  scope: PaletteScopeId;
  /** Same gates as a route: the provider hides with its page. */
  gate?: Pick<PaletteNav, "adminOnly" | "minVersion" | "requires">;
  /** Shortest query it runs. 0: an empty query lists recent items (only when scoped). */
  minQuery: number;
  /** Results are filtered and ranked by the client matcher. False for content hits. */
  clientMatch: boolean;
  useSearch: (query: string, limit: number) => ProviderState;
}

export const PALETTE_SCOPES = [
  { id: "all", label: "All" },
  { id: "tasks", label: "Tasks" },
  { id: "agents", label: "Agents" },
  { id: "workflows", label: "Workflows" },
  { id: "schedules", label: "Schedules" },
  { id: "pages", label: "Pages" },
  { id: "apps", label: "Apps" },
  { id: "files", label: "Files" },
  { id: "skills", label: "Skills" },
  { id: "mcp", label: "MCP" },
] as const;

export type PaletteScopeId = (typeof PALETTE_SCOPES)[number]["id"];

/** How long a search answer stays fresh: reopening the palette reuses it. */
const STALE_MS = 15_000;

/**
 * A provider backed by one API list call. The query key carries the text, so
 * a new keystroke starts a new query; react-query aborts the old one through
 * `signal` once nothing observes it. It also carries the swarm and user
 * (`paletteSearchKey`), so a cached answer never serves another user's search,
 * and the previous answer stands in only for the same user.
 */
function apiSearch<T>(
  id: SearchProviderId,
  fetchRows: (query: string, limit: number, signal: AbortSignal) => Promise<T[]>,
  toResult: (row: T) => PaletteResult,
): SearchProvider["useSearch"] {
  return function useApiSearch(query, limit) {
    const queryKey = paletteSearchKey(getConfig(), id, query, limit);
    const result = useQuery({
      queryKey,
      queryFn: ({ signal }) => fetchRows(query, limit, signal),
      select: (rows) => rows.map(toResult),
      placeholderData: keepPreviousWithin(queryKey[1]),
      staleTime: STALE_MS,
      refetchInterval: false,
      refetchOnWindowFocus: false,
      retry: false,
    });
    // A placeholder answered the previous query: its server match says
    // nothing about this one, so only the client matcher may keep its rows.
    const results = result.isPlaceholderData
      ? (result.data ?? []).map((row) => ({ ...row, serverMatched: false }))
      : (result.data ?? []);
    return {
      results,
      loading: result.isFetching,
      error: result.isError,
    };
  };
}

/** File search through Comb's own hook, on the swarm's shared drive. */
function fileSearch(mode: "name" | "text"): SearchProvider["useSearch"] {
  return function useFileSearch(query, limit) {
    const fs = useAgentFs();
    const drive = { orgId: fs.orgId ?? "", driveId: fs.driveId ?? "" };
    // No drive yet: an empty query keeps `useCombSearch` disabled.
    const result = useCombSearch(drive, mode, drive.orgId && drive.driveId ? query : "");
    return {
      results: (result.data?.hits ?? []).slice(0, limit).map((hit) => ({
        id: hit.path,
        title: hit.name,
        detail: hit.folder,
        href: combPath({ ...drive, path: hit.path }),
        snippet: mode === "text" ? hit.snippet : undefined,
      })),
      loading: result.isFetching,
      error: result.isError,
    };
  };
}

export const SEARCH_PROVIDERS: Record<SearchProviderId, SearchProvider> = {
  tasks: {
    label: "Tasks",
    icon: ListTodo,
    scope: "tasks",
    minQuery: 0,
    clientMatch: true,
    useSearch: apiSearch(
      "tasks",
      async (q, limit, signal) =>
        (
          await api.getList<{ tasks: AgentTask[] }>(
            "/api/tasks",
            { search: q, limit, includeHeartbeat: "true" },
            signal,
          )
        ).tasks,
      taskResult,
    ),
  },
  agents: {
    label: "Agents",
    icon: Users,
    scope: "agents",
    minQuery: 0,
    clientMatch: true,
    useSearch: apiSearch(
      "agents",
      async (q, limit, signal) =>
        (await api.getList<{ agents: AgentWithTasks[] }>("/api/agents", { q, limit }, signal))
          .agents,
      (agent) => ({
        id: agent.id,
        title: agent.name,
        detail: agent.role ?? undefined,
        keywords: [agent.id],
        href: `/agents/${agent.id}`,
      }),
    ),
  },
  workflows: {
    label: "Workflows",
    icon: Workflow,
    scope: "workflows",
    gate: { adminOnly: true },
    minQuery: 0,
    clientMatch: true,
    useSearch: apiSearch(
      "workflows",
      (q, limit, signal) => api.getList<WorkflowSummary[]>("/api/workflows", { q, limit }, signal),
      (workflow) => ({
        id: workflow.id,
        title: workflow.name,
        detail: workflow.enabled ? undefined : "disabled",
        keywords: [workflow.description ?? ""],
        href: `/workflows/${workflow.id}`,
      }),
    ),
  },
  schedules: {
    label: "Schedules",
    icon: Clock,
    scope: "schedules",
    gate: { adminOnly: true },
    minQuery: 0,
    clientMatch: true,
    useSearch: apiSearch(
      "schedules",
      async (q, limit, signal) =>
        (
          await api.getList<{ scheduledTasks: ScheduledTaskSummary[] }>(
            "/api/scheduled-tasks",
            { name: q, limit, fields: "slim" },
            signal,
          )
        ).scheduledTasks,
      (schedule) => ({
        id: schedule.id,
        title: schedule.name,
        detail: schedule.enabled ? schedule.cronExpression : "disabled",
        keywords: [schedule.description ?? ""],
        href: `/schedules/${schedule.id}`,
      }),
    ),
  },
  pages: {
    label: "Pages",
    icon: Globe,
    scope: "pages",
    gate: { minVersion: "1.79.0" },
    minQuery: 0,
    clientMatch: true,
    useSearch: apiSearch(
      "pages",
      async (q, limit, signal) =>
        (await api.getList<{ pages: PageListItem[] }>("/api/pages", { q, limit }, signal)).pages,
      (page) => ({
        id: page.id,
        title: page.title || page.slug,
        detail: page.slug,
        keywords: [page.slug, page.description ?? ""],
        href: `/pages/${page.id}`,
      }),
    ),
  },
  apps: {
    label: "Apps",
    icon: LayoutGrid,
    scope: "apps",
    gate: { adminOnly: true },
    minQuery: 0,
    clientMatch: true,
    useSearch: apiSearch(
      "apps",
      async (q, limit, signal) =>
        (await api.getList<{ apps: AppListItem[] }>("/api/apps", { q, limit }, signal)).apps,
      (app) => ({
        id: app.id,
        title: app.name,
        keywords: [app.description ?? ""],
        href: `/apps/${app.id}`,
      }),
    ),
  },
  "files-name": {
    label: "Files",
    icon: FileText,
    scope: "files",
    gate: { requires: "comb" },
    minQuery: 2,
    clientMatch: false,
    useSearch: fileSearch("name"),
  },
  "files-content": {
    label: "In file contents",
    icon: FileSearch,
    scope: "files",
    gate: { requires: "comb" },
    minQuery: 2,
    clientMatch: false,
    useSearch: fileSearch("text"),
  },
  skills: {
    label: "Skills",
    icon: BookOpen,
    scope: "skills",
    gate: { adminOnly: true },
    minQuery: 1,
    clientMatch: true,
    useSearch: apiSearch(
      "skills",
      async (q, _limit, signal) =>
        // The API caps a skill search at 20 rows.
        (await api.getList<{ skills: Skill[] }>("/api/skills", { search: q }, signal)).skills,
      (skill) => ({
        id: skill.id,
        title: skill.name,
        keywords: [skill.description ?? ""],
        href: `/skills/${skill.id}`,
      }),
    ),
  },
  "mcp-servers": {
    label: "MCP servers",
    icon: Cable,
    scope: "mcp",
    gate: { adminOnly: true },
    minQuery: 1,
    clientMatch: true,
    useSearch: apiSearch(
      "mcp-servers",
      async (q, _limit, signal) =>
        (await api.getList<{ servers: McpServer[] }>("/api/mcp-servers", { search: q }, signal))
          .servers,
      (server) => ({
        id: server.id,
        title: server.name,
        detail: server.transport,
        keywords: [server.description ?? ""],
        href: `/mcp-servers/${server.id}`,
      }),
    ),
  },
};
