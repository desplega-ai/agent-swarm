/**
 * Chain halt: a failed `app.action`, `app.mutate`, `swarm.sdk` or `swarm.call`
 * step rejects, so the rest of its chain never runs. json-render's `emit` and
 * every chain runner in `components.tsx` iterate with `await execute(...)`, so a
 * rejection stops the loop; before this, the handlers swallowed their failures
 * and a `ui.toast` "Saved" after a failed write still fired.
 *
 * The handler reports the failure itself (an error toast, or the Form's inline
 * error) before throwing, so the rejection carries nothing left to show. Many
 * runners dispatch with `void runChain(...)` or a bare `emit("press")`;
 * `installChainHaltGuard` marks this one rejection type as handled instead of
 * threading a catch through each of them.
 */

export class ChainHaltError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChainHaltError";
  }
}

export function isChainHalt(error: unknown): error is ChainHaltError {
  return error instanceof ChainHaltError;
}

/** Reports a failed step through `report`, then halts the chain. */
export function haltChain(message: string, report: (message: string) => void): never {
  report(message);
  throw new ChainHaltError(message);
}

let guardInstalls = 0;
function swallowChainHalt(event: PromiseRejectionEvent): void {
  if (isChainHalt(event.reason)) event.preventDefault();
}

/**
 * Marks an already-reported `ChainHaltError` rejection as handled, so it never
 * reaches the console as an unhandled rejection. Ref-counted: returns the
 * uninstall, for a `useEffect` cleanup.
 */
export function installChainHaltGuard(target: Window | undefined = globalThis.window): () => void {
  if (!target) return () => {};
  if (guardInstalls === 0) target.addEventListener("unhandledrejection", swallowChainHalt);
  guardInstalls += 1;
  return () => {
    guardInstalls -= 1;
    if (guardInstalls === 0) target.removeEventListener("unhandledrejection", swallowChainHalt);
  };
}

/**
 * A step's `onError` stops the chain too. json-render's `executeAction` runs
 * `onError` and then SWALLOWS the failure, so its `emit` loop (and every chain
 * runner here) moved on to the next step: a failed `swarm.call` with
 * `onError` followed by a "Saved" toast still showed the toast.
 *
 * `withChainOnError` moves each binding's `onError` into a reserved param, so
 * json-render never sees it and the failure propagates; `withChainOnErrorHandlers`
 * strips that param before the handler runs, applies the `onError` itself on a
 * failure (the same `set` / `action` semantics, `"$error.message"` included),
 * then halts the chain. Rewriting the spec covers every runner at once: the
 * `emit` loop, Table/Form/row-action chains and the Undo chain all dispatch
 * bindings that come from the spec.
 */
export const CHAIN_ON_ERROR_PARAM = "__chainOnError";

type OnError = { set: Record<string, unknown> } | { action: string };

