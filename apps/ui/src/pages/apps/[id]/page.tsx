/**
 * `/apps/:id` (+ `/apps/:id/p/:page`) — the route tier of the swarm-apps
 * runtime. Loads the app definition and hands it to `<AppSurface>`, which owns
 * everything else (queries, state, actions, chrome) and is mountable off this
 * route too — see `@/components/apps/app-surface` for the runtime contract.
 */

import { LayoutGrid } from "lucide-react";
import { useParams, useSearchParams } from "react-router-dom";
import { useApp } from "@/api/hooks/use-apps";
import { AppSurface, errorMessage, viewModeFromParam } from "@/components/apps/app-surface";
import { PageSkeleton } from "@/components/shared/page-skeleton";
import { AlertCallout } from "@/components/ui/alert-callout";
import { PageHeader } from "@/components/ui/page-header";

export default function AppDetailPage() {
  const { id, page } = useParams<{ id: string; page?: string }>();
  const [searchParams] = useSearchParams();
  const mode = viewModeFromParam(searchParams.get("mode"));
  const { data, isLoading, error } = useApp(id);

  if (isLoading) return <PageSkeleton />;

  if (error || !data?.app) {
    return (
      <div className="flex flex-col flex-1 min-h-0 overflow-y-auto gap-4">
        <PageHeader title="App" />
        <AlertCallout tone="error" icon={LayoutGrid} title="Failed to load app">
          {errorMessage(error) ?? `No app found for id ${id}`}
        </AlertCallout>
      </div>
    );
  }

  // Keyed by app id ONLY: switching apps remounts the surface (disposing the
  // previous app's in-flight task watchers), while navigating between pages of
  // the SAME app keeps the polled query data warm. The json-render STATE is no
  // longer tied to this mount at all — it lives in the dashboard-global store
  // and survives leaving the app entirely (cross-app-warm by design).
  return <AppSurface key={data.app.id} app={data.app} mode={mode} pageName={page} />;
}
