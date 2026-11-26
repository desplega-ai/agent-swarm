/**
 * `/apps` — catalog of swarm apps. A Table | Tiles toggle switches between
 * the grid of rows and a Finder-style grid of icon tiles; both link into the
 * runtime at `/apps/:id`. Phones always get the compact list. Every view lists
 * starred apps first. Search, the favorites filter and the view all live in
 * URL query params (`search`, `favorites`, `view`), like `/pages`, so reload
 * and back/forward restore them.
 */

import type { ColDef, RowClickedEvent } from "ag-grid-community";
import { LayoutGrid } from "lucide-react";
import { Fragment, type ReactNode, useCallback, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useApps } from "@/api/hooks/use-apps";
import { useFavoriteToggle } from "@/api/hooks/use-favorites";
import type { AppListItem } from "@/api/types";
import { AppGlyph } from "@/components/apps/app-glyph";
import { DataGrid } from "@/components/shared/data-grid";
import { EmptyState } from "@/components/shared/empty-state";
import { FavoriteButton } from "@/components/shared/favorite-button";
import { FAVORITE_COLUMN } from "@/components/shared/favorite-column";
import { ListFilterBar } from "@/components/shared/list-filter-bar";
import { MobileList, MobileListRow } from "@/components/shared/mobile-list";
import { AlertCallout } from "@/components/ui/alert-callout";
import { PageHeader } from "@/components/ui/page-header";
import { SegmentedControl } from "@/components/ui/segmented-control";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { useIsMobile } from "@/hooks/use-mobile";
import { readBooleanParam, readStringParam, useUrlSearchState } from "@/hooks/use-url-search-state";
import { isRowNavigationSuppressed } from "@/lib/grid-row-click";
import { matchesSearchTerms, searchText } from "@/lib/list-search";
import { cn, formatSmartTime } from "@/lib/utils";

type AppsView = "table" | "tiles";

const VIEW_STORAGE_KEY = "apps.view";

const VIEW_OPTIONS = [
  { value: "table", label: "Table" },
  { value: "tiles", label: "Tiles" },
] as const;

function parseView(value: string | null): AppsView | null {
  return value === "table" || value === "tiles" ? value : null;
}

/** The view a URL without `view` shows: this browser's last choice. Storage can be missing or throw (private mode), so default to the table. */
function readStoredView(): AppsView {
  try {
    return localStorage.getItem(VIEW_STORAGE_KEY) === "tiles" ? "tiles" : "table";
  } catch {
    return "table";
  }
}

function storeView(view: AppsView) {
  try {
    localStorage.setItem(VIEW_STORAGE_KEY, view);
  } catch {
    // The choice just won't survive a reload.
  }
}

