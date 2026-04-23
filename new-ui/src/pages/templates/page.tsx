import type { ColDef, RowClickedEvent } from "ag-grid-community";
import { Search } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { usePromptTemplates } from "@/api/hooks/use-prompt-templates";
import type { PromptTemplate } from "@/api/types";
import { DataGrid } from "@/components/shared/data-grid";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { formatSmartTime } from "@/lib/utils";

const STATE_VARIANTS: Record<string, "default" | "secondary" | "outline" | "destructive"> = {
  enabled: "default",
  default_prompt_fallback: "secondary",
  skip_event: "outline",
};

export default function TemplatesPage() {
  const navigate = useNavigate();
  const { data: templates, isLoading, isError } = usePromptTemplates();
  const [search, setSearch] = useState("");
  const [scopeFilter, setScopeFilter] = useState("all");
  const [showDefaultsOnly, setShowDefaultsOnly] = useState(false);

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
            {params.value?.replace(/_/g, " ")}
          </Badge>
        ),
      },
      { field: "version", headerName: "Version", width: 90 },
      {
        field: "isDefault",
        headerName: "Default",
        width: 100,
        cellRenderer: (params: { value: boolean }) =>
          params.value ? (
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
      if (event.data?.id) navigate(`/templates/${event.data.id}`);
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
      <h1 className="text-xl font-semibold">Templates</h1>

      <div className="flex items-center gap-3">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Search event types..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-9"
          />
        </div>
        <Select value={scopeFilter} onValueChange={setScopeFilter}>
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
          onClick={() => setShowDefaultsOnly(!showDefaultsOnly)}
        >
          Defaults only
        </Button>
      </div>

      <DataGrid
        rowData={filteredTemplates}
        columnDefs={columnDefs}
        quickFilterText={search}
        onRowClicked={onRowClicked}
        loading={isLoading}
        emptyMessage="No templates found"
      />
    </div>
  );
}
