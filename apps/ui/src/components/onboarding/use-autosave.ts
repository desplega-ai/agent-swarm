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
 * Autosave for `/setup` fields: no Save buttons. A field stores itself after
 * the operator stops typing (debounce), or at once on a commit (blur, paste,
 * a swatch click). Only valid values are stored.
 *
 * `pending` = a debounced save is scheduled. `saved` = the last save in this
 * session succeeded and the field still shows that value.
 */
export type AutosavePhase = "idle" | "pending" | "saving" | "saved" | "error";

const SAVING_REASON = "Saving…";

/** Default debounce: store about 800 ms after typing stops. */
export const AUTOSAVE_DELAY_MS = 800;

interface AutosaveScopeValue {
  setBusy: (id: string, busy: boolean) => void;
}

/**
 * Every autosave field inside a step reports here, so the step can hold the
 * shell's Continue while any save is scheduled or in flight.
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
 * Releases on unmount.
 */
export function useContinueBlocker(
  setContinueBlocker: (reason: string | null) => void,
  reason: string | null,
) {
  // The shell may pass a new function on each render. A ref keeps the effects
  // below from firing on identity changes (that would loop through its state).
  const blocker = useLatest(setContinueBlocker);
  useEffect(() => {
    blocker.current(reason);
  }, [reason, blocker]);
  useEffect(() => () => blocker.current(null), [blocker]);
}

/**
 * Step-level scope. Provide the result through `AutosaveScopeContext` around
 * the step body. Holds Continue with "Saving…" while any field saves.
 */
export function useAutosaveScope(
  setContinueBlocker: (reason: string | null) => void,
): AutosaveScopeValue {
  const [busyIds, setBusyIds] = useState<ReadonlySet<string>>(() => new Set());

  const setBusy = useCallback((id: string, busy: boolean) => {
    setBusyIds((prev) => {
      if (prev.has(id) === busy) return prev;
      const next = new Set(prev);
      if (busy) next.add(id);
      else next.delete(id);
      return next;
    });
  }, []);

  useContinueBlocker(setContinueBlocker, busyIds.size > 0 ? SAVING_REASON : null);

  return useMemo(() => ({ setBusy }), [setBusy]);
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
   * Use it for values that must not store half-typed, such as a key with no
   * known prefix.
   */
  readyOnCommit?: boolean;
  /** Store the value. Throw to show the error state. */
  save: (value: string) => Promise<void>;
  delayMs?: number;
}

export interface Autosave {
  phase: AutosavePhase;
  error: string | null;
  /** Store now when the value is valid (blur, paste, a click on a swatch). */
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
  const scope = useContext(AutosaveScopeContext);
  const id = useId();
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
  const mounted = useRef(true);

  // Saves run one after another and always store the newest value.
  const run = useCallback(() => {
    window.clearTimeout(timer.current);
    scheduled.current = false;
    setPending(false);
    chain.current = chain.current.then(async () => {
      const { value: next, dirty: isDirty, save: store } = latest.current;
      if (!isDirty || next === lastStored.current) return;
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
  }, [latest]);

  // Debounce while typing.
  useEffect(() => {
    if (!dirty || !ready || value === lastStored.current) {
      scheduled.current = false;
      setPending(false);
      return;
    }
    scheduled.current = true;
    setPending(true);
    timer.current = window.setTimeout(run, delayMs);
    return () => window.clearTimeout(timer.current);
  }, [value, dirty, ready, delayMs, run]);

  // A commit reads the value after the render that produced it.
  useEffect(() => {
    if (commitTick === 0) return;
    const { value: next, dirty: isDirty, ready: r, readyOnCommit: rc } = latest.current;
    if (!isDirty || !(r || rc) || next === lastStored.current) return;
    run();
  }, [commitTick, latest, run]);

  // Leaving the step with a scheduled save stores it instead of dropping it.
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (!scheduled.current) return;
      scheduled.current = false;
      window.clearTimeout(timer.current);
      const { value: next, dirty: isDirty, ready: r, save: store } = latest.current;
      if (isDirty && r && next !== lastStored.current) store(next).catch(() => undefined);
    };
  }, [latest]);

  const busy = pending || phase === "saving";
  useEffect(() => {
    scope?.setBusy(id, busy);
  }, [scope, id, busy]);
  useEffect(() => () => scope?.setBusy(id, false), [scope, id]);

  const commit = useCallback(() => setCommitTick((t) => t + 1), []);

  let shown: AutosavePhase = phase;
  if (phase === "saving") shown = "saving";
  else if (pending) shown = "pending";
  else if (phase === "error") shown = "error";
  // Edited after the last save, but not valid yet: nothing is stored.
  else if (dirty && value !== lastStored.current) shown = "idle";

  return { phase: shown, error, commit };
}
