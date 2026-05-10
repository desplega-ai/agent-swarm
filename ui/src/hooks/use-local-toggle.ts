/**
 * Per-deployment boolean toggle persisted in `localStorage`. Mirror of
 * `useDismissibleCard` but for plain on/off semantics — generic toggles
 * like "show internal handoffs" in the sessions surface.
 *
 * Storage key format: `swarm:v1:${apiUrl}:${toggleKey}` — same namespace
 * as `use-dismissible-card`, so swapping deployments via `?apiUrl=…`
 * doesn't bleed preferences between swarms.
 */

import { useCallback, useEffect, useState } from "react";
import { useConfig } from "./use-config";
import { deriveStorageKey } from "./use-dismissible-card-key";

function readBool(storageKey: string, fallback: boolean): boolean {
  try {
    const v = localStorage.getItem(storageKey);
    if (v === null) return fallback;
    return v === "1";
  } catch {
    return fallback;
  }
}

export function useLocalToggle(
  toggleKey: string,
  defaultValue: boolean,
): [boolean, (next: boolean) => void] {
  const { config } = useConfig();
  const storageKey = deriveStorageKey(config.apiUrl, toggleKey);
  const [value, setValue] = useState<boolean>(() => readBool(storageKey, defaultValue));

  useEffect(() => {
    setValue(readBool(storageKey, defaultValue));
  }, [storageKey, defaultValue]);

  const set = useCallback(
    (next: boolean) => {
      try {
        localStorage.setItem(storageKey, next ? "1" : "0");
      } catch {
        // Defensive: storage unavailable → in-memory flip below still works.
      }
      setValue(next);
    },
    [storageKey],
  );

  useEffect(() => {
    const handler = (e: StorageEvent) => {
      if (e.key !== storageKey) return;
      if (e.newValue === null) setValue(defaultValue);
      else setValue(e.newValue === "1");
    };
    window.addEventListener("storage", handler);
    return () => window.removeEventListener("storage", handler);
  }, [storageKey, defaultValue]);

  return [value, set];
}
