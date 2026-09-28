import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";

/**
 * Autosave for the fields of a multi-step flow (`/setup`): no Save buttons.
 * A field stores itself after the operator stops typing (debounce), or at
 * once on a commit (blur, paste, a swatch click). Only valid values are stored.
 *
 * `pending` = a debounced save is scheduled. `saved` = the last save in this
 * session succeeded and the field still shows that value.
 */
export type AutosavePhase = "idle" | "pending" | "saving" | "saved" | "error";

const SAVING_REASON = "Saving…";

/** Store about 800 ms after typing stops. */
const AUTOSAVE_DELAY_MS = 800;

/**
 * Holds or releases the step's Continue with a reason (its tooltip). `busy`
 * marks work in flight. The `/setup` shell passes `StepProps.setContinueBlocker`.
 */
export type ContinueBlockerSetter = (reason: string | null, options?: { busy?: boolean }) => void;

/** Sets or removes the step's Continue action (`StepProps.setContinueAction` in `/setup`). */
export type ContinueActionSetter = (action: (() => Promise<void>) | null) => void;

interface AutosaveScopeValue {
  /** Hold Continue with `reason` while it is not null. One hold per `id`. */
  hold: (id: string, reason: string | null) => void;
}

/**
 * Every autosave field inside a step reports here, so the step can hold the
 * shell's Continue while any save is scheduled or in flight. Other work
 * holds it through `useContinueHold` (for example a value that still loads).
 */
export const AutosaveScopeContext = createContext<AutosaveScopeValue | null>(null);

/** Keep the newest value of `value` in a ref, readable from timers and effects. */
function useLatest<T>(value: T) {
  const ref = useRef(value);
  useLayoutEffect(() => {
    ref.current = value;
  });
  return ref;
}

/**
 * Hold the shell's Continue with `reason` (its tooltip) while it is not null.
 * `busy` marks work in flight (the footer shows a spinner). Releases on unmount.
 */
export function useContinueBlocker(
  setContinueBlocker: ContinueBlockerSetter,
  reason: string | null,
  options?: { busy?: boolean },
) {
  const busy = options?.busy ?? false;
  // The shell may pass a new function on each render. A ref keeps the effects
  // below from firing on identity changes (that would loop through its state).
  const blocker = useLatest(setContinueBlocker);
  useEffect(() => {
    blocker.current(reason, { busy });
  }, [reason, busy, blocker]);
  useEffect(() => () => blocker.current(null), [blocker]);
}

/**
 * Offer `action` as the shell's Continue action while it is not null (see
 * `ContinueActionSetter`). The shell always runs the newest `action`.
 * Removes it on unmount.
 */
export function useContinueAction(
  setContinueAction: ContinueActionSetter,
  action: (() => Promise<void>) | null,
) {
  const setter = useLatest(setContinueAction);
  const latestAction = useLatest(action);
  const enabled = action !== null;
  useEffect(() => {
    setter.current(enabled ? () => latestAction.current?.() ?? Promise.resolve() : null);
  }, [enabled, setter, latestAction]);
  useEffect(() => () => setter.current(null), [setter]);
}

/**
 * Step-level scope. Provide the result through `AutosaveScopeContext` around
 * the step body. Holds Continue with "Saving…" while any field saves, else
 * with the reason of the first other hold. Every hold shows the spinner.
 */
export function useAutosaveScope(setContinueBlocker: ContinueBlockerSetter): AutosaveScopeValue {
  const [holds, setHolds] = useState<ReadonlyMap<string, string>>(() => new Map());

  const hold = useCallback((id: string, reason: string | null) => {
    setHolds((prev) => {
      if ((prev.get(id) ?? null) === reason) return prev;
      const next = new Map(prev);
      if (reason === null) next.delete(id);
      else next.set(id, reason);
      return next;
    });
  }, []);

  const reasons = [...holds.values()];
  const reason = reasons.includes(SAVING_REASON) ? SAVING_REASON : (reasons[0] ?? null);
  useContinueBlocker(setContinueBlocker, reason, { busy: reason !== null });

  return useMemo(() => ({ hold }), [hold]);
}

/**
 * Hold the step's Continue with `reason` while it is not null, through the
 * surrounding `AutosaveScopeContext`. Releases on unmount.
 */
export function useContinueHold(reason: string | null) {
  const scope = useContext(AutosaveScopeContext);
  const id = useId();
  useEffect(() => {
    scope?.hold(id, reason);
  }, [scope, id, reason]);
  useEffect(() => () => scope?.hold(id, null), [scope, id]);
}

