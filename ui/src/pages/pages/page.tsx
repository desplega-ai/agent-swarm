import type { ColDef, RowClickedEvent } from "ag-grid-community";
import { Globe } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { usePages } from "@/api/hooks/use-pages";
import type { PageAuthMode, PageListItem } from "@/api/types";
import { AgentLink } from "@/components/shared/agent-link";
import { DataGrid } from "@/components/shared/data-grid";
import { EmptyState } from "@/components/shared/empty-state";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { PageHeader } from "@/components/ui/page-header";
import { Switch } from "@/components/ui/switch";
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

export default function PagesListingPage() {
  const navigate = useNavigate();
  const [myOnly, setMyOnly] = useState(false);
  // v1: "My pages only" is a client-side filter — we'd need the active user's
  // agentId from a status endpoint to wire it through to the server query, and
  // that plumbing doesn't exist yet. Local filtering is good enough for the
  // listing while we land the spine.
  const { data, isLoading } = usePages();

  const rows = useMemo<PageListItem[]>(() => {
    const all = data?.pages ?? [];
    // Placeholder: with no current-user agentId available, "My pages only"
    // currently hides everything. Surfaces the toggle for future wiring.
    return myOnly ? [] : all;
  }, [data, myOnly]);

  const columnDefs = useMemo<ColDef<PageListItem>[]>(
    () => [
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
              to={`/artifacts/${page.id}`}
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
        cellRenderer: (params: { value: string }) => (
          <AgentLink agentId={params.value} onClick={(e) => e.stopPropagation()} />
        ),
      },
      {
        field: "authMode",
        headerName: "Auth",
        width: 110,
        cellRenderer: (params: { value: PageAuthMode }) => (
          <Badge variant="outline" size="tag" className={cn(authModeClass[params.value])}>
            {params.value}
          </Badge>
        ),
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
        field: "updatedAt",
        headerName: "Updated",
        width: 150,
        valueFormatter: (params) => (params.value ? formatSmartTime(params.value) : ""),
      },
    ],
    [],
  );

  const onRowClicked = useCallback(
    (event: RowClickedEvent<PageListItem>) => {
      if (event.data) navigate(`/artifacts/${event.data.id}`);
    },
    [navigate],
  );

  const isEmpty = !isLoading && rows.length === 0;

  return (
    <div className="flex flex-col flex-1 min-h-0 gap-4">
      <PageHeader
        title="Pages"
        description="DB-backed static artifacts created by agents via the create_page MCP tool."
      />

      <div className="flex items-center gap-3">
        <div className="flex items-center gap-2">
          <Switch id="my-pages-only" checked={myOnly} onCheckedChange={setMyOnly} />
          <Label htmlFor="my-pages-only" className="text-sm text-muted-foreground">
            My pages only
          </Label>
        </div>
      </div>

      {isEmpty ? (
        <EmptyState
          icon={Globe}
          title="No pages yet"
          description="Pages are created via the create_page MCP tool. See plugin/skills/pages/SKILL.md for the agent contract."
        />
      ) : (
        <DataGrid
          rowData={rows}
          columnDefs={columnDefs}
          onRowClicked={onRowClicked}
          loading={isLoading}
          emptyMessage="No pages found"
        />
      )}
    </div>
  );
}
