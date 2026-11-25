/**
 * The app side of `window.appContext`: what an HTML page inside an app
 * `PageFrame` may ask the app to do, and the checks each request passes.
 *
 * Transport (wired by `page-frame.tsx`): the page posts `swarm-app:hello` to
 * its parent; the frame answers only a message whose `source` is its own
 * iframe and whose `origin` is the API origin, with `swarm-app:init` and a
 * `MessageChannel` port. Every later request travels on that port and lands in
 * `handle` below. The page holds no credential: an action runs through the
 * app's own `app.action` handler as the viewer, so the server's `app.use` gate
 * and the script's `caller` checks apply unchanged. The page gets less than
 * the viewer, never more: only the actions the embed lists, only the state
 * paths it exposes, only this app's pages.
 *
 * Pure (no React, no DOM), so the rules are unit-testable.
 */

/** Query param PageFrame adds inside an app; the page SDK sets `window.appContext` only when present. */
export const APP_CONTEXT_PARAM = "__swarm_app";
/** Requests per second one frame may send; extra requests are refused. */
export const APP_CONTEXT_RATE_PER_SEC = 20;
/** Largest request a page may send, in bytes of JSON (the realtime channel cap). */
export const APP_CONTEXT_MAX_BYTES = 64 * 1024;

export interface AppContextSnapshot {
  app: { id: string };
  route: unknown;
  params: Record<string, string>;
  theme: { mode: "dark" | "light"; preset: string | null };
  /** The `expose`d paths, keyed by path. */
  state: Record<string, unknown>;
}

export type AppContextActionResult =
  | { status: "ok"; result?: unknown }
  | { status: "running"; taskId?: string }
  | { status: "error"; error: string };

export interface AppContextHostDeps {
  /** `PageFrame.actions`: the only actions the page may run. */
  allowedActions: () => readonly string[];
  /** `PageFrame.id` (instance-namespaced); `emit` is dropped without one. */
  messageId: () => string | undefined;
  runAction: (name: string, input: unknown) => Promise<AppContextActionResult>;
  navigate: (page: string, params: Record<string, string>) => void;
  /** Store the message at `/ui/<id>/message`, then run `on.message`. */
  deliver: (id: string, message: { name: string; data: unknown; seq: number }) => void;
  now?: () => number;
}

export type AppContextReply =
  | { type: "swarm-app:result"; id: number; result: AppContextActionResult }
  | undefined;

const PAGE_NAME = /^[A-Za-z0-9_-]{1,64}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Route params as `app.navigate` takes them: scalars only, stringified. */
function scalarParams(value: unknown): Record<string, string> | null {
  if (value === undefined || value === null) return {};
  if (!isRecord(value)) return null;
  const out: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === "string" || typeof entry === "number" || typeof entry === "boolean") {
      out[key] = String(entry);
    } else if (entry !== undefined && entry !== null) {
      return null;
    }
  }
  return out;
}

function byteLength(value: unknown): number {
  try {
    return new TextEncoder().encode(JSON.stringify(value) ?? "").length;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

/**
 * One host per mounted frame. `handle` takes a raw port message and returns
 * the reply to post back (actions only), or nothing.
 */
export function createAppContextHost(deps: AppContextHostDeps) {
  const now = deps.now ?? (() => Date.now());
  const recent: number[] = [];
  let seq = 0;

  const refuse = (id: unknown, error: string): AppContextReply =>
    typeof id === "number"
      ? { type: "swarm-app:result", id, result: { status: "error", error } }
      : undefined;

  async function handle(raw: unknown): Promise<AppContextReply> {
    if (!isRecord(raw) || typeof raw.type !== "string") return undefined;
    const id = raw.id;
    const t = now();
    while (recent.length > 0 && t - (recent[0] ?? 0) >= 1000) recent.shift();
    if (recent.length >= APP_CONTEXT_RATE_PER_SEC) return refuse(id, "appContext: rate limited");
    recent.push(t);
    if (byteLength(raw) > APP_CONTEXT_MAX_BYTES)
      return refuse(id, "appContext: request over 64 KiB");

    switch (raw.type) {
      case "swarm-app:action": {
        if (typeof id !== "number") return undefined;
        const name = raw.name;
        if (typeof name !== "string" || !deps.allowedActions().includes(name)) {
          return refuse(
            id,
            `appContext: action "${String(name)}" is not in this PageFrame's actions`,
          );
        }
        try {
          return { type: "swarm-app:result", id, result: await deps.runAction(name, raw.input) };
        } catch (e) {
          return refuse(id, e instanceof Error ? e.message : String(e));
        }
      }
      case "swarm-app:navigate": {
        const params = scalarParams(raw.params);
        if (typeof raw.page === "string" && PAGE_NAME.test(raw.page) && params) {
          deps.navigate(raw.page, params);
        }
        return undefined;
      }
      case "swarm-app:emit": {
        const messageId = deps.messageId();
        if (!messageId || typeof raw.name !== "string" || raw.name === "") return undefined;
        seq += 1;
        deps.deliver(messageId, { name: raw.name, data: raw.data ?? null, seq });
        return undefined;
      }
      default:
        return undefined;
    }
  }

  return { handle };
}

/** `PageFrame.params` as the page's query string, plus the app marker. Reserved `__swarm*` names are dropped. */
export function appFrameQuery(appId: string | null, params: unknown): string {
  const query = new URLSearchParams();
  if (isRecord(params)) {
    for (const [key, value] of Object.entries(params)) {
      if (key.startsWith("__swarm")) continue;
      if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
        query.set(key, String(value));
      }
    }
  }
  if (appId) query.set(APP_CONTEXT_PARAM, appId);
  const text = query.toString();
  return text ? `?${text}` : "";
}

/** The page-facing copy of `PageFrame.params` (same filter as the query string). */
export function frameParams(params: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of new URLSearchParams(appFrameQuery(null, params))) out[key] = value;
  return out;
}
