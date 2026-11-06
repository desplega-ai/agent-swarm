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
