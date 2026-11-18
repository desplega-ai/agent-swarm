/**
 * The bundled models.dev snapshot (`modelsdev-cache.json`, ~7 MB of JSON),
 * loaded on first use instead of in the entry chunk. The live catalog
 * (`GET /api/models-catalog`) is the picker's main source; this snapshot is
 * its fallback and covers the providers the live catalog does not carry.
 *
 * Until `loadModelsSnapshot()` resolves, `modelsSnapshot()` returns null and
 * `agent-runtime-models` reads only the registry sections. `useModelsCatalog`
 * starts the load, re-renders its callers when it lands and hands them a new
 * `providers` object, so memos keyed on it recompute. A test that reads
 * snapshot models awaits `loadModelsSnapshot()` first.
 *
 * No React import here: backend unit tests import `agent-runtime-models` by
 * relative path.
 */

export type ModelsSnapshot = Record<string, unknown>;

let snapshot: ModelsSnapshot | null = null;
let pending: Promise<ModelsSnapshot> | null = null;
const listeners = new Set<() => void>();

/** The loaded snapshot, or null before `loadModelsSnapshot()` resolves. */
export function modelsSnapshot(): ModelsSnapshot | null {
  return snapshot;
}

/** Loads the snapshot once; later calls share the same promise. */
export function loadModelsSnapshot(): Promise<ModelsSnapshot> {
  pending ??= import("./modelsdev-cache.json").then(
    (mod) => {
      snapshot = mod.default as unknown as ModelsSnapshot;
      for (const listener of listeners) listener();
      return snapshot;
    },
    (error: unknown) => {
      // A failed chunk load (a deploy replaced it) may retry on the next call.
      pending = null;
      throw error;
    },
  );
  return pending;
}

/**
 * Tests only: forget the loaded snapshot, so a test can replay a cold load in a
 * `bun test` process where another file already loaded it.
 */
export function resetModelsSnapshotForTests(): void {
  snapshot = null;
  pending = null;
}

/** `useSyncExternalStore` subscription: fires once, when the snapshot lands. */
export function subscribeModelsSnapshot(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
