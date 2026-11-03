/**
 * `/apps` — catalog of swarm apps. A Table | Tiles toggle (remembered per
 * browser) switches between the grid of rows and a Finder-style grid of icon
 * tiles; both link into the runtime at `/apps/:id`. Phones always get the
 * compact list.
 */

import type { ColDef, RowClickedEvent } from "ag-grid-community";
import type { LucideIcon } from "lucide-react";
import { LayoutGrid } from "lucide-react";
import { type ReactNode, useCallback, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useApps } from "@/api/hooks/use-apps";
import type { AppIcon, AppListItem } from "@/api/types";
import { DataGrid } from "@/components/shared/data-grid";
import { EmptyState } from "@/components/shared/empty-state";
import { MobileList, MobileListRow } from "@/components/shared/mobile-list";
import { AlertCallout } from "@/components/ui/alert-callout";
import { PageHeader } from "@/components/ui/page-header";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { Skeleton } from "@/components/ui/skeleton";
import { useIsMobile } from "@/hooks/use-mobile";
import { AVATAR_ICON_CATALOG } from "@/lib/agent-icon";
import { formatSmartTime } from "@/lib/utils";

type AppsView = "table" | "tiles";

const VIEW_STORAGE_KEY = "apps.view";

const VIEW_OPTIONS = [
  { value: "table", label: "Table" },
  { value: "tiles", label: "Tiles" },
] as const;

/** Per-viewer convenience: storage can be missing or throw (private mode), so default to the table. */
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

/**
 * Catalog icon wins; a missing or unrecognized name falls back to the generic
 * app icon. The name comes from stored app data, so it is looked up as an own
 * key only, and the color must be a `#RRGGBB` hex before it reaches `style`.
 */
function resolveAppIcon(icon: AppIcon | null | undefined): {
  Icon: LucideIcon;
  color: string | undefined;
} {
  const Icon =
    icon?.type === "lucide" && Object.hasOwn(AVATAR_ICON_CATALOG, icon.icon)
      ? AVATAR_ICON_CATALOG[icon.icon]
      : undefined;
  const color = icon?.color && /^#[0-9a-fA-F]{6}$/.test(icon.color) ? icon.color : undefined;
  return { Icon: Icon ?? LayoutGrid, color: Icon ? color : undefined };
}

function AppGlyph({ icon, className }: { icon: AppIcon | null | undefined; className?: string }) {
  const { Icon, color } = resolveAppIcon(icon);
  return <Icon aria-hidden className={className} style={color ? { color } : undefined} />;
}

export default function AppsListingPage() {
  const navigate = useNavigate();
  const isMobile = useIsMobile();
  const { data, isLoading, error } = useApps();
  const rows = useMemo(() => data?.apps ?? [], [data]);
  const [view, setView] = useState<AppsView>(readStoredView);

  const changeView = useCallback((next: AppsView) => {
    setView(next);
    storeView(next);
  }, []);

  const columnDefs = useMemo<ColDef<AppListItem>[]>(
    () => [
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
    [],
  );

  const onRowClicked = useCallback(
    (event: RowClickedEvent<AppListItem>) => {
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

  let content: ReactNode;
  if (!isLoading && !error && rows.length === 0) {
    content = empty;
  } else if (isMobile) {
    content = (
      <MobileList label="Apps" loading={isLoading} emptyMessage="No apps yet">
        {rows.map((app) => (
          <MobileListRow
            key={app.id}
            to={`/apps/${app.id}`}
            title={app.name}
            leading={<AppGlyph icon={app.icon} className="size-5 text-muted-foreground" />}
            meta={[app.description, formatSmartTime(app.updatedAt)]}
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
    ) : (
      <div className="grid grid-cols-[repeat(auto-fill,minmax(104px,1fr))] gap-3">
        {rows.map((app) => (
          <Link
            key={app.id}
            to={`/apps/${app.id}`}
            title={app.name}
            className="group flex flex-col items-center gap-2 rounded-lg p-3 text-center transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
          >
            <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-muted/50 text-muted-foreground group-hover:text-foreground">
              <AppGlyph icon={app.icon} className="h-7 w-7" />
            </div>
            <span className="line-clamp-2 text-sm font-medium text-foreground">{app.name}</span>
          </Link>
        ))}
      </div>
    );
  } else {
    content = (
      <DataGrid
        rowData={rows}
        columnDefs={columnDefs}
        loading={isLoading}
        onRowClicked={onRowClicked}
        emptyMessage="No apps yet"
      />
    );
  }

  return (
    <div className="flex flex-col flex-1 min-h-0 gap-4">
      <PageHeader
        title="Apps"
        action={
          showToggle ? (
            <SegmentedControl
              aria-label="Apps view"
              size="sm"
              value={view}
              onValueChange={changeView}
              options={VIEW_OPTIONS}
            />
          ) : undefined
        }
      />
      {error ? (
        <AlertCallout tone="error" icon={LayoutGrid} title="Failed to load apps">
          {error instanceof Error ? error.message : String(error)}
        </AlertCallout>
      ) : null}
      {content}
    </div>
  );
}
