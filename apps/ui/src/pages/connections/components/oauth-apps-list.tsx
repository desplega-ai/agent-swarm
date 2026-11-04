import type { ColDef, ICellRendererParams } from "ag-grid-community";
import { Trash2 } from "lucide-react";
import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { useDeleteOAuthApp, useOAuthRedirectUri } from "@/api/hooks/use-script-connections";
import type { OAuthAppSummary } from "@/api/types";
import { DataGrid } from "@/components/shared/data-grid";
import { MobileList, MobileListRow } from "@/components/shared/mobile-list";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { useIsMobile } from "@/hooks/use-mobile";
import { matchOAuthApp } from "@/lib/tools-search";
import {
  LegacyCallbackWarning,
  OAuthAppDialog,
  OAuthAuthorizationStatusBadge,
  OAuthSourceBadge,
  toastMutationError,
  worstAuthorizationStatus,
} from "@/pages/connections/page";

function accountsText(app: OAuthAppSummary): string {
  const names = app.authorizations.map((auth) => auth.accountEmail ?? auth.label);
  return names.length === 0 ? "No accounts yet" : names.join(", ");
}

/**
 * The OAuth apps tab: one row per app with its status, scope count and
 * signed-in accounts. `search` filters the rows (provider, client ID, source,
 * account labels and emails). A row opens the app's detail page.
 */
export function OAuthAppsList({
  apps,
  search,
  loading,
}: {
  apps: OAuthAppSummary[];
  search: string;
  loading: boolean;
}) {
  const navigate = useNavigate();
  const isMobile = useIsMobile();
  const [editOpen, setEditOpen] = useState(false);
  const [editApp, setEditApp] = useState<OAuthAppSummary | undefined>();
  const deleteApp = useDeleteOAuthApp();
  // The single static callback every authorization now redirects to. Used to
  // flag apps still registered against the legacy per-provider callback.
  const { data: staticCallback } = useOAuthRedirectUri();
  const rows = useMemo(() => apps.filter((app) => matchOAuthApp(app, search)), [apps, search]);

  const columnDefs = useMemo<ColDef<OAuthAppSummary>[]>(
    () => [
      {
        field: "provider",
        headerName: "App",
        minWidth: 180,
        flex: 1.2,
        cellRenderer: (params: ICellRendererParams<OAuthAppSummary>) =>
          params.data ? (
            <span className="flex min-w-0 items-center gap-2">
              <span className="truncate font-semibold">{params.data.provider}</span>
              <OAuthSourceBadge source={params.data.source} />
              <LegacyCallbackWarning app={params.data} staticCallback={staticCallback} />
            </span>
          ) : null,
      },
      {
        headerName: "Status",
        width: 130,
        valueGetter: (params) => worstAuthorizationStatus(params.data?.authorizations ?? []) ?? "",
        cellRenderer: (params: ICellRendererParams<OAuthAppSummary>) => {
          const worst = worstAuthorizationStatus(params.data?.authorizations ?? []);
          return worst ? (
            <OAuthAuthorizationStatusBadge status={worst} />
          ) : (
            <span className="text-muted-foreground">No accounts</span>
          );
        },
      },
      {
        headerName: "Scopes",
        width: 90,
        valueGetter: (params) => params.data?.scopes.length ?? 0,
        cellClass: "font-mono tabular-nums",
      },
      {
        headerName: "Connected accounts",
        minWidth: 200,
        flex: 1.3,
        valueGetter: (params) => params.data?.authorizations.length ?? 0,
        cellRenderer: (params: ICellRendererParams<OAuthAppSummary>) => {
          const app = params.data;
          if (!app) return null;
          const count = app.authorizations.length;
          return (
            <span className="flex min-w-0 items-center gap-2">
              {count > 0 ? (
                <span className="font-mono font-medium tabular-nums">{count}</span>
              ) : null}
              <span className="truncate text-muted-foreground">{accountsText(app)}</span>
            </span>
          );
        },
      },
      {
        field: "clientId",
        headerName: "Client ID",
        minWidth: 160,
        flex: 1,
        cellRenderer: (params: ICellRendererParams<OAuthAppSummary>) => (
          <span className="block max-w-full truncate font-mono text-xs text-muted-foreground">
            {params.value}
          </span>
        ),
      },
      {
        headerName: "",
        colId: "actions",
        width: 110,
        sortable: false,
        cellRenderer: (params: ICellRendererParams<OAuthAppSummary>) => {
          const app = params.data;
          if (!app) return null;
          return (
            <span
              className="flex items-center gap-1.5"
              onClick={(event) => event.stopPropagation()}
            >
              <Button
                size="xs"
                variant="ghost"
                onClick={() => {
                  setEditApp(app);
                  setEditOpen(true);
                }}
              >
                Edit
              </Button>
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button size="icon-sm" variant="ghost" aria-label={`Delete ${app.provider}`}>
                    <Trash2 className="size-4" />
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>Delete OAuth app?</AlertDialogTitle>
                    <AlertDialogDescription>
                      This deletes the app configuration and all {app.authorizations.length}{" "}
                      authorization(s) for {app.provider}.
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>Cancel</AlertDialogCancel>
                    <AlertDialogAction
                      variant="destructive"
                      onClick={async () => {
                        try {
                          await deleteApp.mutateAsync(app.id);
                          toast.success("OAuth app deleted");
                        } catch (error) {
                          toastMutationError(error);
                        }
                      }}
                      disabled={deleteApp.isPending}
                    >
                      Delete
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            </span>
          );
        },
      },
    ],
    [deleteApp, staticCallback],
  );

  return (
    <div className="flex flex-col flex-1 min-h-0 gap-3">
      {isMobile ? (
        <MobileList
          label="OAuth apps"
          loading={loading}
          emptyMessage={search ? "No OAuth apps match your search" : "No OAuth apps yet"}
        >
          {rows.map((app) => {
            const worst = worstAuthorizationStatus(app.authorizations);
            return (
              <MobileListRow
                key={app.id}
                to={`/integrations/tools/oauth-apps/${encodeURIComponent(app.id)}`}
                title={app.provider}
                status={worst ? <OAuthAuthorizationStatusBadge status={worst} /> : undefined}
                meta={[
                  `${app.scopes.length} ${app.scopes.length === 1 ? "scope" : "scopes"}`,
                  accountsText(app),
                ]}
              />
            );
          })}
        </MobileList>
      ) : (
        <DataGrid
          rowData={rows}
          columnDefs={columnDefs}
          loading={loading}
          emptyMessage={search ? "No OAuth apps match your search" : "No OAuth apps yet"}
          paginationQueryKey="oauthApps"
          onRowClicked={(event) => {
            const target = event.event?.target as HTMLElement | null;
            if (target?.closest("a, button")) return;
            if (event.data) {
              void navigate(`/integrations/tools/oauth-apps/${encodeURIComponent(event.data.id)}`);
            }
          }}
        />
      )}
      <OAuthAppDialog open={editOpen} onOpenChange={setEditOpen} app={editApp} />
    </div>
  );
}
