/**
 * `/apps/:id` (+ `/apps/:id/p/:page`) — the swarm-apps runtime (spike).
 *
 * 1. `GET /api/apps/:id` → the app definition (models + queries + actions +
 *    pages).
 * 2. Every named query runs via `GET /api/apps/:id/queries/<name>` on the
 *    standard 5s react-query poll, and is mirrored into json-render state at
 *    `/queries/<name>` as `{ data, loading, error }` — which is what the
 *    catalog's `Table` binds to. A query with `{ "$param": … }` filters is run
 *    with the current route params (and parked, with an explicit error in its
 *    slot, while any of them is missing from the URL).
 * 3. The active page of `definition.pages` renders through the shared
 *    json-render stack (`@/lib/json-render`) with four extra actions:
 *      - `app.mutate`  — row CRUD, then refetch every query on that model
 *                        (and clear the originating form on create).
 *      - `app.refresh` — refetch one named query, or all of them.
 *      - `app.action`  — invoke a named custom action
 *                        (`POST /api/apps/:id/actions/<name>`), mirroring
 *                        `{ status, result?, error?, taskId?, taskStatus? }`
 *                        into state at `/actions/<name>`. Task-backed actions
 *                        keep polling `GET /api/tasks/<taskId>` until the task
 *                        reaches a terminal status.
 *      - `app.navigate`— push `/apps/:id/p/<page>?<params>` (params REPLACE the
 *                        current ones; only `?mode` survives).
 *
 * Router tier: `/apps/:id` renders `defaultPage`, `/apps/:id/p/<name>` renders
 * that page — both URLs are valid and neither redirects. The route is mirrored
 * into state at `/route` as `{ page, params }` (declared params only, coerced
 * to their declared kind) so bindings, `visible` conditions and the `Drawer`
 * can read it. The runtime stays keyed by `app.id` alone, so navigating
 * between pages keeps the store and the polled query data warm.
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
  ChevronRight,
  Copy,
  LayoutGrid,
  Maximize2,
  Minimize2,
  RefreshCw,
} from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  Link,
  type NavigateFunction,
  useLocation,
  useNavigate,
  useParams,
  useSearchParams,
} from "react-router-dom";
import { api } from "@/api/client";
import type { AppQueryPlan } from "@/api/hooks/use-apps";
import { useApp, useAppQueries, useAppQueryRefetch, useAppRefresh } from "@/api/hooks/use-apps";
import type { AgentTaskStatus, AppDefinition, AppDetail, AppPageDef, AppRow } from "@/api/types";
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
  /** Router push, read live: `ActionProvider` snapshots handlers at mount. */
  navigate: NavigateFunction;
  /** Raw `?mode=` value — the only search param `app.navigate` carries over. */
  modeParam: string | null;
}

/** The route mirrored into json-render state at `/route`. */
interface RouteSlot {
  page: string;
  params: Record<string, string | number | boolean>;
}

/**
 * A named query plus how the runtime should run it right now. `missing` names
 * the route params a `$param` query is waiting on — non-empty means the query
 * is parked (`enabled: false`) and its state slot carries that as an error.
 */
interface QueryPlan extends AppQueryPlan {
  missing: string[];
}

// ─── Pages map ──────────────────────────────────────────────────────────────

/**
 * The canonical `{ pages, defaultPage }` view of a definition.
 *
 * The server normalizes the legacy single `page` into `pages: { main: … }` on
 * every write and at read time, but the client tolerates the legacy shape too
 * (an older API, or a definition still sitting in the react-query cache) —
 * neither shape may crash the runtime.
 */
function normalizeAppPages(definition: AppDefinition): {
  pages: Record<string, AppPageDef>;
  defaultPage: string;
} {
  const pages = definition.pages;
  if (pages && Object.keys(pages).length > 0) {
    const names = Object.keys(pages);
    const declared = definition.defaultPage;
    return {
      pages,
      defaultPage: declared && pages[declared] ? declared : (names[0] as string),
    };
  }
  return { pages: {}, defaultPage: "" };
}

/**
 * URL strings → the param's declared kind. Coercion is what makes
 * `visible: { "$state": "/route/params/x", "eq": 2 }` work: the renderer
 * compares with `===`, and a URL only ever yields strings. A value that does
 * not parse stays the raw string rather than becoming `NaN` / a silent `false`.
 */
function coerceRouteParam(
  raw: string,
  kind: "string" | "number" | "boolean" | undefined,
): string | number | boolean {
  if (kind === "number") {
    const parsed = Number(raw);
    return raw.trim() !== "" && !Number.isNaN(parsed) ? parsed : raw;
  }
  if (kind === "boolean") {
    if (raw === "true" || raw === "1") return true;
    if (raw === "false" || raw === "0") return false;
    return raw;
  }
  return raw;
}

