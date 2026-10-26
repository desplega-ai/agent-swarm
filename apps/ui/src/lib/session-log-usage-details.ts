// Session log "Usage details": the power-user token view. Off by default,
// stored in this browser. On, the log shows each LLM call's cache hit and
// prompt size, and the result card and the task rail show the session's
// cache hit. Later token views (the prompt composition breakdown) sit behind
// the same switch.
//
// Relative imports only: `bun:test` runs this from the repo root.

import { useSyncExternalStore } from "react";

const KEY = "swarm:v1:session-log:usage-details";

// One store for every hook instance in this tab (the log toolbar and the
// task rail), plus the `storage` event for other tabs.
const listeners = new Set<() => void>();
let memory = false;

function subscribe(listener: () => void) {
  listeners.add(listener);
  window.addEventListener("storage", listener);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", listener);
  };
}

/** Whether usage details show: the stored preference, else off. */
export function getUsageDetails(): boolean {
  try {
    const stored = localStorage.getItem(KEY);
    if (stored === "on") return true;
    if (stored === "off") return false;
  } catch {
    // Storage unavailable: the in-memory value still works.
  }
  return memory;
}

export function setUsageDetails(next: boolean) {
  memory = next;
  try {
    localStorage.setItem(KEY, next ? "on" : "off");
  } catch {
    // Storage unavailable: the in-memory value still changes.
  }
  for (const listener of listeners) listener();
}

/** The preference, re-rendering on a change from any tab. */
export function useUsageDetails(): [boolean, (next: boolean) => void] {
  const on = useSyncExternalStore(subscribe, getUsageDetails, () => false);
  return [on, setUsageDetails];
}
