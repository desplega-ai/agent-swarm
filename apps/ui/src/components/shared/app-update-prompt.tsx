import { RefreshCw } from "lucide-react";
import { type ComponentType, lazy, useEffect } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  BUILD_ID_META_NAME,
  isChunkLoadError,
  parseBuildId,
  readDismissedBuildId,
  shouldPromptForVersion,
  VERSION_FILE_PATH,
  writeDismissedBuildId,
} from "@/lib/app-version";

const TOAST_ID = "app-update-available";
const CHECK_INTERVAL_MS = 5 * 60_000;
/** Focus and visibility events can fire in bursts; one fetch per window is enough. */
const MIN_CHECK_GAP_MS = 30_000;

let latestDeployedBuildId: string | null = null;
let lastCheckAt = 0;

function runningBuildId(): string | null {
  if (typeof document === "undefined") return null;
  return (
    document.querySelector<HTMLMetaElement>(`meta[name="${BUILD_ID_META_NAME}"]`)?.content || null
  );
}

function localStorageOrUndefined(): Storage | undefined {
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

function reloadPage() {
  window.location.reload();
}

/**
 * Shows the "new version" toast. Sonner dedupes by id, so repeated calls update
 * one toast instead of stacking. Closing it records the deployed build as
 * dismissed so later checks for that build stay quiet.
 */
export function showReloadPrompt() {
  toast("New version available", {
    id: TOAST_ID,
    duration: Number.POSITIVE_INFINITY,
    closeButton: true,
    description: (
      <span className="text-xs text-popover-foreground">
        Reload the page to use the latest dashboard.
      </span>
    ),
    action: { label: "Reload", onClick: reloadPage },
    onDismiss: () => {
      if (latestDeployedBuildId) {
        writeDismissedBuildId(localStorageOrUndefined(), latestDeployedBuildId);
      }
    },
  });
}

async function fetchDeployedBuildId(): Promise<string | null> {
  try {
    const res = await fetch(`${VERSION_FILE_PATH}?t=${Date.now()}`, { cache: "no-store" });
    if (!res.ok) return null;
    return parseBuildId(await res.json());
  } catch {
    // Offline, or a host that answers /version.json with HTML: no signal.
    return null;
  }
}

async function checkForNewVersion(running: string) {
  const now = Date.now();
  if (now - lastCheckAt < MIN_CHECK_GAP_MS) return;
  lastCheckAt = now;
  const deployed = await fetchDeployedBuildId();
  if (!deployed) return;
  latestDeployedBuildId = deployed;
  const dismissed = readDismissedBuildId(localStorageOrUndefined());
  if (shouldPromptForVersion({ running, deployed, dismissed })) showReloadPrompt();
}

/**
 * Called when a chunk of this build failed to load. The failure itself is proof
 * that a newer deploy replaced this one, so the prompt shows even if the user
 * dismissed it earlier. A version check also runs so a dismissal can record the
 * deployed id.
 */
export function reportStaleChunk() {
  showReloadPrompt();
  const running = runningBuildId();
  if (running) void checkForNewVersion(running);
}

/**
 * Polls `/version.json` on focus, on tab show, and every few minutes. Does
 * nothing on the dev server, where index.html carries no build id. Also turns
 * Vite's `vite:preloadError` into the reload prompt. It does not reload the page
 * itself: the user decides when.
 */
export function AppUpdateWatcher() {
  useEffect(() => {
    const onPreloadError = () => reportStaleChunk();
    window.addEventListener("vite:preloadError", onPreloadError);

    const running = runningBuildId();
    if (!running) {
      return () => window.removeEventListener("vite:preloadError", onPreloadError);
    }

    const check = () => {
      if (document.visibilityState === "visible") void checkForNewVersion(running);
    };
    const interval = window.setInterval(check, CHECK_INTERVAL_MS);
    window.addEventListener("focus", check);
    document.addEventListener("visibilitychange", check);
    return () => {
      window.removeEventListener("vite:preloadError", onPreloadError);
      window.clearInterval(interval);
      window.removeEventListener("focus", check);
      document.removeEventListener("visibilitychange", check);
    };
  }, []);

  return null;
}

/** Inline notice rendered in place of a page whose chunk is gone after a deploy. */
export function StaleVersionNotice() {
  return (
    <div className="flex min-h-[60vh] items-center justify-center p-6">
      <Card className="w-full max-w-md">
        <CardContent className="space-y-4 p-8 text-center">
          <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-status-info/10">
            <RefreshCw className="h-7 w-7 text-status-info" />
          </div>
          <div>
            <h2 className="text-lg font-semibold">New version available</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              The dashboard was updated since you opened it. Reload to open this page.
            </p>
          </div>
          <Button onClick={reloadPage} className="gap-1.5">
            <RefreshCw className="h-4 w-4" />
            Reload
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}

/**
 * `React.lazy` for routes. When the route's chunk belongs to a build that is no
 * longer deployed, it renders `StaleVersionNotice` inside the app shell and
 * shows the reload prompt instead of throwing to the error boundary. Other
 * import errors still throw.
 */
// biome-ignore lint/suspicious/noExplicitAny: mirrors React.lazy's own constraint
export function lazyRoute<T extends ComponentType<any>>(load: () => Promise<{ default: T }>) {
  return lazy(() =>
    load().catch((error: unknown) => {
      if (!isChunkLoadError(error)) throw error;
      reportStaleChunk();
      return { default: StaleVersionNotice as unknown as T };
    }),
  );
}