/** Declared params of the active page, read out of the query string. */
function readRouteParams(
  page: AppPageDef | undefined,
  searchParams: URLSearchParams,
): Record<string, string | number | boolean> {
  // Null prototype: param names come from user JSON, and an inherited key
  // ("constructor") must read back `undefined`, not a function.
  const params: Record<string, string | number | boolean> = Object.create(null);
  for (const [name, def] of Object.entries(page?.params ?? {})) {
    const raw = searchParams.get(name);
    if (raw === null || raw === "") continue;
    params[name] = coerceRouteParam(raw, def?.kind);
  }
  return params;
}

/** `{ "$param": "<name>" }` filter names of one named query, in filter order. */
function queryParamNames(definition: AppDefinition, queryName: string): string[] {
  const filter = definition.queries?.[queryName]?.filter ?? {};
  const names: string[] = [];
  for (const value of Object.values(filter)) {
    if (
      typeof value === "object" &&
      value !== null &&
      "$param" in value &&
      typeof value.$param === "string"
    ) {
      names.push(value.$param);
    }
  }
  return names;
}

/** `app.navigate` target. Only `?mode` survives; params replace wholesale. */
function appPagePath(
  appId: string,
  page: string,
  params: Record<string, unknown> | undefined,
  modeParam: string | null,
): string {
  const search = new URLSearchParams();
  if (modeParam) search.set("mode", modeParam);
  for (const [name, value] of Object.entries(params ?? {})) {
    if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") {
      continue;
    }
    if (value === "") continue;
    search.set(name, String(value));
  }
  const query = search.toString();
  return `/apps/${encodeURIComponent(appId)}/p/${encodeURIComponent(page)}${
    query ? `?${query}` : ""
  }`;
}

/**
 * The current URL with `?mode` set (or dropped) — so "Open full" / the
 * chromeless embed link / "Exit full" all stay on the page the viewer is on
 * instead of bouncing back to `defaultPage`.
 */
