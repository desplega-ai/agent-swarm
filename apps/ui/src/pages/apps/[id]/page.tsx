/**
 * `/apps/:id` — the swarm-apps runtime (spike).
 *
 * 1. `GET /api/apps/:id` → the app definition (models + queries + page).
 * 2. Every named query runs via `GET /api/apps/:id/queries/<name>` on the
 *    standard 5s react-query poll, and is mirrored into json-render state at
 *    `/queries/<name>` as `{ data, loading, error }` — which is what the
 *    catalog's `Table` binds to.
 * 3. `definition.page` renders through the shared json-render stack
 *    (`@/lib/json-render`) with two extra actions:
 *      - `app.mutate`  — row CRUD, then refetch every query on that model
 *                        (and clear the originating form on create).
 *      - `app.refresh` — refetch one named query, or all of them.
 */

import { createStateStore, type StateStore } from "@json-render/core";
import {
  ActionProvider,
  defineRegistry,
  Renderer,
  StateProvider,
  VisibilityProvider,
} from "@json-render/react";
import { AlertCircle, LayoutGrid } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api } from "@/api/client";
import { useApp, useAppQueries, useAppQueryRefetch } from "@/api/hooks/use-apps";
import type { AppDetail, AppRow } from "@/api/types";
import { PageSkeleton } from "@/components/shared/page-skeleton";
import { AlertCallout } from "@/components/ui/alert-callout";
import { PageHeader } from "@/components/ui/page-header";
import { createSwarmActionHandlers, swarmCatalog, swarmComponents } from "@/lib/json-render";

const EMPTY_ROWS: AppRow[] = [];

interface QuerySlot {
  data: AppRow[];
  loading: boolean;
  error: string | null;
}

function errorMessage(error: unknown): string | null {
  if (!error) return null;
  return error instanceof Error ? error.message : String(error);
}

function AppRuntime({ app }: { app: AppDetail }) {
  const definition = app.definition;
  const queryNames = useMemo(() => Object.keys(definition.queries ?? {}), [definition.queries]);
  const results = useAppQueries(app.id, queryNames);
  const { refetchModel, refetchQuery } = useAppQueryRefetch(app.id, definition);

  const [actionError, setActionError] = useState<string | null>(null);
  const [lastResponse, setLastResponse] = useState<unknown>(undefined);

  // One json-render store per mounted app. Owned here (rather than letting
  // StateProvider create it) so the polling effect and the action handlers can
  // write into it from outside the provider subtree.
  const storeRef = useRef<StateStore | null>(null);
  if (!storeRef.current) storeRef.current = createStateStore({});
  const store = storeRef.current;

  // Mutable context for the action handlers — `ActionProvider` snapshots its
  // `handlers` prop on mount, so the handlers themselves must be identity
  // stable and read everything fresh through this ref.
  const ctxRef = useRef({ app, refetchModel, refetchQuery, store });
  ctxRef.current = { app, refetchModel, refetchQuery, store };

  // Mirror query results into `/queries/<name>`. Guarded by a per-name
  // snapshot so a poll that returns identical data (react-query keeps the same
  // object reference) does not churn the store.
  const syncedRef = useRef<Record<string, QuerySlot>>({});
  useEffect(() => {
    queryNames.forEach((name, index) => {
      const result = results[index];
      const next: QuerySlot = {
        data: result?.data?.rows ?? EMPTY_ROWS,
        loading: result?.isLoading ?? true,
        error: errorMessage(result?.error),
      };
      const prev = syncedRef.current[name];
      if (
        prev &&
        prev.data === next.data &&
        prev.loading === next.loading &&
        prev.error === next.error
      ) {
        return;
      }
      syncedRef.current[name] = next;
      store.set(`/queries/${name}`, next);
    });
  }, [queryNames, results, store]);

  const compiled = useMemo(() => {
    const swarmActions = createSwarmActionHandlers({
      onResponse: (result) => setLastResponse(result),
      onError: (message) => setActionError(message),
    });
    const { registry, handlers } = defineRegistry(swarmCatalog, {
      components: swarmComponents,
      actions: {
        ...swarmActions,
        "app.mutate": async (params) => {
          setActionError(null);
          if (!params) return;
          const ctx = ctxRef.current;
          try {
            if (params.op === "create") {
              setLastResponse(
                await api.createAppRow(ctx.app.id, params.model, params.values ?? {}),
              );
              // The Form injects its own id, so a successful create resets the
              // fields the user just submitted.
              if (params.formId) ctx.store.set(`/forms/${params.formId}`, {});
            } else if (params.op === "update") {
              if (!params.rowId) throw new Error("app.mutate op=update requires rowId");
              setLastResponse(
                await api.updateAppRow(ctx.app.id, params.model, params.rowId, params.values ?? {}),
              );
            } else {
              if (!params.rowId) throw new Error("app.mutate op=delete requires rowId");
              setLastResponse(await api.deleteAppRow(ctx.app.id, params.model, params.rowId));
            }
            await ctx.refetchModel(params.model);
          } catch (e) {
            setActionError(e instanceof Error ? e.message : String(e));
          }
        },
        "app.refresh": async (params) => {
          setActionError(null);
          try {
            await ctxRef.current.refetchQuery(params?.query);
          } catch (e) {
            setActionError(e instanceof Error ? e.message : String(e));
          }
        },
        // Placeholder registered at contract-freeze time so the catalog
        // compiles; the spike-2 UI slice replaces this with the real
        // POST /api/apps/:id/actions/:name handler (+ /actions/<name> state).
        "app.action": async () => {
          setActionError("app.action is not wired up yet (spike 2 UI slice).");
        },
      },
    });
    return {
      registry,
      handlers: handlers(
        () => () => {
          /* no-op SetState — handlers write through `store` / React state. */
        },
        () => ({}),
      ),
    };
  }, []);

  let renderedSpec: React.ReactNode;
  try {
    renderedSpec = <Renderer spec={definition.page as never} registry={compiled.registry} />;
  } catch (e) {
    renderedSpec = (
      <AlertCallout tone="error" icon={AlertCircle} title="Failed to render app page">
        <p>{e instanceof Error ? e.message : String(e)}</p>
      </AlertCallout>
    );
  }

  return (
    <div className="flex flex-col flex-1 min-h-0 overflow-y-auto gap-4" data-testid="app-runtime">
      <PageHeader
        title={app.name}
        description={app.description ?? undefined}
        action={
          <Link to="/apps" className="text-sm text-muted-foreground hover:underline">
            All apps
          </Link>
        }
      />
      {actionError && (
        <AlertCallout tone="error" icon={AlertCircle} title="Action failed">
          {actionError}
        </AlertCallout>
      )}
      <StateProvider store={store}>
        <VisibilityProvider>
          <ActionProvider handlers={compiled.handlers}>{renderedSpec}</ActionProvider>
        </VisibilityProvider>
      </StateProvider>
      {lastResponse !== undefined && (
        <details className="rounded-md border border-border bg-muted/40 p-3 text-xs">
          <summary className="cursor-pointer text-muted-foreground">Last action response</summary>
          <pre className="mt-2 max-h-48 overflow-auto" data-testid="app-last-action-response">
            {JSON.stringify(lastResponse, null, 2)}
          </pre>
        </details>
      )}
    </div>
  );
}

export default function AppDetailPage() {
  const { id } = useParams<{ id: string }>();
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

  // Keyed so switching apps remounts the runtime with a fresh json-render store.
  return <AppRuntime key={data.app.id} app={data.app} />;
}
