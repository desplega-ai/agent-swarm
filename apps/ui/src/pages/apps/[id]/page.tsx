/**
 * `/apps/:id` — the swarm-apps runtime (spike).
 *
 * 1. `GET /api/apps/:id` → the app definition (models + queries + actions + page).
 * 2. Every named query runs via `GET /api/apps/:id/queries/<name>` on the
 *    standard 5s react-query poll, and is mirrored into json-render state at
 *    `/queries/<name>` as `{ data, loading, error }` — which is what the
 *    catalog's `Table` binds to.
 * 3. `definition.page` renders through the shared json-render stack
 *    (`@/lib/json-render`) with three extra actions:
 *      - `app.mutate`  — row CRUD, then refetch every query on that model
 *                        (and clear the originating form on create).
 *      - `app.refresh` — refetch one named query, or all of them.
 *      - `app.action`  — invoke a named custom action
 *                        (`POST /api/apps/:id/actions/<name>`), mirroring
 *                        `{ status, result?, error?, taskId?, taskStatus? }`
 *                        into state at `/actions/<name>`. Task-backed actions
 *                        keep polling `GET /api/tasks/<taskId>` until the task
 *                        reaches a terminal status.
 *
 * View modes (query string, mirrors the pages/:id `?mode=full` pattern):
 *   - default      → normal SPA chrome (PageHeader + action cluster).
 *   - ?mode=full   → full-viewport overlay with a slim header.
 *   - ?mode=chromeless → the rendered page only (embed surface, no header).
 */

import { createStateStore, type StateStore } from "@json-render/core";
import {
  ActionProvider,
  defineRegistry,
  Renderer,
  StateProvider,
  VisibilityProvider,
} from "@json-render/react";
import {
  AlertCircle,
  Check,
  Copy,
  LayoutGrid,
  Maximize2,
  Minimize2,
  RefreshCw,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { api } from "@/api/client";
import { useApp, useAppQueries, useAppQueryRefetch, useAppRefresh } from "@/api/hooks/use-apps";
import type { AgentTaskStatus, AppDetail, AppRow } from "@/api/types";
import { PageSkeleton } from "@/components/shared/page-skeleton";
import { AlertCallout } from "@/components/ui/alert-callout";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/ui/page-header";
import { useCopyToClipboard } from "@/hooks/use-copy-to-clipboard";
import { createSwarmActionHandlers, swarmCatalog, swarmComponents } from "@/lib/json-render";
import { cn } from "@/lib/utils";

const EMPTY_ROWS: AppRow[] = [];

/** Task-backed actions are watched on the same 5s cadence as the app queries. */
const TASK_POLL_MS = 5000;

const TERMINAL_TASK_STATUSES: ReadonlySet<AgentTaskStatus> = new Set<AgentTaskStatus>([
  "completed",
  "failed",
  "cancelled",
  "superseded",
]);

type ViewMode = "default" | "full" | "chromeless";

function viewModeFromParam(mode: string | null): ViewMode {
  if (mode === "full") return "full";
  if (mode === "chromeless") return "chromeless";
  return "default";
}

interface QuerySlot {
  data: AppRow[];
  loading: boolean;
  error: string | null;
}

/**
 * State written at `/actions/<name>` by the `app.action` handler — the shape
 * app JSON binds to (`{ "$state": "/actions/<name>/status" }`).
 */
interface ActionSlot {
  status: "running" | "ok" | "error";
  result?: unknown;
  error?: string;
  taskId?: string;
  taskStatus?: AgentTaskStatus;
}

/** Cancellable timers owned by the runtime; cleared on unmount. */
interface PollRegistry {
  disposed: boolean;
  timers: Set<ReturnType<typeof setTimeout>>;
}

interface RuntimeCtx {
  app: AppDetail;
  refetchModel: (model: string) => Promise<void>;
  refetchQuery: (queryName?: string) => Promise<void>;
  store: StateStore;
  poll: PollRegistry;
}

function errorMessage(error: unknown): string | null {
  if (!error) return null;
  return error instanceof Error ? error.message : String(error);
}

/** Resolves `true` after `ms`, or `false` if the runtime unmounted first. */
function waitUnlessDisposed(poll: PollRegistry, ms: number): Promise<boolean> {
  if (poll.disposed) return Promise.resolve(false);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      poll.timers.delete(timer);
      resolve(!poll.disposed);
    }, ms);
    poll.timers.add(timer);
  });
}