function urlWithMode(
  location: { pathname: string; search: string },
  mode: "full" | "chromeless" | null,
): string {
  const search = new URLSearchParams(location.search);
  if (mode) search.set("mode", mode);
  else search.delete("mode");
  const query = search.toString();
  return `${location.pathname}${query ? `?${query}` : ""}`;
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

function AppRuntime({
  app,
  mode,
  pageName,
}: {
  app: AppDetail;
  mode: ViewMode;
  pageName: string | undefined;
}) {
  const definition = app.definition;
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams] = useSearchParams();

  // ── Route → active page + declared params ────────────────────────────────
  const { pages, defaultPage } = useMemo(() => normalizeAppPages(definition), [definition]);
  const activePageName = pageName ?? defaultPage;
  // Own-property lookup: page names come from the URL, and `pages["constructor"]`
  // must be "unknown page", not Object.prototype's.
  const activePage = Object.hasOwn(pages, activePageName) ? pages[activePageName] : undefined;
  const routeParams = useMemo(
    () => readRouteParams(activePage, searchParams),
    [activePage, searchParams],
  );
  // Signature, not identity: `searchParams` is a fresh object every location
  // change, so the mirror below would otherwise churn the store on every render.
  const routeSignature = JSON.stringify({ page: activePageName, params: routeParams });

  // The json-render spec of the active page — `title` / `params` are runtime
  // metadata, not part of it. Every element gets `props` normalized to `{}`:
  // the bundled renderer's `resolveBindings` calls `Object.entries(props)`
  // without a null guard, so one propless container (a bare
  // `{"type":"Stack","children":[…]}` — a shape the validator accepts and
  // agents naturally write) would crash the whole page. Memoized so the
  // `Renderer` keeps hitting its own spec-identity memo across the 5s poll
  // re-renders.
  const activeSpec = useMemo(() => {
    if (!activePage) return null;
    const elements = Object.fromEntries(
      Object.entries(activePage.elements).map(([id, element]) => {
        const el = element as Record<string, unknown>;
        return [id, el.props === undefined || el.props === null ? { ...el, props: {} } : el];
      }),
    );
    return { root: activePage.root, elements };
  }, [activePage]);

  // Named queries, each with the route params its `$param` filters need. A
  // query missing one is parked (not executed) and gets an explicit error slot.
  const queryPlans = useMemo<QueryPlan[]>(() => {
    return Object.keys(definition.queries ?? {}).map((name) => {
      const paramNames = queryParamNames(definition, name);
      if (paramNames.length === 0) return { name, missing: [] };
      const missing = paramNames.filter((param) => routeParams[param] === undefined);
      if (missing.length > 0) return { name, enabled: false, missing };
      const params: Record<string, string | number | boolean> = {};
      for (const param of paramNames) {
        params[param] = routeParams[param] as string | number | boolean;
      }
      return { name, params, missing: [] };
    });
  }, [definition, routeParams]);

  const results = useAppQueries(app.id, queryPlans);
  const { refetchModel, refetchQuery } = useAppQueryRefetch(app.id, definition);

  const [actionError, setActionError] = useState<string | null>(null);
  const [lastResponse, setLastResponse] = useState<unknown>(undefined);

  // One json-render store per mounted app. Owned here (rather than letting
  // StateProvider create it) so the polling effect and the action handlers can
  // write into it from outside the provider subtree. Seeded with the initial
  // `/route` so a deep-linked page renders its route-driven bits (a Drawer, a
  // `visible` condition) on the FIRST paint rather than a frame later.
  const storeRef = useRef<StateStore | null>(null);
  if (!storeRef.current) {
    storeRef.current = createStateStore({
      route: { page: activePageName, params: routeParams } satisfies RouteSlot,
    });
  }
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
  const modeParam = searchParams.get("mode");
  const ctxRef = useRef<RuntimeCtx>({
    app,
    refetchModel,
    refetchQuery,
    store,
    poll: pollRef.current,
    navigate,
    modeParam,
  });
  ctxRef.current = {
    app,
    refetchModel,
    refetchQuery,
    store,
    poll: pollRef.current,
    navigate,
    modeParam,
  };

  // Mirror the route into `/route`. Same shape as the query mirror below: a
  // signature guard keeps an unchanged URL from churning the store, and the
  // ref carries the live slot so the effect needs no unstable deps. Seeded
  // with the mount signature — the store already holds that value.
  const routeSlotRef = useRef<RouteSlot>({ page: activePageName, params: routeParams });
  routeSlotRef.current = { page: activePageName, params: routeParams };
  const routeSyncedRef = useRef(routeSignature);
  // Layout effect, not passive: a client-side navigation must land in the
  // store before paint, or the first frame of the new page renders against the
  // PREVIOUS page's `/route` (store seeding only covers the initial mount).
  useLayoutEffect(() => {
    if (routeSyncedRef.current === routeSignature) return;
    routeSyncedRef.current = routeSignature;
    store.set("/route", routeSlotRef.current);
  }, [routeSignature, store]);

  // Page switches start at the top — no `ScrollRestoration` is mounted in this
  // SPA, and the runtime's own wrapper is the scroll container.
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const scrolledPageRef = useRef(activePageName);
  useEffect(() => {
    if (scrolledPageRef.current === activePageName) return;
    scrolledPageRef.current = activePageName;
    scrollRef.current?.scrollTo({ top: 0 });
  }, [activePageName]);

  // Mirror query results into `/queries/<name>`. Guarded by a per-name
  // snapshot so a poll that returns identical data (react-query keeps the same
  // object reference) does not churn the store.
  const syncedRef = useRef<Record<string, QuerySlot>>({});
  useEffect(() => {
    queryPlans.forEach((plan, index) => {
      const result = results[index];
      // A `$param` query whose params aren't all in the route never ran —
      // say so in the slot instead of leaving it on a permanent spinner. The
      // previous rows are RETAINED (not blanked) so content driven by the
      // param — a closing Drawer mid slide-out — doesn't flash empty; a fresh
      // deep link has no previous rows and still shows the empty state.
      const next: QuerySlot = plan.missing.length
        ? {
            data: syncedRef.current[plan.name]?.data ?? EMPTY_ROWS,
            loading: false,
            error: `missing route param(s): ${plan.missing.join(", ")}`,
          }
        : {
            data: result?.data?.rows ?? EMPTY_ROWS,
            loading: result?.isLoading ?? true,
            error: errorMessage(result?.error),
          };
      const prev = syncedRef.current[plan.name];
      if (
        prev &&
        prev.data === next.data &&
        prev.loading === next.loading &&
        prev.error === next.error
      ) {
        return;
      }
      syncedRef.current[plan.name] = next;
      store.set(`/queries/${plan.name}`, next);
    });
  }, [queryPlans, results, store]);

  const compiled = useMemo(() => {
    const swarmActions = createSwarmActionHandlers({
      onResponse: (result) => setLastResponse(result),
      onError: (message) => setActionError(message),
    });
    const { registry, handlers } = defineRegistry(swarmCatalog, {
      components: swarmComponents,
      actions: {
        ...swarmActions,
        // Client-side navigation to another page of this app. Reads the
        // router through `ctxRef` — a closure over `useNavigate()` would be
        // frozen at mount, since `ActionProvider` snapshots its handlers once.
        // Params replace the current ones wholesale; `?mode` is carried over.
        "app.navigate": async (params) => {
          setActionError(null);
          const page = typeof params?.page === "string" ? params.page.trim() : "";
          if (!page) {
            setActionError("app.navigate requires a `page`");
            return;
          }
          const ctx = ctxRef.current;
          ctx.navigate(appPagePath(ctx.app.id, page, params?.params, ctx.modeParam));
        },
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
  if (!activePage) {
    // Unknown `/p/<page>` (or a definition with no pages at all). Component-
    // side by necessity: this route table has no loaders.
    renderedSpec = (
      <AlertCallout
        tone="error"
        icon={AlertCircle}
        title={defaultPage ? `Unknown page "${activePageName}"` : "This app has no pages"}
      >
        {defaultPage ? (
          <p>
            <Link
              className="underline"
              // Keep `?mode` — recovering inside an embed/full-screen surface
              // must not bounce the viewer out of it.
              to={`/apps/${app.id}${modeParam ? `?${new URLSearchParams({ mode: modeParam })}` : ""}`}
            >
              Go to the default page ({defaultPage})
            </Link>
          </p>
        ) : (
          <p>Its definition declares neither `pages` nor a legacy `page`.</p>
        )}
      </AlertCallout>
    );
  } else {
    try {
      renderedSpec = <Renderer spec={activeSpec as never} registry={compiled.registry} />;
    } catch (e) {
      renderedSpec = (
        <AlertCallout tone="error" icon={AlertCircle} title="Failed to render app page">
          <p>{e instanceof Error ? e.message : String(e)}</p>
        </AlertCallout>
      );
    }
  }

  // Automatic in-app breadcrumbs: on any non-default page of a multi-page app
  // the runtime renders "<default page> › <current page>" with the first crumb
  // navigating back. Owned by the runtime (not the definition) so every app
  // gets it for free — including `?mode=chromeless`, where the dashboard
  // breadcrumb bar doesn't exist and this is the only way back.
  const showPageCrumbs =
    Boolean(activePage) && Object.keys(pages).length > 1 && activePageName !== defaultPage;
  const pageCrumbs = showPageCrumbs ? (
    <nav
      aria-label="App pages"
      className="flex min-w-0 items-center gap-1 text-xs text-muted-foreground"
      data-testid="app-page-crumbs"
    >
      <button
        type="button"
        className="truncate hover:text-foreground hover:underline"
        // Same semantics as `app.navigate` to the default page: history PUSH
        // (Back returns here), params dropped, only `?mode` carried over.
        onClick={() =>
          navigate(
            `/apps/${encodeURIComponent(app.id)}${
              modeParam ? `?${new URLSearchParams({ mode: modeParam })}` : ""
            }`,
          )
        }
      >
        {pages[defaultPage]?.title ?? defaultPage}
      </button>
      <ChevronRight className="size-3 shrink-0" />
      <span className="truncate text-foreground">{activePage?.title ?? activePageName}</span>
    </nav>
  ) : null;

  const surface = (
    <>
      {pageCrumbs}
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
        ref={scrollRef}
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
            {/* Exits full mode on the CURRENT page, not back to defaultPage. */}
            <Link to={urlWithMode(location, null)}>
              <Minimize2 className="size-3.5" />
              Exit full
            </Link>
          </Button>
        </div>
        <div ref={scrollRef} className="flex flex-col flex-1 min-h-0 gap-4 overflow-y-auto p-4">
          {surface}
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col flex-1 min-h-0 gap-4" data-testid="app-runtime">
      {/* The header (title, open-full/chromeless actions) stays fixed; ONLY
          the app canvas below scrolls. */}
      <PageHeader
        title={app.name}
        description={app.description ?? undefined}
        action={<AppHeaderActions app={app} />}
      />
      {/* Bordered, self-scrolling canvas so the app's limits are visible
          against the dashboard chrome. Default view only — full/chromeless
          own the whole viewport and need no frame. */}
      <div
        ref={scrollRef}
        className="flex flex-col flex-1 min-h-0 gap-4 overflow-y-auto rounded-lg border border-border bg-card p-4"
      >
        {surface}
      </div>
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
  const location = useLocation();
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

  // Both links keep the viewer on the page (and route params) they are on —
  // a detail view is exactly what someone wants to embed or maximize.
  const fullUrl = urlWithMode(location, "full");
  const chromelessUrl = `${window.location.origin}${urlWithMode(location, "chromeless")}`;

  return (
    <div className="flex items-center gap-2">
      <Link to="/apps" className="text-sm text-muted-foreground hover:underline">
        All apps
      </Link>
      <Button asChild variant="outline" size="sm" title="Maximize within the dashboard">
        <Link to={fullUrl}>
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

  // Keyed by app id ONLY: switching apps remounts the runtime with a fresh
  // json-render store, while navigating between pages of the SAME app keeps
  // the store and the polled query data warm.
  return <AppRuntime key={data.app.id} app={data.app} mode={mode} pageName={page} />;
}
