import { useSyncExternalStore } from "react";
import { type PaletteConnection, paletteIdentity } from "./identity";

/** Another tab wrote storage: it may have switched the user or the swarm. */
function subscribe(onChange: () => void): () => void {
  window.addEventListener("storage", onChange);
  return () => window.removeEventListener("storage", onChange);
}

/**
 * The palette's identity, re-read on every render and after a storage write
 * in another tab, so a user switch there reaches an open palette here.
 */
export function usePaletteIdentity(connection: () => PaletteConnection): string {
  return useSyncExternalStore(subscribe, () => paletteIdentity(connection()));
}