/**
 * Watch a task-backed `app.action` until the task reaches a terminal status,
 * mirroring every observed status into `/actions/<name>/taskStatus`. On a
 * completed task all named queries are refetched — the task most likely wrote
 * rows the page is displaying.
 *
 * Runs detached from the invoking action handler, so it never rejects: any
 * non-transient failure is surfaced through `onError` (and, while the slot is
 * still `running`, mirrored into `/actions/<name>`) instead of escaping as an
 * unhandled rejection that would leave the app stuck on "running".
 */
async function pollActionTask(
  ctxRef: React.RefObject<RuntimeCtx>,
  name: string,
  taskId: string,
  onError: (message: string) => void,
): Promise<void> {
  const path = `/actions/${name}`;
  try {
    for (;;) {
      if (!(await waitUnlessDisposed(ctxRef.current.poll, TASK_POLL_MS))) return;
      const ctx = ctxRef.current;
      let status: AgentTaskStatus;
      try {
        status = (await api.fetchTask(taskId)).status;
      } catch {
        // Transient fetch failure — keep watching rather than declaring the
        // action failed (the task itself is still running server-side).
        continue;
      }
      if (ctx.poll.disposed) return;

      // A newer invocation of the same action supersedes this watcher.
      const current = ctx.store.get(path) as ActionSlot | undefined;
      if (current?.taskId !== taskId) return;

      if (!TERMINAL_TASK_STATUSES.has(status)) {
        ctx.store.set(path, { status: "running", taskId, taskStatus: status } satisfies ActionSlot);
        continue;
      }

      const ok = status === "completed";
      ctx.store.set(path, {
        status: ok ? "ok" : "error",
        taskId,
        taskStatus: status,
        ...(ok ? {} : { error: `task ${status}` }),
      } satisfies ActionSlot);
      if (ok) {
        await ctx.refetchQuery();
      } else {
        // Surface the terminal failure in the runtime's error callout too —
        // not every app page binds `/actions/<name>/error`.
        onError(`task ${status}`);
      }
      return;
    }
  } catch (e) {
    const ctx = ctxRef.current;
    if (ctx.poll.disposed) return;
    const message = e instanceof Error ? e.message : String(e);
    // Only claim the slot while it is still this watcher's running slot — a
    // terminal state already written above (or a newer invocation) wins.
    const current = ctx.store.get(path) as ActionSlot | undefined;
    if (current?.taskId === taskId && current.status === "running") {
      ctx.store.set(path, {
        status: "error",
        taskId,
        ...(current.taskStatus ? { taskStatus: current.taskStatus } : {}),
        error: message,
      } satisfies ActionSlot);
    }
    onError(message);
  }
}

