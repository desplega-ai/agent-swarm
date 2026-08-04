/**
 * `<AppSurface>` — the swarm-apps runtime, decoupled from the `/apps/:id`
 * route so an app can be mounted anywhere in the dashboard (the route page is
 * now a thin wrapper; `/dev/embed-test` mounts the same component off-route).
 *
 * 1. `GET /api/apps/:id` → the app definition (models + queries + actions +
 *    pages) is fetched by the caller and handed in as `app`.
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
 * State lives in the dashboard-global store (`@/lib/json-render/store-registry`)
 * under `/apps/<appId>/…`, reached through a prefixing view — so definitions
 * stay app-relative, and the store SURVIVES unmount: leaving an app and coming
 * back keeps its query data, form drafts and action slots warm.
 *
 * 4. `ElementRef` nodes are expanded before rendering (`@/lib/json-render/
 *    assemble`). Elements borrowed from ANOTHER app make this surface run that
 *    app's queries too (one `useQueries`, `appId`-keyed as always) and mirror
 *    them at `/refs/<definingAppId>/queries/<name>`; actions dispatched from
 *    inside such an instance carry a `$app` marker and hit the DEFINING app's
 *    routes, with their slot at `/refs/<definingAppId>/actions/<name>`. Both
 *    mirrors live inside the CONSUMING app's subtree — a surface never writes
 *    into another app's state.
 *
 * Router tier: `/apps/:id` renders `defaultPage`, `/apps/:id/p/<name>` renders
 * that page — both URLs are valid and neither redirects. The route is mirrored
 * into state at `/route` as `{ page, params }` (declared params only, coerced
 * to their declared kind) so bindings, `visible` conditions and the `Drawer`
 * can read it.
 *
 * View modes (query string, mirrors the pages/:id `?mode=full` pattern):
 *   - default      → normal SPA chrome (PageHeader + action cluster).
 *   - ?mode=full   → full-viewport overlay with a slim header.
 *   - ?mode=chromeless → the rendered page only (embed surface, no header).
 */

import type { StateStore } from "@json-render/core";
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
  Settings,
} from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  Link,
  type NavigateFunction,
  useLocation,
  useNavigate,
  useSearchParams,
} from "react-router-dom";
import { api } from "@/api/client";
import type { AppQueryPlan } from "@/api/hooks/use-apps";
import {
  useAppDefinitions,
  useAppQueries,
  useAppQueryRefetch,
  useAppRefresh,
  useAppUserConfig,
} from "@/api/hooks/use-apps";
import type { AgentTaskStatus, AppDefinition, AppDetail, AppPageDef, AppRow } from "@/api/types";
import { AppSettingsDrawer } from "@/components/apps/app-settings-drawer";
import { AlertCallout } from "@/components/ui/alert-callout";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/ui/page-header";
import { useCopyToClipboard } from "@/hooks/use-copy-to-clipboard";
import { createSwarmActionHandlers, swarmCatalog, swarmComponents } from "@/lib/json-render";
import {
  assemblePageSpec,
  collectElementRefAppIds,
  DEFINING_APP_PARAM,
} from "@/lib/json-render/assemble";
import { getAppStoreView, getAppsStoreSnapshot } from "@/lib/json-render/store-registry";
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

// Dev-only read-out of the whole global apps store, for console QA:
// `window.__swarmAppsStore` prints the current snapshot (a getter, so it is
// never stale). Installed at module scope — the module only loads when an app
// surface is rendered.
if (import.meta.env.DEV && typeof window !== "undefined") {
  Object.defineProperty(window, "__swarmAppsStore", {
    configurable: true,
    get: () => getAppsStoreSnapshot(),
  });
}

export type ViewMode = "default" | "full" | "chromeless";

