export type AppSidebarMode = "all" | "selected" | "hidden";

export interface AppSidebarPreferences {
  mode: AppSidebarMode;
  selectedIds: string[];
}

const DEFAULT_PREFERENCES: AppSidebarPreferences = { mode: "all", selectedIds: [] };

export function parseAppSidebarPreferences(raw: string | null): AppSidebarPreferences {
  try {
    const value = JSON.parse(raw ?? "null");
    if (!value || !["all", "selected", "hidden"].includes(value.mode)) return DEFAULT_PREFERENCES;
    return {
      mode: value.mode,
      selectedIds: Array.isArray(value.selectedIds)
        ? [...new Set<string>(value.selectedIds.filter((id: unknown) => typeof id === "string"))]
        : [],
    };
  } catch {
    return DEFAULT_PREFERENCES;
  }
}

export function appSidebarStorageKey(apiUrl: string, userId: string | null): string {
  return `swarm:v1:apps-sidebar:${JSON.stringify([apiUrl.replace(/\/+$/, ""), userId])}`;
}

export function visibleSidebarApps<T extends { id: string; name: string }>(
  apps: readonly T[],
  preferences: AppSidebarPreferences,
): T[] {
  if (preferences.mode === "hidden") return [];
  const selected = new Set(preferences.selectedIds);
  return apps
    .filter((app) => preferences.mode === "all" || selected.has(app.id))
    .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}

export function createAppSidebarStore(key: string, storage?: Pick<Storage, "getItem" | "setItem">) {
  let initial: string | null = null;
  try {
    initial = storage?.getItem(key) ?? null;
  } catch {}
  let snapshot = parseAppSidebarPreferences(initial);
  let lastRead = initial;
  let storageDisabled = storage === undefined;
  const listeners = new Set<() => void>();
  const receive = (raw: string | null) => {
    lastRead = raw;
    snapshot = parseAppSidebarPreferences(raw);
    for (const listener of listeners) listener();
  };
  return {
    getSnapshot: () => {
      if (!storageDisabled) {
        try {
          const raw = storage?.getItem(key) ?? null;
          if (raw !== lastRead) {
            lastRead = raw;
            snapshot = parseAppSidebarPreferences(raw);
          }
        } catch {}
      }
      return snapshot;
    },
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    receive,
    set: (preferences: AppSidebarPreferences) => {
      const raw = JSON.stringify(preferences);
      try {
        storage?.setItem(key, raw);
      } catch {
        storageDisabled = true;
      }
      receive(raw);
    },
  };
}
