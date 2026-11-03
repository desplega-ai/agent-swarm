import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";
import { useCurrentUser } from "@/contexts/current-user-context";
import {
  type AppSidebarPreferences,
  appSidebarStorageKey,
  createAppSidebarRegistry,
} from "@/lib/app-sidebar-preferences";
import { useConfig } from "./use-config";

const scope = createAppSidebarRegistry();

export function useAppSidebarPreferences() {
  const { config } = useConfig();
  const { userId, state } = useCurrentUser();
  const isReady = state === "ready" && userId !== null;
  const key = appSidebarStorageKey(config.apiUrl, userId);
  const current = useMemo(() => {
    let storage: Storage | undefined;
    try {
      storage = window.localStorage;
    } catch {}
    return scope(key, storage);
  }, [key]);
  const preferences = useSyncExternalStore(
    current.subscribe,
    current.getSnapshot,
    current.getSnapshot,
  );
  useEffect(() => {
    const handler = (event: StorageEvent) => {
      if (event.key === key || event.key === null) current.receive(event.newValue);
    };
    window.addEventListener("storage", handler);
    return () => window.removeEventListener("storage", handler);
  }, [key, current]);
  const setPreferences = useCallback(
    (next: AppSidebarPreferences) => {
      if (isReady) current.set(next);
    },
    [current, isReady],
  );
  return { preferences, setPreferences, isReady };
}
