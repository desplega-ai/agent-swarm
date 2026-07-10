import type { ColDef, RowClickedEvent } from "ag-grid-community";
import { Eye, Globe, KeyRound, Lock, type LucideIcon } from "lucide-react";
import { useCallback, useMemo } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useAgents } from "@/api/hooks/use-agents";
import { useFavoriteToggle } from "@/api/hooks/use-favorites";
import { useFeatureGate } from "@/api/hooks/use-feature-gate";
import { useAllPages } from "@/api/hooks/use-pages";
import type { PageAuthMode, PageListItem } from "@/api/types";
import { UpgradeRequired } from "@/components/feature-gate/upgrade-required";
import { AgentLink } from "@/components/shared/agent-link";
import { DataGrid } from "@/components/shared/data-grid";
import { EmptyState } from "@/components/shared/empty-state";
import { FavoriteButton } from "@/components/shared/favorite-button";
import { ListFilterBar } from "@/components/shared/list-filter-bar";
import { Badge } from "@/components/ui/badge";
import { PageHeader } from "@/components/ui/page-header";
import { SearchableSelect } from "@/components/ui/searchable-select";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { readBooleanParam, readStringParam, useUrlSearchState } from "@/hooks/use-url-search-state";
import { cn, formatSmartTime } from "@/lib/utils";

/**
 * Color tone per auth mode. `public` is neutral (no gate), `authed` uses
 * the info-blue token, `password` uses the warning-orange token to flag the
 * extra unlock step. Translucent fills + `*-strong` text for legibility on
 * card surfaces — matches the status-token convention from ui/CLAUDE.md.
 */
const authModeClass: Record<PageAuthMode, string> = {
  public: "border-status-neutral/40 bg-status-neutral/10 text-status-neutral-strong",
  authed: "border-status-info/40 bg-status-info/10 text-status-info-strong",
  password: "border-status-warning/40 bg-status-warning/10 text-status-warning-strong",
};

const authModeIcon: Record<PageAuthMode, LucideIcon> = {
  public: Globe,
  authed: Lock,
  password: KeyRound,
};

const AUTH_FILTERS = ["all", "public", "authed", "password"] as const;
const CONTENT_TYPE_FILTERS = ["all", "text/html", "application/json"] as const;

