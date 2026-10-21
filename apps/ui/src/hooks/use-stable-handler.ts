import { useCallback, useLayoutEffect, useRef } from "react";

/**
 * A handler with a stable identity that always runs the latest `handler`.
 * Pass it to memoized rows, so a parent render does not re-render them.
 * Call it from events only, never during render.
 */
export function useStableHandler<Args extends unknown[], Result>(
  handler: (...args: Args) => Result,
): (...args: Args) => Result {
  const latest = useRef(handler);
  useLayoutEffect(() => {
    latest.current = handler;
  });
  return useCallback((...args: Args) => latest.current(...args), []);
}