export function viewModeFromParam(mode: string | null): ViewMode {
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
  refetchModel: (appId: string, model: string) => Promise<void>;
  refetchQuery: (appId: string, queryName?: string) => Promise<void>;
  /** Every app on this surface — a script action can touch any of them. */
  refetchAll: () => Promise<void>;
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
 *
 * `statePath` is where the result is mirrored INSIDE the consuming app's view:
 * `/queries/<name>` for the surface's own app, `/refs/<definingAppId>/queries/
 * <name>` for a query pulled in by a borrowed bound element (which is exactly
 * the path the assembler rewrote that element's bindings to).
 */
interface QueryPlan extends AppQueryPlan {
  missing: string[];
  statePath: string;
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

/**
 * Which app an `app.*` action must execute against.
 *
 * The assembler tags every app-scoped action step inside a BORROWED bound
 * element instance with `$app: "<definingAppId>"` (see
 * `@/lib/json-render/assemble`) — that marker is the instance → defining-app
 * bookkeeping, and it travels in the params because `@json-render`'s
 * `ActionProvider` hands handlers the resolved params only: the dispatching
 * node's identity never reaches them, so a node-id → app sidecar map could not
 * be consulted here. Everything untagged is this surface's own app.
 *
 * VIEWER IDENTITY (review I9): these cross-app calls go out with the
 * dashboard's shared operator key, exactly like same-app calls. Rendering an
 * embedded element therefore does NOT yet prove the viewer may use the
 * defining app — `app.use` scoping (Phase 7) plus user-token adoption is what
 * will enforce that. Shipping rendering first is deliberate.
 */
function definingAppOf(params: { [key: string]: unknown } | undefined, ownAppId: string): string {
  const tagged = params?.[DEFINING_APP_PARAM];
  return typeof tagged === "string" && tagged ? tagged : ownAppId;
}

export function errorMessage(error: unknown): string | null {
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
 * mirroring every observed status into `<path>/taskStatus` (`path` is
 * `/actions/<name>`, or `/refs/<definingAppId>/actions/<name>` for an action
 * invoked from a borrowed bound element). On a completed task every app on
 * the surface is refetched — the task most likely wrote rows it displays.
 *
 * Runs detached from the invoking action handler, so it never rejects: any
 * non-transient failure is surfaced through `onError` (and, while the slot is
 * still `running`, mirrored into `/actions/<name>`) instead of escaping as an
 * unhandled rejection that would leave the app stuck on "running".
 *
 * The `PollRegistry` is captured ONCE, at start: it identifies the mount that
 * owns this watcher. Reading it live off `ctxRef` would let a watcher from a
 * disposed mount be revived by the next mount's registry (React StrictMode's
 * mount → unmount → mount, or a fast route bounce) and poll the same task
 * twice.
 */
async function pollActionTask(
  ctxRef: React.RefObject<RuntimeCtx>,
  path: string,
  taskId: string,
  onError: (message: string) => void,
): Promise<void> {
  const poll = ctxRef.current.poll;
  try {
    for (;;) {
      if (!(await waitUnlessDisposed(poll, TASK_POLL_MS))) return;
      const ctx = ctxRef.current;
      let status: AgentTaskStatus;
      try {
        status = (await api.fetchTask(taskId)).status;
      } catch {
        // Transient fetch failure — keep watching rather than declaring the
        // action failed (the task itself is still running server-side).
        continue;
      }
      if (poll.disposed) return;

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
        await ctx.refetchAll();
      } else {
        // Surface the terminal failure in the runtime's error callout too —
        // not every app page binds `/actions/<name>/error`.
        onError(`task ${status}`);
      }
      return;
    }
  } catch (e) {
    const ctx = ctxRef.current;
    if (poll.disposed) return;
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

export interface AppSurfaceProps {
  /** The loaded app (definition included) — the caller owns the fetch. */
  app: AppDetail;
  /** Chrome level. Defaults to the full dashboard chrome. */
  mode?: ViewMode;
  /** Page of `definition.pages` to render; defaults to the app's `defaultPage`. */
  pageName?: string;
  /**
   * Router push used by `app.navigate` / the breadcrumbs. Defaults to the
   * ambient `useNavigate()`; an embedding surface can pass its own so app
   * navigation stays inside the host (it still receives `/apps/:id/p/<page>`
   * paths).
   */
  navigate?: NavigateFunction;
}

/**
 * The app runtime. Mountable anywhere inside the dashboard router — it reads
 * the URL (search params) for route-driven queries and writes `/route`, but it
 * owns no route of its own.
 *
 * NOT keyed internally: mount it with `key={app.id}` if the host can swap apps
 * in place, so in-flight task watchers are disposed with the old app.
 */
export function AppSurface({
  app,
  mode = "default",
  pageName,
  navigate: navigateProp,
}: AppSurfaceProps) {
  const definition = app.definition;
  const routerNavigate = useNavigate();
  const navigate = navigateProp ?? routerNavigate;
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

  // ── Borrowed elements: resolve the apps they are defined in ──────────────
  // ONE `useQueries` over the whole target list (a `useApp()` per target would
  // make the hook count vary with the definition). `collectElementRefAppIds`
  // only sees one level at a time — an element borrowed from app B may itself
  // reference app C — so newly resolved apps feed the next render's list,
  // which converges within the reference-depth cap.
  const [discoveredAppIds, setDiscoveredAppIds] = useState<string[]>([]);
  const targetAppIds = useMemo(() => {
    const ids = new Set(collectElementRefAppIds(app));
    for (const id of discoveredAppIds) if (id !== app.id) ids.add(id);
    return [...ids].sort();
  }, [app, discoveredAppIds]);

  const definitionResults = useAppDefinitions(targetAppIds);
  // Identity-stable across polls: the memo re-runs only when a definition
  // actually changes, so the assembled spec keeps hitting `Renderer`'s memo.
  const definitionSignature = definitionResults
    .map((result) => {
      const loaded = result.data?.app;
      return loaded ? `${loaded.id}@${loaded.updatedAt}` : "";
    })
    .join("|");
  // Rebuilt only when that signature changes (`definitionResults` is a fresh
  // array every render, so a `useMemo` over it would churn the map identity —
  // and with it the assembled spec — on every 5s poll tick).
  const resolvedAppsRef = useRef<{ signature: string | null; map: Map<string, AppDetail> }>({
    signature: null,
    map: new Map(),
  });
  if (resolvedAppsRef.current.signature !== definitionSignature) {
    const map = new Map<string, AppDetail>();
    for (const result of definitionResults) {
      const loaded = result.data?.app;
      if (loaded) map.set(loaded.id, loaded);
    }
    resolvedAppsRef.current = { signature: definitionSignature, map };
  }
  const resolvedApps = resolvedAppsRef.current.map;
  // A target whose definition request is still in flight gets a neutral
  // "Loading…" card from the assembler instead of an "app unavailable" error.
  // `useQueries` keeps result order, so the index lines up with the id list.
  const pendingAppIds = targetAppIds
    .filter((id, index) => !resolvedApps.has(id) && definitionResults[index]?.isError !== true)
    .join(",");

  useEffect(() => {
    const next = collectElementRefAppIds(app, resolvedApps).filter((id) => id !== app.id);
    const known = new Set(targetAppIds);
    if (next.length !== targetAppIds.length || next.some((id) => !known.has(id))) {
      setDiscoveredAppIds(next);
    }
  }, [app, resolvedApps, targetAppIds]);

  // The json-render spec of the active page — `title` / `params` are runtime
  // metadata, not part of it. Every `ElementRef` is expanded here (instance-
  // namespaced ids, `/refs/<definingAppId>` data refs) so `<Renderer>` and the
  // component catalog stay stock. Memoized so the `Renderer` keeps hitting its
  // own spec-identity memo across the 5s poll re-renders.
  const assembled = useMemo(
    () =>
      assemblePageSpec(app, activePageName, resolvedApps, {
        pendingAppIds: pendingAppIds ? pendingAppIds.split(",") : [],
      }),
    [app, activePageName, resolvedApps, pendingAppIds],
  );
  const activeSpec = assembled.spec;

  // Named queries, each with the route params its `$param` filters need. A
  // query missing one is parked (not executed) and gets an explicit error slot.
  // The surface's OWN queries all run; a borrowed app contributes only the
  // queries its embedded elements actually bind to.
  const queryPlans = useMemo<QueryPlan[]>(() => {
    const plan = (
      planAppId: string,
      planDefinition: AppDefinition,
      name: string,
      statePath: string,
    ): QueryPlan => {
      const paramNames = queryParamNames(planDefinition, name);
      if (paramNames.length === 0) return { appId: planAppId, name, statePath, missing: [] };
      const missing = paramNames.filter((param) => routeParams[param] === undefined);
      if (missing.length > 0) {
        return { appId: planAppId, name, statePath, enabled: false, missing };
      }
      const params: Record<string, string | number | boolean> = {};
      for (const param of paramNames) {
        params[param] = routeParams[param] as string | number | boolean;
      }
      return { appId: planAppId, name, statePath, params, missing: [] };
    };

    const plans = Object.keys(definition.queries ?? {}).map((name) =>
      plan(app.id, definition, name, `/queries/${name}`),
    );
    // A borrowed bound element reads its OWN app's queries; the route params
    // available here are the CONSUMER's, which is all a cross-app embed can
    // offer (a `$param` query it cannot satisfy parks with an explicit error).
    for (const [definingAppId, names] of Object.entries(assembled.boundQueries)) {
      const definingApp = resolvedApps.get(definingAppId);
      if (!definingApp) continue;
      for (const name of names) {
        if (!definingApp.definition.queries?.[name]) continue;
        plans.push(
          plan(
            definingAppId,
            definingApp.definition,
            name,
            `/refs/${definingAppId}/queries/${name}`,
          ),
        );
      }
    }
    return plans;
  }, [app.id, definition, routeParams, assembled, resolvedApps]);

  const results = useAppQueries(queryPlans);
  // Definitions of every app this surface runs queries/actions against.
  const definitionsByApp = useMemo(() => {
    const map = new Map<string, AppDefinition>([[app.id, definition]]);
    for (const [appId, loaded] of resolvedApps) map.set(appId, loaded.definition);
    return map;
  }, [app.id, definition, resolvedApps]);
  const { refetchModel, refetchQuery, refetchAll } = useAppQueryRefetch(definitionsByApp);

  const [actionError, setActionError] = useState<string | null>(null);
  const [lastResponse, setLastResponse] = useState<unknown>(undefined);

  // This app's mount in the dashboard-global store. Every path the definition,
  // the components and the handlers below use is app-relative and gets
  // prefixed with `/apps/<app.id>` by the view. The view (and the state behind
  // it) outlives this component — remounting the same app finds it warm.
  const store = useMemo(() => getAppStoreView(app.id), [app.id]);

  // ── `/route` mirror ──────────────────────────────────────────────────────
  // `/route` is the ONE slot a mount owns: the URL it was mounted at is, by
  // definition, the current truth, while every other slot (queries, forms,
  // interaction state) belongs to the store and is left warm. So the mount
  // asserts its route SYNCHRONOUSLY on first render whenever the stored slot
  // disagrees with it — a cold store and a warm re-entry from a different page
  // both render their route-driven bits (a Drawer opened by a route param, a
  // `visible` condition) on the FIRST committed paint. Deferring the warm case
  // to the layout effect below would commit one render against the PREVIOUS
  // visit's route, mounting and immediately unmounting that subtree.
  //
  // The layout effect then owns every LATER change (client-side navigation),
  // still before paint.
  //
  // Two surfaces of the SAME app share `/route` — accepted. Note what that
  // means concretely: each surface asserts its own route on mount and whenever
  // its own URL changes, so the last one to mount/navigate wins for both; a
  // surface does NOT re-assert its route when the other one overwrites it.
  const routeSlotRef = useRef<RouteSlot>({ page: activePageName, params: routeParams });
  routeSlotRef.current = { page: activePageName, params: routeParams };
  const routeSyncedRef = useRef<{ store: StateStore; signature: string } | null>(null);
  const seededStoreRef = useRef<StateStore | null>(null);
  if (seededStoreRef.current !== store) {
    seededStoreRef.current = store;
    const stored = store.get("/route") as RouteSlot | undefined;
    const storedSignature = stored
      ? JSON.stringify({ page: stored.page, params: stored.params })
      : null;
    // Only writes when the stored route actually differs, so re-entering the
    // page you left is a no-op (no needless store churn / render).
    if (storedSignature !== routeSignature) store.set("/route", routeSlotRef.current);
    routeSyncedRef.current = { store, signature: routeSignature };
  }
  // Layout effect, not passive: a client-side navigation must land in the
  // store before paint, or the first frame of the new page renders against the
  // PREVIOUS page's `/route`.
  useLayoutEffect(() => {
    const synced = routeSyncedRef.current;
    if (synced && synced.store === store && synced.signature === routeSignature) return;
    routeSyncedRef.current = { store, signature: routeSignature };
    store.set("/route", routeSlotRef.current);
  }, [routeSignature, store]);

  // Timers owned by in-flight task watchers, cancelled on unmount. Declared
  // here (before `ctxRef` reads it); the effect that owns its lifecycle sits
  // below `ctxRef`, which the re-adoption pass needs.
  const pollRef = useRef<PollRegistry>({ disposed: false, timers: new Set() });

  // Mutable context for the action handlers — `ActionProvider` snapshots its
  // `handlers` prop on mount, so the handlers themselves must be identity
  // stable and read everything fresh through this ref.
  const modeParam = searchParams.get("mode");
  const ctxRef = useRef<RuntimeCtx>({
    app,
    refetchModel,
    refetchQuery,
    refetchAll,
    store,
    poll: pollRef.current,
    navigate,
    modeParam,
  });
  ctxRef.current = {
    app,
    refetchModel,
    refetchQuery,
    refetchAll,
    store,
    poll: pollRef.current,
    navigate,
    modeParam,
  };

  // ── Task-watcher lifecycle + re-adoption ─────────────────────────────────
  // Every mount installs a FRESH `PollRegistry` (watchers capture theirs at
  // start, so a watcher from a disposed mount can never be revived by this
  // one) and then re-adopts the app's still-running task-backed actions.
  //
  // Without the re-adoption pass, navigating away mid-poll orphaned the slot:
  // the watcher died with the mount, but `/actions/<name>` survives in the
  // global store, so the app came back showing `running` forever.
  //
  // Double-adoption is impossible even under StrictMode's mount → unmount →
  // mount: the unmount disposes the registry the first watcher captured, so it
  // exits at its next await instead of racing the second one. (The `taskId`
  // supersede check inside `pollActionTask` does NOT cover this on its own —
  // two watchers of the SAME task both pass it.)
  useEffect(() => {
    const poll: PollRegistry = { disposed: false, timers: new Set() };
    pollRef.current = poll;
    ctxRef.current.poll = poll;

    // Both action roots are scanned: this app's own `/actions/<name>` slots
    // AND the `/refs/<definingAppId>/actions/<name>` slots written by actions
    // invoked from a borrowed bound element. Skipping the latter would
    // reintroduce the orphaned-`running`-forever bug for exactly the embeds
    // Phase 6 adds.
    const readSlots = (root: string): void => {
      const actions = ctxRef.current.store.get(root);
      if (!actions || typeof actions !== "object") return;
      for (const [name, slot] of Object.entries(actions as Record<string, ActionSlot>)) {
        if (slot?.status === "running" && slot.taskId) {
          void pollActionTask(ctxRef, `${root}/${name}`, slot.taskId, setActionError);
        }
      }
    };
    readSlots("/actions");
    const refs = ctxRef.current.store.get("/refs");
    if (refs && typeof refs === "object") {
      for (const definingAppId of Object.keys(refs as Record<string, unknown>)) {
        readSlots(`/refs/${definingAppId}/actions`);
      }
    }

    return () => {
      poll.disposed = true;
      for (const timer of poll.timers) clearTimeout(timer);
      poll.timers.clear();
    };
  }, []);

  // Page switches start at the top — no `ScrollRestoration` is mounted in this
  // SPA, and the runtime's own wrapper is the scroll container.
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const scrolledPageRef = useRef(activePageName);
  useEffect(() => {
    if (scrolledPageRef.current === activePageName) return;
    scrolledPageRef.current = activePageName;
    scrollRef.current?.scrollTo({ top: 0 });
  }, [activePageName]);

  // Mirror query results into their state slot — `/queries/<name>` for this
  // app's own queries, `/refs/<definingAppId>/queries/<name>` for the ones a
  // borrowed bound element reads. BOTH are written through this app's view,
  // i.e. they live under `/apps/<consumerId>/…`: the defining app's own
  // subtree is never written from here, and each consumer keeps its own copy
  // of the mirror (react-query below is the single fetch). The previous slot is read
  // back out of the STORE (not a per-mount ref): the store is what the page
  // actually renders and it stays warm across mounts, so a remount whose
  // react-query entry has been garbage-collected must not blank the rows the
  // viewer is looking at while the first poll is in flight.
  useEffect(() => {
    queryPlans.forEach((plan, index) => {
      const result = results[index];
      const prev = store.get(plan.statePath) as QuerySlot | undefined;
      // A `$param` query whose params aren't all in the route never ran —
      // say so in the slot instead of leaving it on a permanent spinner. The
      // previous rows are RETAINED (not blanked) so content driven by the
      // param — a closing Drawer mid slide-out — doesn't flash empty; a fresh
      // deep link has no previous rows and still shows the empty state.
      const next: QuerySlot = plan.missing.length
        ? {
            data: prev?.data ?? EMPTY_ROWS,
            loading: false,
            error: `missing route param(s): ${plan.missing.join(", ")}`,
          }
        : {
            // `rows` is `[]` for a genuinely empty result, so `??` only falls
            // through when the query has NO result yet (fresh mount, evicted
            // cache) — exactly the case where the warm rows should survive
            // under the spinner.
            data: result?.data?.rows ?? prev?.data ?? EMPTY_ROWS,
            loading: result?.isLoading ?? true,
            error: errorMessage(result?.error),
          };
      if (
        prev &&
        prev.data === next.data &&
        prev.loading === next.loading &&
        prev.error === next.error
      ) {
        return;
      }
      store.set(plan.statePath, next);
    });
  }, [queryPlans, results, store]);

  // ── `/user` mirror (per-viewer userConfig) ───────────────────────────────
  // The CONSUMING app's own preferences, mirrored read-only at `/user/<field>`
  // so any node — including one inside a borrowed element instance — can bind
  // `{ "$state": "/user/<field>" }`.
  //
  // Deliberately NOT mirrored for the resolved DEFINING apps: a borrowed
  // element reads its defining app's DATA through `/refs/<definingAppId>/…`,
  // but `/user` is the viewer's preferences for the app they are actually
  // looking at, so an embed inherits the host's settings rather than the
  // producer's.
  //
  // Written as one object (not field-by-field) so a field dropped from the
  // schema disappears from the mirror too, and guarded by a content signature
  // because the whole subtree is replaced on every write.
  const hasUserConfig = Object.keys(definition.userConfig ?? {}).length > 0;
  const userConfig = useAppUserConfig(app.id, { enabled: hasUserConfig });
  const userConfigValues = userConfig.data?.values;
  const userConfigSignature = hasUserConfig ? JSON.stringify(userConfigValues ?? null) : null;
  useEffect(() => {
    if (userConfigSignature === null) {
      // App declares no userConfig: touch the store ONLY to clear a mirror an
      // earlier definition left behind. Content-aware, like the main path
      // below — an already-cleared `{}` is not `undefined`, so a plain
      // existence check would rewrite it (and churn every subscriber of this
      // subtree) on every run of this effect.
      const existing = store.get("/user");
      const stale =
        typeof existing === "object" &&
        existing !== null &&
        Object.keys(existing as Record<string, unknown>).length > 0;
      if (stale) store.set("/user", {});
      return;
    }
    // Nothing fetched yet — leave the warm mirror alone rather than blanking
    // the values the page is already rendering.
    if (!userConfigValues) return;
    // Idempotent like the query mirror: re-mounting or a poll that changed
    // nothing must not churn the store (and re-render the page).
    if (JSON.stringify(store.get("/user") ?? null) === userConfigSignature) return;
    store.set("/user", userConfigValues);
  }, [userConfigSignature, userConfigValues, store]);

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
          const targetAppId = definingAppOf(params, ctx.app.id);
          try {
            if (params.op === "create") {
              setLastResponse(
                await api.createAppRow(targetAppId, params.model, params.values ?? {}),
              );
              // The Form injects its own id, so a successful create resets the
              // fields the user just submitted. Inside an element instance
              // that id is already `instances/<key>/<origId>`.
              if (params.formId) ctx.store.set(`/forms/${params.formId}`, {});
            } else if (params.op === "update") {
              if (!params.rowId) throw new Error("app.mutate op=update requires rowId");
              setLastResponse(
                await api.updateAppRow(
                  targetAppId,
                  params.model,
                  params.rowId,
                  params.values ?? {},
                ),
              );
            } else {
              if (!params.rowId) throw new Error("app.mutate op=delete requires rowId");
              setLastResponse(await api.deleteAppRow(targetAppId, params.model, params.rowId));
            }
            await ctx.refetchModel(targetAppId, params.model);
          } catch (e) {
            setActionError(e instanceof Error ? e.message : String(e));
          }
        },
        "app.refresh": async (params) => {
          setActionError(null);
          const ctx = ctxRef.current;
          try {
            await ctx.refetchQuery(definingAppOf(params, ctx.app.id), params?.query);
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
          const targetAppId = definingAppOf(params, ctx.app.id);
          // Consumer-local slot: each surface tracks its own invocation state
          // (and its own task polling), even when two of them invoke the same
          // action of the same defining app.
          const path =
            targetAppId === ctx.app.id
              ? `/actions/${name}`
              : `/refs/${targetAppId}/actions/${name}`;
          ctx.store.set(path, { status: "running" } satisfies ActionSlot);
          try {
            const response = await api.invokeAppAction(targetAppId, name, params?.input);
            setLastResponse(response);

            if (response.taskId) {
              ctx.store.set(path, {
                status: "running",
                taskId: response.taskId,
                taskStatus: response.status,
              } satisfies ActionSlot);
              void pollActionTask(ctxRef, path, response.taskId, setActionError);
              return;
            }

            if (response.ok) {
              ctx.store.set(path, {
                status: "ok",
                result: response.result,
              } satisfies ActionSlot);
              // A script action can touch any model of any app on the surface.
              await ctx.refetchAll();
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
        action={
          <AppHeaderActions
            appIds={[...definitionsByApp.keys()]}
            settingsApp={hasUserConfig ? app : null}
          />
        }
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
 * refresh without waiting for the 30s definition poll — for this app AND
 * every app it borrows elements from, so embeds refresh with the page.
 *
 * `settingsApp` is the app whose per-viewer `userConfig` the gear edits, or
 * `null` for an app that declares none — in which case no gear is rendered.
 */
function AppHeaderActions({
  appIds,
  settingsApp,
}: {
  appIds: string[];
  settingsApp: AppDetail | null;
}) {
  const refresh = useAppRefresh(appIds);
  const location = useLocation();
  const { copied, copy } = useCopyToClipboard();
  const [refreshing, setRefreshing] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);

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
      {settingsApp && (
        <>
          <Button
            variant="outline"
            size="icon"
            aria-label="App settings"
            title="Your settings for this app"
            data-testid="app-settings-open"
            onClick={() => setSettingsOpen(true)}
          >
            <Settings className="size-3.5" />
          </Button>
          <AppSettingsDrawer
            appId={settingsApp.id}
            appName={settingsApp.name}
            open={settingsOpen}
            onOpenChange={setSettingsOpen}
          />
        </>
      )}
    </div>
  );
}