function AppRuntime({ app, mode }: { app: AppDetail; mode: ViewMode }) {
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

  // Timers owned by in-flight task watchers, cancelled on unmount.
  const pollRef = useRef<PollRegistry>({ disposed: false, timers: new Set() });
  useEffect(() => {
    const poll = pollRef.current;
    poll.disposed = false;
    return () => {
      poll.disposed = true;
      for (const timer of poll.timers) clearTimeout(timer);
      poll.timers.clear();
    };
  }, []);

  // Mutable context for the action handlers — `ActionProvider` snapshots its
  // `handlers` prop on mount, so the handlers themselves must be identity
  // stable and read everything fresh through this ref.
  const ctxRef = useRef<RuntimeCtx>({
    app,
    refetchModel,
    refetchQuery,
    store,
    poll: pollRef.current,
  });
  ctxRef.current = { app, refetchModel, refetchQuery, store, poll: pollRef.current };

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
        // Custom actions declared in `definition.actions`. Script-backed
        // actions answer inline; task-backed actions hand back a taskId that
        // `pollActionTask` then watches.
        "app.action": async (params) => {
          setActionError(null);
          const name = params?.name;
          if (!name) {
            setActionError("app.action requires a `name`");
            return;
          }
          const ctx = ctxRef.current;
          const path = `/actions/${name}`;
          ctx.store.set(path, { status: "running" } satisfies ActionSlot);
          try {
            const response = await api.invokeAppAction(ctx.app.id, name, params?.input);
            setLastResponse(response);

            if (response.taskId) {
              ctx.store.set(path, {
                status: "running",
                taskId: response.taskId,
                taskStatus: response.status,
              } satisfies ActionSlot);
              void pollActionTask(ctxRef, name, response.taskId, setActionError);
              return;
            }

            if (response.ok) {
              ctx.store.set(path, {
                status: "ok",
                result: response.result,
              } satisfies ActionSlot);
              // A script action can touch any model — refetch everything.
              await ctx.refetchQuery();
              return;
            }

            const message = response.error ?? `action ${name} failed`;
            ctx.store.set(path, {
              status: "error",
              error: message,
              result: response.result,
            } satisfies ActionSlot);
            setActionError(message);
          } catch (e) {
            const message = e instanceof Error ? e.message : String(e);
            ctx.store.set(path, { status: "error", error: message } satisfies ActionSlot);
            setActionError(message);
          }
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

  const surface = (
    <>
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
    </>
  );

  // Embed surface: the rendered page and nothing else — no SPA chrome, no
  // header, no debug drawer. Covers the layout so an iframe gets the full
  // viewport.
  if (mode === "chromeless") {
    return (
      <div
        className="fixed inset-0 z-50 flex flex-col gap-4 overflow-y-auto bg-background p-4"
        data-testid="app-runtime"
      >
        {surface}
      </div>
    );
  }

  // Full: same overlay, plus a slim identity/exit bar (mirrors pages/:id).
  if (mode === "full") {
    return (
      <div className="fixed inset-0 z-50 flex flex-col bg-background" data-testid="app-runtime">
        <div className="flex items-center justify-between gap-3 border-b border-border bg-card px-4 py-2">
          <div className="flex items-center gap-2 min-w-0">
            <LayoutGrid className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="truncate text-sm font-medium">{app.name}</span>
          </div>
          <Button asChild variant="outline" size="sm">
            <Link to={`/apps/${app.id}`}>
              <Minimize2 className="size-3.5" />
              Exit full
            </Link>
          </Button>
        </div>
        <div className="flex flex-col flex-1 min-h-0 gap-4 overflow-y-auto p-4">{surface}</div>
      </div>
    );
  }

  return (
    <div className="flex flex-col flex-1 min-h-0 overflow-y-auto gap-4" data-testid="app-runtime">
      <PageHeader
        title={app.name}
        description={app.description ?? undefined}
        action={<AppHeaderActions app={app} />}
      />
      {surface}
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

/**
 * Header action cluster, mirroring `pages/:id`'s: maximize within the SPA,
 * copy the chromeless (embeddable) URL, and force a definition + query
 * refresh without waiting for the 30s definition poll.
 */
function AppHeaderActions({ app }: { app: AppDetail }) {
  const refresh = useAppRefresh(app.id);
  const { copied, copy } = useCopyToClipboard();
  const [refreshing, setRefreshing] = useState(false);

  const handleRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await refresh();
    } finally {
      setRefreshing(false);
    }
  }, [refresh]);

  const chromelessUrl = `${window.location.origin}/apps/${app.id}?mode=chromeless`;

  return (
    <div className="flex items-center gap-2">
      <Link to="/apps" className="text-sm text-muted-foreground hover:underline">
        All apps
      </Link>
      <Button asChild variant="outline" size="sm" title="Maximize within the dashboard">
        <Link to={`/apps/${app.id}?mode=full`}>
          <Maximize2 className="size-3.5" />
          Open full
        </Link>
      </Button>
      <Button
        variant="outline"
        size="sm"
        title="Copy a header-less URL for embedding this app"
        onClick={() => copy(chromelessUrl)}
      >
        {copied ? (
          <Check className="size-3.5 text-status-success-strong" />
        ) : (
          <Copy className="size-3.5" />
        )}
        {copied ? "Copied" : "Copy chromeless link"}
      </Button>
      <Button
        variant="outline"
        size="sm"
        title="Re-read the app definition and re-run every query"
        disabled={refreshing}
        onClick={handleRefresh}
      >
        <RefreshCw className={cn("size-3.5", refreshing && "animate-spin")} />
        Refresh
      </Button>
    </div>
  );
}

export default function AppDetailPage() {
  const { id } = useParams<{ id: string }>();
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

  // Keyed so switching apps remounts the runtime with a fresh json-render store.
  return <AppRuntime key={data.app.id} app={data.app} mode={mode} />;
}
