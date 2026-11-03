import { useEffect, useSyncExternalStore } from "react";
import { useCurrentUser } from "@/contexts/current-user-context";
import { appSidebarStorageKey, createAppSidebarStore } from "@/lib/app-sidebar-preferences";
import { useConfig } from "./use-config";

const stores = new Map<string, ReturnType<typeof createAppSidebarStore>>();

export function useAppSidebarPreferences() {
  const { config } = useConfig();
  const { userId } = useCurrentUser();
  const key = appSidebarStorageKey(config.apiUrl, userId);
  let store = stores.get(key);
  if (!store) {
    let storage: Storage | undefined;
    try {
      storage = window.localStorage;
    } catch {}
    store = createAppSidebarStore(key, storage);
    stores.set(key, store);
  }
  const current = store;
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
  return { preferences, setPreferences: current.set };
}
