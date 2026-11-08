import type { ColDef, RowClickedEvent } from "ag-grid-community";
import { Search } from "lucide-react";
import { useCallback, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { usePromptTemplates } from "@/api/hooks/use-prompt-templates";
import type { PromptTemplate } from "@/api/types";
import { DataGrid } from "@/components/shared/data-grid";
import { FilterField, FiltersPopover } from "@/components/shared/filters-popover";
import { MobileList, MobileListRow } from "@/components/shared/mobile-list";
import { SearchBox } from "@/components/shared/search-box";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PageHeader } from "@/components/ui/page-header";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { useIsMobile } from "@/hooks/use-mobile";
import { readBooleanParam, readStringParam, useUrlSearchState } from "@/hooks/use-url-search-state";
import { matchesSearchTerms, searchText } from "@/lib/list-search";
import { formatSmartTime } from "@/lib/utils";

const STATE_VARIANTS: Record<string, "default" | "secondary" | "outline" | "destructive"> = {
  enabled: "default",
  default_prompt_fallback: "secondary",
  skip_event: "outline",
};

/** The "enabled" state is the norm, so a phone row only names the exceptions. */
function stateLabel(state: PromptTemplate["state"]): string {
  return state.replace(/_/g, " ");
}

export default function TemplatesPage() {
  const navigate = useNavigate();
  const isMobile = useIsMobile();
  const { searchParams, setParam } = useUrlSearchState();
  const { data: templates, isLoading, isError } = usePromptTemplates();
  const search = readStringParam(searchParams, "search");
  const scopeFilter = readStringParam(searchParams, "scope", "all");
  const showDefaultsOnly = readBooleanParam(searchParams, "defaults");

  const filteredTemplates = useMemo(() => {
    if (!templates) return [];
    let filtered = [...templates];
    if (scopeFilter !== "all") {
      filtered = filtered.filter((t) => t.scope === scopeFilter);
    }
    if (showDefaultsOnly) {
      filtered = filtered.filter((t) => t.isDefault);
    }
    return filtered;
  }, [templates, scopeFilter, showDefaultsOnly]);

  // One search for both widths, so a phone finds the same templates as the grid.
  const searchedTemplates = useMemo(() => {
    if (!search.trim()) return filteredTemplates;
    return filteredTemplates.filter((t) =>
      matchesSearchTerms(
        searchText([
          t.eventType,
          t.scope,
          t.scopeId,
          stateLabel(t.state),
          t.version,
          t.defaultDrifted ? "drifted" : t.isDefault ? "default" : null,
        ]),
        search,
      ),
    );
  }, [filteredTemplates, search]);
  const activeFilterCount = (scopeFilter !== "all" ? 1 : 0) + (showDefaultsOnly ? 1 : 0);

  const columnDefs = useMemo<ColDef<PromptTemplate>[]>(
    () => [
      { field: "eventType", headerName: "Event Type", flex: 1, minWidth: 200 },
      { field: "scope", headerName: "Scope", width: 100 },
      { field: "scopeId", headerName: "Scope ID", width: 150 },
      {
        field: "state",
        headerName: "State",
        width: 180,
        cellRenderer: (params: { value: PromptTemplate["state"] }) => (
          <Badge variant={STATE_VARIANTS[params.value] ?? "outline"} size="tag">
            {params.value ? stateLabel(params.value) : null}
          </Badge>
        ),
      },
      { field: "version", headerName: "Version", width: 90 },
      {
        field: "isDefault",
        headerName: "Default status",
        width: 140,
        cellRenderer: (params: { data: PromptTemplate | undefined }) =>
          params.data?.defaultDrifted ? (
            <Badge
              variant="outline"
              size="tag"
              className="border-status-warning/30 text-status-warning-strong"
            >
              Drifted
            </Badge>
          ) : params.data?.isDefault ? (
            <Badge variant="secondary" size="tag">
              Default
            </Badge>
          ) : null,
      },
      {
        field: "updatedAt",
        headerName: "Updated",
        width: 150,
        valueFormatter: (params) => (params.value ? formatSmartTime(params.value) : ""),
      },
    ],
    [],
  );

  const onRowClicked = useCallback(
    (event: RowClickedEvent<PromptTemplate>) => {
      if (event.data?.id) void navigate(`/templates/${event.data.id}`);
    },
    [navigate],
  );

  if (isLoading) {
    return (
      <div className="flex flex-col flex-1 min-h-0 gap-4">
        <Skeleton className="h-7 w-48" />
        <div className="flex items-center gap-3">
          <Skeleton className="h-9 w-64" />
          <Skeleton className="h-9 w-[140px]" />
          <Skeleton className="h-8 w-28" />
        </div>
        <Skeleton className="flex-1" />
      </div>
    );
  }

  if (isError) {
    return (
      <div className="flex flex-col flex-1 items-center justify-center gap-2 text-muted-foreground">
        <p>Failed to load templates</p>
        <Button variant="outline" size="sm" onClick={() => window.location.reload()}>
          Retry
        </Button>
      </div>
    );
  }

  return (
    <div className="flex flex-col flex-1 min-h-0 gap-4">
      <PageHeader title="Templates" />

      {isMobile ? (
        // One row on a phone: search, then the facets behind Filters (n).
        <div className="flex items-center gap-2">
          <SearchBox
            value={search}
            onChange={(value) => setParam("search", value, { reset: ["templatesPage"] })}
            placeholder="Search templates…"
            ariaLabel="Search templates"
            className="flex-1"
          />
          <FiltersPopover activeCount={activeFilterCount}>
            <FilterField label="Scope">
              <Select
                value={scopeFilter}
                onValueChange={(value) =>
                  setParam("scope", value, { defaultValue: "all", reset: ["templatesPage"] })
                }
              >
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="All scopes" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Scopes</SelectItem>
                  <SelectItem value="global">Global</SelectItem>
                  <SelectItem value="agent">Agent</SelectItem>
                  <SelectItem value="repo">Repo</SelectItem>
                </SelectContent>
              </Select>
            </FilterField>
            <label className="flex cursor-pointer select-none items-center justify-between gap-2 text-sm">
              Defaults only
              <Switch
                size="sm"
                checked={showDefaultsOnly}
                onCheckedChange={(checked) =>
                  setParam("defaults", checked ? "true" : "", { reset: ["templatesPage"] })
                }
              />
            </label>
          </FiltersPopover>
        </div>
      ) : (
        <div className="flex items-center gap-3">
          <div className="relative flex-1 max-w-sm">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder="Search event types..."
              value={search}
              onChange={(e) => setParam("search", e.target.value, { reset: ["templatesPage"] })}
              className="pl-9"
            />
          </div>
          <Select
            value={scopeFilter}
            onValueChange={(value) =>
              setParam("scope", value, { defaultValue: "all", reset: ["templatesPage"] })
            }
          >
            <SelectTrigger className="w-[140px]">
              <SelectValue placeholder="All scopes" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Scopes</SelectItem>
              <SelectItem value="global">Global</SelectItem>
              <SelectItem value="agent">Agent</SelectItem>
              <SelectItem value="repo">Repo</SelectItem>
            </SelectContent>
          </Select>
          <Button
            variant={showDefaultsOnly ? "default" : "outline"}
            size="sm"
            onClick={() =>
              setParam("defaults", showDefaultsOnly ? "" : "true", { reset: ["templatesPage"] })
            }
          >
            Defaults only
          </Button>
        </div>
      )}

      {isMobile ? (
        <MobileList label="Templates" emptyMessage="No templates found">
          {searchedTemplates.map((t) => (
            <MobileListRow
              key={t.id}
              to={`/templates/${t.id}`}
              title={t.eventType}
              status={
                t.defaultDrifted ? (
                  <Badge
                    variant="outline"
                    size="tag"
                    className="border-status-warning/30 text-status-warning-strong"
                  >
                    Drifted
                  </Badge>
                ) : t.state !== "enabled" ? (
                  <Badge variant={STATE_VARIANTS[t.state] ?? "outline"} size="tag">
                    {stateLabel(t.state)}
                  </Badge>
                ) : null
              }
              meta={[
                t.scopeId ? `${t.scope}: ${t.scopeId}` : t.scope,
                `v${t.version}`,
                t.isDefault && !t.defaultDrifted ? "default" : null,
                t.updatedAt ? formatSmartTime(t.updatedAt) : null,
              ]}
            />
          ))}
        </MobileList>
      ) : (
        <DataGrid
          rowData={searchedTemplates}
          columnDefs={columnDefs}
          onRowClicked={onRowClicked}
          loading={isLoading}
          emptyMessage="No templates found"
          paginationQueryKey="templates"
        />
      )}
    </div>
  );
}
