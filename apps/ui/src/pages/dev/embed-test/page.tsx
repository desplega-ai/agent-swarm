/**
 * `/dev/embed-test` — dev-only proof that `<AppSurface>` is mountable outside
 * the `/apps/:id` route tier (the "apps render anywhere in the dashboard"
 * directive). Not registered in the production route table.
 *
 * `?app=<appId>` picks the app, `?page=<name>` an explicit page; without
 * `?app` it lists the available apps as links. The surface is deliberately
 * rendered inside ordinary page chrome, alongside unrelated content, so a
 * regression in its layout/route/state assumptions shows up here.
 *
 * It also passes its own `navigate`, which is the other half of the
 * embeddability contract: in-app navigation (`app.navigate`, the page
 * breadcrumb) must be redirectable to the HOST's URL scheme instead of
 * escaping to `/apps/:id`.
 *
 * Note that the app's own route params live in this page's query string
 * alongside `?app`/`?page` — so a `$param` query resolves here exactly as it
 * would on the apps route.
 */

import { useCallback } from "react";
import type { NavigateOptions, To } from "react-router-dom";
import { useSearchParams } from "react-router-dom";
import { useApp, useApps } from "@/api/hooks/use-apps";
import { AppSurface } from "@/components/apps/app-surface";
import { PageSkeleton } from "@/components/shared/page-skeleton";
import { AlertCallout } from "@/components/ui/alert-callout";
import { PageHeader } from "@/components/ui/page-header";

/** `/apps/<id>` and `/apps/<id>/p/<page>` — everything the runtime pushes. */
const APP_PATH = /^\/apps\/([^/]+)(?:\/p\/([^/]+))?$/;

function EmbeddedApp({
  appId,
  pageName,
  navigate,
}: {
  appId: string;
  pageName?: string;
  navigate: (to: To | number, options?: NavigateOptions) => void;
}) {
  const { data, isLoading, error } = useApp(appId);

  if (isLoading) return <PageSkeleton />;
  if (error || !data?.app) {
    return (
      <AlertCallout tone="error" title="Failed to load app">
        {error instanceof Error ? error.message : `No app found for id ${appId}`}
      </AlertCallout>
    );
  }
  // Same keying rule as the route page: swapping apps in place must dispose
  // the previous app's task watchers.
  return <AppSurface key={data.app.id} app={data.app} pageName={pageName} navigate={navigate} />;
}

function AppPicker() {
  const { data, isLoading } = useApps();
  if (isLoading) return <PageSkeleton />;
  const apps = data?.apps ?? [];
  return (
    <div className="flex flex-col gap-2 text-sm">
      <p className="text-muted-foreground">
        Add <code>?app=&lt;appId&gt;</code> (optionally <code>&amp;page=&lt;name&gt;</code>) to
        embed an app on this non-apps page.
      </p>
      <ul className="flex flex-col gap-1">
        {apps.map((app) => (
          <li key={app.id}>
            <a className="underline" href={`/dev/embed-test?app=${encodeURIComponent(app.id)}`}>
              {app.name}
            </a>{" "}
            <span className="text-muted-foreground text-xs">{app.id}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export default function DevEmbedTestPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const appId = searchParams.get("app");
  const pageName = searchParams.get("page") ?? undefined;

  // The host's own `navigate`: the runtime still pushes `/apps/<id>/p/<page>`
  // paths, and this translates them into this page's `?app`/`?page` (+ the
  // app's route params) so in-app navigation never leaves the embed.
  const navigate = useCallback(
    (to: To | number, options?: NavigateOptions) => {
      // The runtime only ever pushes string paths; deltas/`To` objects would
      // be a host-level concern, so they are ignored rather than guessed at.
      if (typeof to !== "string") return;
      const url = new URL(to, window.location.origin);
      const match = APP_PATH.exec(url.pathname);
      if (!match) return;
      const next = new URLSearchParams(url.search);
      next.set("app", decodeURIComponent(match[1] as string));
      if (match[2]) next.set("page", decodeURIComponent(match[2]));
      else next.delete("page");
      setSearchParams(next, { replace: options?.replace });
    },
    [setSearchParams],
  );

  return (
    <div className="flex flex-col flex-1 min-h-0 gap-4">
      <PageHeader
        title="Embed test (dev)"
        description="An AppSurface mounted outside the /apps route tier."
      />
      {appId ? (
        <EmbeddedApp appId={appId} pageName={pageName} navigate={navigate} />
      ) : (
        <AppPicker />
      )}
    </div>
  );
}
