/**
 * Returns `value` delayed by `delayMs`. The returned value updates only after
 * the input has been stable for the delay period — useful for debouncing
 * keystrokes before issuing API calls.
 */
import { useEffect, useState } from "react";

export function useDebouncedValue<T>(value: T, delayMs = 200): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const id = window.setTimeout(() => setDebounced(value), delayMs);
    return () => window.clearTimeout(id);
  }, [value, delayMs]);
  return debounced;
}
