/**
 * Dashboard-global json-render state store + per-app mounted views.
 *
 * One `StateStore` for the whole dashboard. Every mounted app gets a
 * `StoreView` — a full `StateStore` implementation that prefixes EVERY path
 * with `/apps/<appId>` and presents that subtree as the root of its snapshot.
 * App definitions therefore stay app-relative (`/queries/<q>`, `/route`,
 * `/forms/<id>`, `/actions/<n>`): neither the catalog components nor the
 * definition JSON ever see the mount prefix.
 *
 * Why a view and not one store per app:
 *   - apps (and, from Phase 6, elements borrowed from other apps) can be
 *     mounted anywhere in the dashboard, several at a time, and their state
 *     has to live in one place to be inspectable/shareable;
 *   - the store outlives the mount, so leaving an app and coming back keeps
 *     its query data warm (deliberate — see `AppSurface`).
 *
 * Deliberately NO absolute-path escape hatch: `$state` / `$bindState` resolve
 * declaratively against the *snapshot* the provider hands the renderer
 * (`@json-render/core` `resolvePropValue` → `getByPath(ctx.stateModel, …)`),
 * so a path that points outside the view's subtree could never resolve. Cross-
 * app data reaches a consuming app by being mirrored INTO its subtree (Phase 6
 * writes `/refs/<definingAppId>/…`), not by escaping the prefix.
 */

import { createStateStore, type StateModel, type StateStore } from "@json-render/core";

/** The one store behind every mounted app surface in the dashboard. */
const globalStore = createStateStore({});

/** `appId` → its cached view. Cached because `useSyncExternalStore` requires
 * identity-stable `subscribe` / `getSnapshot` function references. */
const views = new Map<string, StateStore>();

/**
 * Frozen, module-level fallback snapshot. Must be a single shared reference:
 * a fresh `{}` per call would make `getSnapshot()` return a new object every
 * time and trip React's "getSnapshot should be cached" infinite-loop guard.
 * In practice it is never returned — `getAppStoreView` seeds the subtree — but
 * a `set("", …)`-style write that replaces the subtree with a non-object would
 * otherwise reintroduce the hazard.
 */
const EMPTY_SNAPSHOT: StateModel = Object.freeze({});

/** RFC 6901 escaping for the one segment we inject ourselves. App ids are
 * UUIDs today; escaping keeps the mount correct if that ever changes. */
function escapeSegment(segment: string): string {
  return segment.replace(/~/g, "~0").replace(/\//g, "~1");
}

/**
 * The view for `appId`, created on first use and cached forever (the store is
 * never evicted — cross-app-warm by design).
 *
 * Snapshot stability, the load-bearing detail:
 *   - the subtree is seeded to `{}` here, so `getSnapshot()` always finds a
 *     real object and never has to synthesize one per call;
 *   - `immutableSetByPath` clones ONLY along the path it writes, so a write to
 *     `/apps/<other>/…` produces a new root and a new `apps` object but leaves
 *     `apps[<appId>]` referentially identical. Unrelated apps' subscribers are
 *     notified (one global listener set) and then bail out in
 *     `useSyncExternalStore` because their snapshot did not change — i.e. no
 *     re-render fan-out across apps.
 */
export function getAppStoreView(appId: string): StateStore {
  const cached = views.get(appId);
  if (cached) return cached;

  const root = `/apps/${escapeSegment(appId)}`;

  // Seed the mount so the subtree always exists (see the snapshot note above).
  // Never clobber: a second surface of the same app must inherit the warm one.
  if (globalStore.get(root) === undefined) globalStore.set(root, {});

  /** App-relative path → absolute path in the global store. Accepts both
   * `/queries/x` and `queries/x` (the core pointer parser tolerates both). */
  const absolute = (path: string): string => {
    if (!path || path === "/") return root;
    return path.startsWith("/") ? `${root}${path}` : `${root}/${path}`;
  };

  const getSnapshot = (): StateModel => {
    const subtree = globalStore.get(root);
    return subtree !== null && typeof subtree === "object"
      ? (subtree as StateModel)
      : EMPTY_SNAPSHOT;
  };

  /**
   * A root write (`""` / `"/"`) would replace the app's ENTIRE subtree —
   * queries, forms, route and all — and app JSON can reach `set` through an
   * action's `onSuccess.set`. The base store has no root-write semantics
   * either (`immutableSetByPath(root, "", v)` writes a key literally named
   * `""`), so dropping it is the faithful no-op, not a new restriction.
   */
  const isRootWrite = (path: string): boolean => {
    if (path && path !== "/") return false;
    if (import.meta.env.DEV) {
      console.warn(
        `[json-render] ignored a root write to app store "${appId}" (path ${JSON.stringify(path)}) — write a specific path instead.`,
      );
    }
    return true;
  };

  const view: StateStore = {
    get: (path) => globalStore.get(absolute(path)),
    set: (path, value) => {
      if (isRootWrite(path)) return;
      globalStore.set(absolute(path), value);
    },
    update: (updates) => {
      // Kept as ONE global `update` call so the batched single-notification
      // semantics of the contract survive the prefixing.
      const prefixed: Record<string, unknown> = {};
      for (const [path, value] of Object.entries(updates)) {
        if (isRootWrite(path)) continue;
        prefixed[absolute(path)] = value;
      }
      globalStore.update(prefixed);
    },
    getSnapshot,
    getServerSnapshot: getSnapshot,
    // Delegated to the global store: every write notifies every mounted app,
    // and the snapshot identity check above is what keeps that cheap.
    subscribe: (listener) => globalStore.subscribe(listener),
  };

  views.set(appId, view);
  return view;
}

/**
 * The whole global state tree — dev/debug read-out only
 * (`window.__swarmAppsStore`).
 *
 * The DEV gate lives HERE rather than at the call site: this is the only
 * function that can hand out state outside a single app's mount, so making it
 * inert in production keeps "an app can never reach another app's subtree" a
 * property of this module instead of a convention its callers must honour.
 */
export function getAppsStoreSnapshot(): StateModel {
  if (!import.meta.env.DEV) return EMPTY_SNAPSHOT;
  return globalStore.getSnapshot();
}