export interface AutosaveOptions {
  /** The value to store (trim it first where that matters). */
  value: string;
  /** The value differs from what the server holds and should be stored. */
  dirty: boolean;
  /** Valid enough to store after the debounce while typing. */
  ready: boolean;
  /**
   * Valid enough to store on a commit (blur, paste). Defaults to `ready`.
   * Pass `ready: false` with this for values that must never store while
   * typing, such as secrets.
   */
  readyOnCommit?: boolean;
  /** Store the value. Throw to show the error state (a commit retries it). */
  save: (value: string) => Promise<void>;
  delayMs?: number;
}

export interface Autosave {
  phase: AutosavePhase;
  error: string | null;
  /** Store now when the value is valid (blur, paste, a click on a swatch, a retry). */
  commit: () => void;
}

export function useAutosave({
  value,
  dirty,
  ready,
  readyOnCommit = ready,
  save,
  delayMs = AUTOSAVE_DELAY_MS,
}: AutosaveOptions): Autosave {
  const [phase, setPhase] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [commitTick, setCommitTick] = useState(0);
  const latest = useLatest({ value, dirty, ready, readyOnCommit, save });
  const timer = useRef<number | undefined>(undefined);
  // True while a debounced save waits. Separate from `timer` because effect
  // cleanups clear the timeout before the unmount flush below reads this.
  const scheduled = useRef(false);
  const chain = useRef<Promise<void>>(Promise.resolve());
  const lastStored = useRef<string | null>(null);
  const newest = useRef(0);
  const mounted = useRef(true);

  // Queue a save of `next`, validated by the caller when it enqueues (a later,
  // invalid draft never reaches the server). Saves run one after another. A
  // save that a newer one replaced before it started is dropped, and a value
  // already stored is not stored again.
  const enqueue = useCallback((next: string, store: (value: string) => Promise<void>) => {
    const seq = ++newest.current;
    chain.current = chain.current.then(async () => {
      if (seq !== newest.current || next === lastStored.current) return;
      if (mounted.current) {
        setPhase("saving");
        setError(null);
      }
      try {
        await store(next);
        lastStored.current = next;
        if (mounted.current) setPhase("saved");
      } catch (err) {
        if (mounted.current) {
          setPhase("error");
          setError(err instanceof Error ? err.message : "Could not save.");
        }
      }
    });
  }, []);

  const cancelScheduled = useCallback(() => {
    window.clearTimeout(timer.current);
    scheduled.current = false;
    setPending(false);
  }, []);

  // Debounce while typing. The timer re-reads the newest value when it fires.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `value` restarts the debounce on every edit
  useEffect(() => {
    if (!dirty || !ready) {
      scheduled.current = false;
      setPending(false);
      return;
    }
    scheduled.current = true;
    setPending(true);
    timer.current = window.setTimeout(() => {
      cancelScheduled();
      const { value: next, dirty: isDirty, ready: isReady, save: store } = latest.current;
      if (isDirty && isReady) enqueue(next, store);
    }, delayMs);
    return () => window.clearTimeout(timer.current);
  }, [value, dirty, ready, delayMs, latest, enqueue, cancelScheduled]);

  // A commit reads the value after the render that produced it.
  useEffect(() => {
    if (commitTick === 0) return;
    const {
      value: next,
      dirty: isDirty,
      ready: r,
      readyOnCommit: rc,
      save: store,
    } = latest.current;
    if (!isDirty || !(r || rc)) return;
    cancelScheduled();
    enqueue(next, store);
  }, [commitTick, latest, enqueue, cancelScheduled]);

  // Leaving the step with a scheduled save stores it instead of dropping it,
  // through the same queue (so a remount, as in StrictMode, never saves twice).
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (!scheduled.current) return;
      scheduled.current = false;
      window.clearTimeout(timer.current);
      const { value: next, dirty: isDirty, ready: r, save: store } = latest.current;
      if (isDirty && r) enqueue(next, store);
    };
  }, [latest, enqueue]);

  useContinueHold(pending || phase === "saving" ? SAVING_REASON : null);

  const commit = useCallback(() => setCommitTick((t) => t + 1), []);

  let shown: AutosavePhase = phase;
  if (phase === "saving") shown = "saving";
  else if (pending) shown = "pending";
  else if (phase === "error") shown = "error";
  // Edited after the last save, but not valid yet: nothing is stored.
  else if (dirty && value !== lastStored.current) shown = "idle";

  return { phase: shown, error, commit };
}