export default function PagesListingPage() {
  const navigate = useNavigate();
  const { searchParams, setParam, setParams } = useUrlSearchState();
  const search = readStringParam(searchParams, "search");
  const authParam = readStringParam(searchParams, "auth", "all");
  const authFilter = AUTH_FILTERS.includes(authParam as (typeof AUTH_FILTERS)[number])
    ? (authParam as (typeof AUTH_FILTERS)[number])
    : "all";
  const contentTypeParam = readStringParam(searchParams, "contentType", "all");
  const contentTypeFilter = CONTENT_TYPE_FILTERS.includes(
    contentTypeParam as (typeof CONTENT_TYPE_FILTERS)[number],
  )
    ? (contentTypeParam as (typeof CONTENT_TYPE_FILTERS)[number])
    : "all";
  const agentFilter = readStringParam(searchParams, "agent", "all");
  const favoritesOnly = readBooleanParam(searchParams, "favorites");
  const gate = useFeatureGate("1.79.0");
  // Pass `enabled: false` indirectly by skipping the data fetch when gated —
  // but we still need all hooks declared unconditionally, so just gate the
  // EARLY-RETURN below; the data hook runs harmlessly on older servers (it
  // will 404, react-query swallows). Cheap, keeps hook order stable.
  const { data, isLoading } = useAllPages();
  const { data: agents } = useAgents();
  const favoriteToggle = useFavoriteToggle("page");
  const agentNameById = useMemo(
    () => new Map((agents ?? []).map((agent) => [agent.id, agent.name])),
    [agents],
  );
  const rows = useMemo<PageListItem[]>(() => {
    return [...(data?.pages ?? [])].sort((a, b) => {
      if (a.favorite !== b.favorite) return a.favorite ? -1 : 1;
      return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
    });
  }, [data]);
  const filteredRows = useMemo(
    () =>
      rows.filter((page) => {
        if (authFilter !== "all" && page.authMode !== authFilter) return false;
        if (contentTypeFilter !== "all" && page.contentType !== contentTypeFilter) return false;
        if (agentFilter !== "all" && page.agentId !== agentFilter) return false;
        if (favoritesOnly && !page.favorite) return false;
        return true;
      }),
    [agentFilter, authFilter, contentTypeFilter, favoritesOnly, rows],
  );

  const columnDefs = useMemo<ColDef<PageListItem>[]>(
    () => [
      {
        headerName: "",
        width: 52,
        sortable: false,
        filter: false,
        getQuickFilterText: () => "",
        cellRenderer: (params: { data: PageListItem | undefined }) => {
          const page = params.data;
          if (!page) return null;
          return (
            <FavoriteButton
              favorite={page.favorite}
              disabled={favoriteToggle.isPending}
              onToggle={() => favoriteToggle.mutate({ itemId: page.id, favorite: !page.favorite })}
            />
          );
        },
      },
      {
        field: "title",
        headerName: "Title",
        flex: 2,
        minWidth: 220,
        cellRenderer: (params: { value: string; data: PageListItem | undefined }) => {
          const page = params.data;
          if (!page) return null;
          return (
            <Link
              to={`/pages/${page.id}`}
              className="text-primary hover:underline font-medium"
              onClick={(e) => e.stopPropagation()}
            >
              {params.value}
            </Link>
          );
        },
      },
      {
        field: "description",
        headerName: "Description",
        flex: 2,
        minWidth: 200,
        cellRenderer: (params: { value: string | undefined }) => (
          <span className="text-muted-foreground">{params.value || "—"}</span>
        ),
      },
      {
        field: "agentId",
        headerName: "Agent",
        width: 160,
        valueGetter: (params) =>
          params.data ? (agentNameById.get(params.data.agentId) ?? params.data.agentId) : "",
        cellRenderer: (params: { data: PageListItem | undefined }) => (
          <div
            className="flex h-full w-full items-center"
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => e.stopPropagation()}
          >
            {params.data ? <AgentLink agentId={params.data.agentId} /> : null}
          </div>
        ),
      },
      {
        field: "authMode",
        headerName: "Auth",
        width: 120,
        getQuickFilterText: () => "",
        cellRenderer: (params: { value: PageAuthMode }) => {
          const Icon = authModeIcon[params.value];
          return (
            <Badge
              variant="outline"
              size="tag"
              className={cn("gap-1", authModeClass[params.value])}
            >
              <Icon className="size-3" />
              {params.value}
            </Badge>
          );
        },
      },
      {
        field: "slug",
        headerName: "Slug",
        width: 160,
        cellRenderer: (params: { value: string }) => (
          <span className="font-mono text-xs text-muted-foreground">{params.value}</span>
        ),
      },
      {
        field: "viewCount",
        headerName: "Views",
        width: 90,
        getQuickFilterText: () => "",
        cellRenderer: (params: { value: number | undefined }) => {
          const count = params.value ?? 0;
          return (
            <span className="inline-flex items-center gap-1 font-mono text-xs text-muted-foreground">
              <Eye className="size-3" />
              {count}
            </span>
          );
        },
      },
      {
        field: "updatedAt",
        headerName: "Updated",
        width: 150,
        getQuickFilterText: () => "",
        valueFormatter: (params) => (params.value ? formatSmartTime(params.value) : ""),
      },
    ],
    [agentNameById, favoriteToggle],
  );

  const onRowClicked = useCallback(
    (event: RowClickedEvent<PageListItem>) => {
      if (event.data) navigate(`/pages/${event.data.id}`);
    },
    [navigate],
  );

  const isEmpty = !isLoading && rows.length === 0;
  const hasActiveFilters =
    search !== "" ||
    authFilter !== "all" ||
    contentTypeFilter !== "all" ||
    agentFilter !== "all" ||
    favoritesOnly;

  const clearFilters = useCallback(() => {
    setParams(
      {
        search: "",
        auth: "all",
        contentType: "all",
        agent: "all",
        favorites: "",
      },
      {
        defaultValues: { auth: "all", contentType: "all", agent: "all" },
        replace: false,
        reset: ["pagesPage"],
      },
    );
  }, [setParams]);

  if (!gate.supported) {
    return (
      <UpgradeRequired
        feature="Pages"
        requiredVersion={gate.requiredVersion}
        currentVersion={gate.currentVersion}
      />
    );
  }

  return (
    <div className="flex flex-col flex-1 min-h-0 gap-4">
      <PageHeader
        title="Pages"
        description="DB-backed static artifacts created by agents via the create_page MCP tool."
      />

      <ListFilterBar
        searchValue={search}
        onSearchChange={(value) =>
          setParam("search", value, { replace: false, reset: ["pagesPage"] })
        }
        searchPlaceholder="Search title, description, slug, or agent…"
        hasActiveFilters={hasActiveFilters}
        onClear={clearFilters}
      >
        <Select
          value={authFilter}
          onValueChange={(value) =>
            setParam("auth", value, {
              defaultValue: "all",
              replace: false,
              reset: ["pagesPage"],
            })
          }
        >
          <SelectTrigger className="w-[140px]">
            <SelectValue placeholder="Auth" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All auth modes</SelectItem>
            <SelectItem value="public">Public</SelectItem>
            <SelectItem value="authed">Authenticated</SelectItem>
            <SelectItem value="password">Password</SelectItem>
          </SelectContent>
        </Select>
        <Select
          value={contentTypeFilter}
          onValueChange={(value) =>
            setParam("contentType", value, {
              defaultValue: "all",
              replace: false,
              reset: ["pagesPage"],
            })
          }
        >
          <SelectTrigger className="w-[160px]">
            <SelectValue placeholder="Content type" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All content types</SelectItem>
            <SelectItem value="text/html">HTML</SelectItem>
            <SelectItem value="application/json">JSON</SelectItem>
          </SelectContent>
        </Select>
        <SearchableSelect
          value={agentFilter}
          onChange={(value) =>
            setParam("agent", value, {
              defaultValue: "all",
              replace: false,
              reset: ["pagesPage"],
            })
          }
          triggerClassName="w-[200px]"
          placeholder="Agent"
          searchPlaceholder="Search agents…"
          options={[
            { value: "all", label: "All agents" },
            ...(agents ?? []).map((agent) => ({ value: agent.id, label: agent.name })),
          ]}
        />
        <Select
          value={favoritesOnly ? "favorites" : "all"}
          onValueChange={(value) =>
            setParam("favorites", value === "favorites" ? "true" : "", {
              replace: false,
              reset: ["pagesPage"],
            })
          }
        >
          <SelectTrigger className="w-[150px]">
            <SelectValue placeholder="Favorites" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All pages</SelectItem>
            <SelectItem value="favorites">Favorites only</SelectItem>
          </SelectContent>
        </Select>
      </ListFilterBar>

      {isEmpty ? (
        <EmptyState
          icon={Globe}
          title="No pages yet"
          description="Pages are created via the create_page MCP tool. See plugin/skills/pages/SKILL.md for the agent contract."
        />
      ) : (
        <DataGrid
          rowData={filteredRows}
          columnDefs={columnDefs}
          quickFilterText={search}
          onRowClicked={onRowClicked}
          loading={isLoading}
          emptyMessage="No pages match the current filters"
          paginationQueryKey="pages"
        />
      )}
    </div>
  );
}