export default function AppsListingPage() {
  const navigate = useNavigate();
  const isMobile = useIsMobile();
  const { data, isLoading, error } = useApps();
  const { searchParams, setParam, setParams } = useUrlSearchState();
  const search = readStringParam(searchParams, "search");
  const favoritesOnly = readBooleanParam(searchParams, "favorites");
  const favoriteToggle = useFavoriteToggle("app");
  // Starred first; the sort is stable, so the server order holds within each group.
  const rows = useMemo(
    () => [...(data?.apps ?? [])].sort((a, b) => Number(!!b.favorite) - Number(!!a.favorite)),
    [data],
  );
  // One filter for every view (grid, tiles, phone), so a query finds the same apps at any width.
  const filteredRows = useMemo(
    () =>
      rows.filter(
        (app) =>
          (!favoritesOnly || app.favorite) &&
          matchesSearchTerms(searchText([app.name, app.description]), search),
      ),
    [favoritesOnly, rows, search],
  );
  const hasActiveFilters = search !== "" || favoritesOnly;
  const clearFilters = useCallback(() => {
    setParams({ search: "", favorites: "" }, { replace: false });
  }, [setParams]);
  // Read once per mount: a history entry with no `view` keeps the view it had when it was created.
  const [fallbackView] = useState<AppsView>(readStoredView);
  const view = parseView(searchParams.get("view")) ?? fallbackView;

  const favoriteControl = useCallback(
    (app: AppListItem, className?: string) => (
      <FavoriteButton
        favorite={app.favorite}
        disabled={favoriteToggle.isPending && favoriteToggle.variables?.itemId === app.id}
        onToggle={() => favoriteToggle.mutate({ itemId: app.id, favorite: !app.favorite })}
        className={className}
      />
    ),
    [favoriteToggle],
  );

  // Always written explicitly (never dropped as a default), so every history entry names its view.
  const changeView = useCallback(
    (next: AppsView) => {
      setParam("view", next, { replace: false });
      storeView(next);
    },
    [setParam],
  );

  const columnDefs = useMemo<ColDef<AppListItem>[]>(
    () => [
      {
        ...FAVORITE_COLUMN,
        minWidth: 52,
        maxWidth: 52,
        suppressSizeToFit: true,
        cellRenderer: (params: { data: AppListItem | undefined }) =>
          params.data ? favoriteControl(params.data) : null,
      },
      {
        field: "name",
        headerName: "App",
        flex: 2,
        minWidth: 200,
        cellRenderer: (params: { value: string; data: AppListItem | undefined }) =>
          params.data ? (
            <span className="flex items-center gap-2 min-w-0">
              <AppGlyph icon={params.data.icon} className="size-4 shrink-0 text-muted-foreground" />
              <Link
                to={`/apps/${params.data.id}`}
                className="text-primary hover:underline font-medium truncate"
                onClick={(e) => e.stopPropagation()}
              >
                {params.value}
              </Link>
            </span>
          ) : null,
      },
      {
        field: "description",
        headerName: "Description",
        flex: 3,
        minWidth: 220,
        cellRenderer: (params: { value: string | null | undefined }) => (
          <span className="text-muted-foreground">{params.value || "—"}</span>
        ),
      },
      {
        field: "updatedAt",
        headerName: "Updated",
        width: 160,
        valueFormatter: (params) => (params.value ? formatSmartTime(params.value) : "—"),
      },
    ],
    [favoriteControl],
  );

  const onRowClicked = useCallback(
    (event: RowClickedEvent<AppListItem>) => {
      // The star sits in the row: a click on it must not open the app.
      if (isRowNavigationSuppressed(event.event?.target)) return;
      if (event.data) void navigate(`/apps/${event.data.id}`);
    },
    [navigate],
  );

  const showToggle = !isMobile && !isLoading && !error && rows.length > 0;

  const empty = (
    <EmptyState
      icon={LayoutGrid}
      title="No apps yet"
      description="Agents create apps with the `app-upsert` tool."
      entity="app"
      fullPage
    />
  );

  const isEmpty = !isLoading && !error && rows.length === 0;
  const noMatch = "No apps match the current filters";

  let content: ReactNode;
  if (isEmpty) {
    content = empty;
  } else if (isMobile) {
    content = (
      <MobileList label="Apps" loading={isLoading} emptyMessage={noMatch}>
        {filteredRows.map((app) => (
          <MobileListRow
            key={app.id}
            to={`/apps/${app.id}`}
            title={app.name}
            leading={<AppGlyph icon={app.icon} className="size-5 text-muted-foreground" />}
            meta={[app.description, formatSmartTime(app.updatedAt)]}
            controls={[
              <Fragment key="favorite">{favoriteControl(app, "size-11 [&_svg]:size-5")}</Fragment>,
            ]}
          />
        ))}
      </MobileList>
    );
  } else if (view === "tiles") {
    content = isLoading ? (
      <div className="grid grid-cols-[repeat(auto-fill,minmax(104px,1fr))] gap-3">
        {Array.from({ length: 8 }, (_, index) => (
          // Static placeholders never reorder.
          <div key={index} className="flex flex-col items-center gap-2 p-3">
            <Skeleton className="h-14 w-14 rounded-2xl" />
            <Skeleton className="h-3 w-16" />
          </div>
        ))}
      </div>
    ) : filteredRows.length === 0 ? (
      <p className="py-8 text-center text-sm text-muted-foreground">{noMatch}</p>
    ) : (
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="grid grid-cols-[repeat(auto-fill,minmax(104px,1fr))] gap-3">
          {filteredRows.map((app) => (
            // The star is a sibling of the link, not inside it: a button in an anchor is invalid.
            <div key={app.id} className="group relative">
              <Link
                to={`/apps/${app.id}`}
                title={app.name}
                className="flex flex-col items-center gap-2 rounded-lg p-3 text-center transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
              >
                <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-muted/50 text-muted-foreground group-hover:text-foreground">
                  <AppGlyph
                    icon={app.icon}
                    className="h-7 w-7"
                    imageClassName="h-14 w-14 rounded-2xl"
                  />
                </div>
                <span className="line-clamp-2 text-sm font-medium text-foreground">{app.name}</span>
              </Link>
              {favoriteControl(
                app,
                cn(
                  "absolute right-1 top-1",
                  !app.favorite &&
                    "opacity-0 focus-visible:opacity-100 group-focus-within:opacity-100 group-hover:opacity-100",
                ),
              )}
            </div>
          ))}
        </div>
      </div>
    );
  } else {
    content = (
      <DataGrid
        rowData={filteredRows}
        columnDefs={columnDefs}
        loading={isLoading}
        onRowClicked={onRowClicked}
        emptyMessage={noMatch}
      />
    );
  }

  return (
    <div className="flex flex-col flex-1 min-h-0 gap-4">
      <PageHeader title="Apps" />
      {/* No filter chrome over a first-run empty state: nothing to filter. */}
      {isEmpty || error ? null : (
        // One toolbar row: search and filter on the left, the view toggle on the right.
        // Every control is 36px tall (h-9); items-start keeps the toggle on the first line when the filters wrap.
        <div className="flex shrink-0 flex-wrap items-start gap-3">
          <ListFilterBar
            className="min-w-0 flex-1"
            // A floor on the search width, so a narrow window wraps the controls instead of crushing the field.
            searchClassName="w-full sm:min-w-48 sm:max-w-sm sm:flex-1"
            searchValue={search}
            onSearchChange={(value) => setParam("search", value, { replace: false })}
            searchPlaceholder="Search name or description…"
            hasActiveFilters={hasActiveFilters}
            onClear={clearFilters}
          >
            <Select
              value={favoritesOnly ? "favorites" : "all"}
              onValueChange={(value) =>
                setParam("favorites", value === "favorites" ? "true" : "", { replace: false })
              }
            >
              <SelectTrigger className="w-[150px]">
                <SelectValue placeholder="Favorites" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All apps</SelectItem>
                <SelectItem value="favorites">Favorites only</SelectItem>
              </SelectContent>
            </Select>
          </ListFilterBar>
          {showToggle ? (
            <SegmentedControl
              aria-label="Apps view"
              className="ml-auto"
              value={view}
              onValueChange={changeView}
              options={VIEW_OPTIONS}
            />
          ) : null}
        </div>
      )}
      {error ? (
        <AlertCallout tone="error" icon={LayoutGrid} title="Failed to load apps">
          {error instanceof Error ? error.message : String(error)}
        </AlertCallout>
      ) : null}
      {content}
    </div>
  );
}
