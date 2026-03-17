import { useQueryClient } from "@tanstack/react-query";
import { createContext, useCallback, useContext, useState } from "react";
import {
  addConnection as addStoredConnection,
  type Config,
  type Connection,
  getActiveConnection,
  getConnections,
  getDefaultConfig,
  removeConnection as removeStoredConnection,
  resetConfig as resetStoredConfig,
  saveConfig,
  setActiveConnection,
  updateConnection as updateStoredConnection,
} from "@/lib/config";

interface ConfigContextValue {
  /** All saved connections */
  connections: Connection[];
  /** Currently active connection (null if none) */
  activeConnection: Connection | null;
  /** Derived Config from the active connection (backward compat) */
  config: Config;
  /** Switch to a different connection by ID — clears all react-query caches */
  switchConnection: (id: string) => void;
  /** Add a new connection, returns the created Connection */
  addConnection: (conn: Omit<Connection, "id">) => Connection;
  /** Update an existing connection by ID */
  updateConnection: (id: string, updates: Partial<Omit<Connection, "id">>) => void;
  /** Remove a connection by ID */
  removeConnection: (id: string) => void;
  /** Update the active connection's config (backward compat) */
  setConfig: (config: Config) => void;
  /** Reset all connections and config */
  resetConfig: () => void;
  /** True if active connection has an apiKey */
  isConfigured: boolean;
}

export const ConfigContext = createContext<ConfigContextValue | null>(null);

/** Strip ?apiUrl= and ?apiKey= from the URL without acting on them (deferred to Phase 4). */
function stripUrlParams(): void {
  const params = new URLSearchParams(window.location.search);
  if (params.has("apiUrl") || params.has("apiKey")) {
    const url = new URL(window.location.href);
    url.searchParams.delete("apiUrl");
    url.searchParams.delete("apiKey");
    window.history.replaceState({}, "", url.toString());
  }
}

function loadState(): { connections: Connection[]; activeConnection: Connection | null } {
  const connections = getConnections();
  const activeConnection = getActiveConnection();
  return { connections, activeConnection };
}

export function useConfigProvider() {
  // Strip URL params on init (Phase 4 will create connections from them)
  useState(() => {
    stripUrlParams();
  });

  const [state, setState] = useState(loadState);
  const queryClient = useQueryClient();

  const refreshState = useCallback(() => {
    setState(loadState());
  }, []);

  const config: Config = state.activeConnection
    ? { apiUrl: state.activeConnection.apiUrl, apiKey: state.activeConnection.apiKey }
    : getDefaultConfig();

  const switchConnection = useCallback(
    (id: string) => {
      setActiveConnection(id);
      refreshState();
      queryClient.resetQueries();
    },
    [refreshState, queryClient],
  );

  const addConnection = useCallback(
    (conn: Omit<Connection, "id">): Connection => {
      const created = addStoredConnection(conn);
      refreshState();
      return created;
    },
    [refreshState],
  );

  const updateConnection = useCallback(
    (id: string, updates: Partial<Omit<Connection, "id">>): void => {
      updateStoredConnection(id, updates);
      refreshState();
    },
    [refreshState],
  );

  const removeConnection = useCallback(
    (id: string): void => {
      removeStoredConnection(id);
      refreshState();
      // If we removed the active connection, caches are stale
      queryClient.resetQueries();
    },
    [refreshState, queryClient],
  );

  const setConfig = useCallback(
    (newConfig: Config) => {
      saveConfig(newConfig);
      refreshState();
    },
    [refreshState],
  );

  const resetConfig = useCallback(() => {
    resetStoredConfig();
    refreshState();
  }, [refreshState]);

  const isConfigured = !!config.apiKey;

  return {
    connections: state.connections,
    activeConnection: state.activeConnection,
    config,
    switchConnection,
    addConnection,
    updateConnection,
    removeConnection,
    setConfig,
    resetConfig,
    isConfigured,
  };
}

export function useConfig() {
  const context = useContext(ConfigContext);
  if (!context) {
    throw new Error("useConfig must be used within a ConfigProvider");
  }
  return context;
}
