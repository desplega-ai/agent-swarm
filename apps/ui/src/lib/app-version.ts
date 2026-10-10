/**
 * New-deploy detection for the dashboard.
 *
 * A production build stamps a content-derived build id into `index.html`
 * (`<meta name="app-build-id">`) and writes the same id to `/version.json`
 * (see `buildVersionManifest` in vite.config.ts). The running tab compares its
 * own id with the deployed one and, when they differ, offers a reload instead
 * of letting a lazy route request a chunk the new deploy no longer has.
 */

export const BUILD_ID_META_NAME = "app-build-id";
export const VERSION_FILE_PATH = "/version.json";
export const DISMISSED_BUILD_ID_STORAGE_KEY = "agent-swarm:dismissed-build-id";

/** Reads `buildId` from a parsed `/version.json` body; anything else is null. */
export function parseBuildId(body: unknown): string | null {
  if (typeof body !== "object" || body === null) return null;
  const id = (body as { buildId?: unknown }).buildId;
  return typeof id === "string" && id.trim() !== "" ? id.trim() : null;
}

/**
 * Prompt only when the deployed build differs from the one this tab runs AND
 * the user has not already dismissed the prompt for that deployed build.
 */
export function shouldPromptForVersion(args: {
  running: string | null;
  deployed: string | null;
  dismissed: string | null;
}): boolean {
  const { running, deployed, dismissed } = args;
  if (!running || !deployed) return false;
  if (deployed === running) return false;
  return deployed !== dismissed;
}

const CHUNK_ERROR_PATTERNS = [
  // Chromium
  "Failed to fetch dynamically imported module",
  // Firefox
  "error loading dynamically imported module",
  // Safari / WebKit
  "Importing a module script failed",
  // A missing chunk served as the SPA's index.html instead of a 404.
  "is not a valid JavaScript MIME type",
  "Failed to load module script",
  // Vite's preload helper (`vite:preloadError`) for a route's CSS.
  "Unable to preload CSS",
];

/** True when an error means a lazily loaded chunk of an older build is gone. */
export function isChunkLoadError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.name === "ChunkLoadError") return true;
  const msg = error.message;
  if (CHUNK_ERROR_PATTERNS.some((pattern) => msg.includes(pattern))) return true;
  return /Loading (CSS )?chunk .* failed/i.test(msg);
}

type StorageLike = Pick<Storage, "getItem" | "setItem">;

/** Storage can throw (Safari private mode, blocked cookies); treat that as empty. */
export function readDismissedBuildId(storage: StorageLike | undefined): string | null {
  try {
    return storage?.getItem(DISMISSED_BUILD_ID_STORAGE_KEY) ?? null;
  } catch {
    return null;
  }
}

export function writeDismissedBuildId(storage: StorageLike | undefined, buildId: string): void {
  try {
    storage?.setItem(DISMISSED_BUILD_ID_STORAGE_KEY, buildId);
  } catch {
    // Best effort: without storage the prompt can return on the next check.
  }
}
