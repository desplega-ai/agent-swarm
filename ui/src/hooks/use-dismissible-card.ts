/**
 * Phase 4: Per-user UX persistence via browser localStorage.
 *
 * Returns a `{ dismissed, dismiss, restore }` triple keyed by an opaque
 * `cardKey` (e.g. `"home-welcome"`, `"setup:row:harness"`). Storage is
 * namespaced by the active deployment's `apiUrl` so dismissing on swarm A
 * does not bleed into swarm B when the same UI bundle is pointed at
 * different APIs via `?apiUrl=…`.
 *
 * Storage key format: `swarm:v1:${apiUrl}:${cardKey}`. The `v1` segment
 * lets us bump the format later without colliding with old keys.
 *
 * Contract:
 *   - `localStorage` access is wrapped in `try/catch` — environments without
 *     working storage (privacy mode, SSR though we are Vite-only) degrade
 *     to in-memory state and simply don't persist.
 *   - Cross-tab sync via the `storage` event: dismiss in one tab → other
 *     tabs of the same deployment update on next render.
 */

import { useCallback, useEffect, useState } from "react";
import { useConfig } from "./use-config";
import { deriveStorageKey } from "./use-dismissible-card-key";

export { deriveStorageKey };

function readDismissed(storageKey: string): boolean {
  try {
    return localStorage.getItem(storageKey) === "1";
  } catch {
    return false;
  }
}

export interface UseDismissibleCardResult {
  dismissed: boolean;
  dismiss: () => void;
  restore: () => void;
}

export function useDismissibleCard(cardKey: string): UseDismissibleCardResult {
  const { config } = useConfig();
  const storageKey = deriveStorageKey(config.apiUrl, cardKey);

  const [dismissed, setDismissed] = useState<boolean>(() => readDismissed(storageKey));

  // Re-sync state when storageKey changes (e.g. user switches connections).
  // Without this, the in-memory `dismissed` would stay tied to the previous
  // apiUrl until a remount.
  useEffect(() => {
    setDismissed(readDismissed(storageKey));
  }, [storageKey]);

  const dismiss = useCallback(() => {
    try {
      localStorage.setItem(storageKey, "1");
    } catch {
      // Defensive: if storage is unavailable, the in-memory flip below
      // still gives the user the visual dismiss for this session.
    }
    setDismissed(true);
  }, [storageKey]);

  const restore = useCallback(() => {
    try {
      localStorage.removeItem(storageKey);
    } catch {
      // See dismiss() comment.
    }
    setDismissed(false);
  }, [storageKey]);

  // Cross-tab sync: a `storage` event fires in OTHER tabs of the same origin
  // when localStorage changes. We listen and reflect the new value.
  useEffect(() => {
    const handler = (e: StorageEvent) => {
      if (e.key !== storageKey) return;
      // newValue === null means the key was removed (restore in another tab).
      setDismissed(e.newValue === "1");
    };
    window.addEventListener("storage", handler);
    return () => window.removeEventListener("storage", handler);
  }, [storageKey]);

  return { dismissed, dismiss, restore };
}