function isOnError(value: unknown): value is OnError {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return (
    (typeof v.set === "object" && v.set !== null && !Array.isArray(v.set)) ||
    typeof v.action === "string"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** Maps `fn` over a list, returning the input when nothing changed. */
function mapStable<T>(items: T[], fn: (item: T) => T): T[] {
  let changed = false;
  const next = items.map((item) => {
    const out = fn(item);
    if (out !== item) changed = true;
    return out;
  });
  return changed ? next : items;
}

/**
 * One action binding. Its `params` are payload data (a `swarm.call` body may
 * itself hold `action` / `onError` keys), so they are never walked; the one
 * chain that nests inside params, `ui.toast`'s `undo.actions`, is rewritten
 * by position.
 */
function rewriteBinding(value: unknown): unknown {
  if (!isRecord(value) || typeof value.action !== "string") return value;
  let binding = value;
  const params = isRecord(value.params) ? value.params : undefined;
  const undo = params && isRecord(params.undo) ? params.undo : undefined;
  if (value.action === "ui.toast" && params && undo && Array.isArray(undo.actions)) {
    const actions = mapStable(undo.actions, rewriteBinding);
    if (actions !== undo.actions) {
      binding = { ...value, params: { ...params, undo: { ...undo, actions } } };
    }
  }
  if (!isOnError(binding.onError)) return binding;
  const { onError, ...rest } = binding;
  const restParams = isRecord(rest.params) ? rest.params : {};
  return { ...rest, params: { ...restParams, [CHAIN_ON_ERROR_PARAM]: onError } };
}

/** A chain: an array of bindings, or the single binding `on.<event>` also accepts. */
function rewriteChain(value: unknown): unknown {
  return Array.isArray(value) ? mapStable(value, rewriteBinding) : rewriteBinding(value);
}

/** Prop keys that hold a chain: `actions` (rowActions, bulkActions) and `on<Event>` (onSubmit, onSelect, ...). */
function isChainKey(key: string): boolean {
  return key === "actions" || /^on[A-Z]/.test(key);
}

/** Walks element props to the chain-valued keys, leaving everything else as is. */
function rewriteProps(value: unknown): unknown {
  if (Array.isArray(value)) return mapStable(value, rewriteProps);
  if (!isRecord(value)) return value;
  let changed = false;
  const next: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    const out = isChainKey(key) && Array.isArray(child) ? rewriteChain(child) : rewriteProps(child);
    if (out !== child) changed = true;
    next[key] = out;
  }
  return changed ? next : value;
}

function rewriteElement(value: unknown): unknown {
  if (!isRecord(value)) return value;
  const props = rewriteProps(value.props);
  let on = value.on;
  if (isRecord(on)) {
    let changed = false;
    const nextOn: Record<string, unknown> = {};
    for (const [event, chain] of Object.entries(on)) {
      const out = rewriteChain(chain);
      if (out !== chain) changed = true;
      nextOn[event] = out;
    }
    if (changed) on = nextOn;
  }
  if (props === value.props && on === value.on) return value;
  const next = { ...value };
  if (props !== value.props) next.props = props;
  if (on !== value.on) next.on = on;
  return next;
}

function rewrite(elements: unknown): unknown {
  if (!isRecord(elements)) return elements;
  let changed = false;
  const next: Record<string, unknown> = {};
  for (const [id, element] of Object.entries(elements)) {
    const out = rewriteElement(element);
    if (out !== element) changed = true;
    next[id] = out;
  }
  return changed ? next : elements;
}

const rewritten = new WeakMap<object, unknown>();

/** The spec with every binding's `onError` moved into its params. Identity-stable per input. */
export function withChainOnError<T>(spec: T): T {
  if (!spec || typeof spec !== "object") return spec;
  const cached = rewritten.get(spec);
  if (cached !== undefined) return cached as T;
  const elements = (spec as { elements?: unknown }).elements;
  const nextElements = rewrite(elements);
  const out = nextElements === elements ? spec : { ...spec, elements: nextElements };
  rewritten.set(spec, out);
  return out;
}

// json-render passes resolved params; `undefined` is tolerated at runtime.
type Handler = (params: Record<string, unknown>) => unknown;

/**
 * Wraps a handler map so a failed step applies its moved `onError`, then
 * halts. A step without one is unchanged: its failure propagates as before.
 */
export function withChainOnErrorHandlers<M extends Record<string, Handler>>(
  handlers: M,
  deps: { set: (path: string, value: unknown) => void },
): M {
  const wrapped: Record<string, Handler> = {};
  for (const [name, handler] of Object.entries(handlers)) {
    wrapped[name] = async (params) => {
      if (!params || !(CHAIN_ON_ERROR_PARAM in params)) return handler(params);
      const onError = params[CHAIN_ON_ERROR_PARAM];
      const { [CHAIN_ON_ERROR_PARAM]: _moved, ...rest } = params;
      try {
        return await handler(rest);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (isOnError(onError)) {
          if ("set" in onError) {
            for (const [path, value] of Object.entries(onError.set)) {
              deps.set(path, value === "$error.message" ? message : value);
            }
          } else {
            // shortcut: runs a named handler with no params, as json-render's `{ action }` does; its builtins (setState, push) are not reachable here.
            await wrapped[onError.action]?.({});
          }
        }
        throw isChainHalt(error) ? error : new ChainHaltError(message);
      }
    };
  }
  return wrapped as M;
}
