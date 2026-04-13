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

export interface PendingConnection {
  apiUrl: string;
  apiKey: string;
}

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
  /** Pending connection from URL params (not yet saved) */
  pendingConnection: PendingConnection | null;
  /** Clear the pending connection state */
  clearPendingConnection: () => void;
}

export const ConfigContext = createContext<ConfigContextValue | null>(null);

/**
 * Extract ?apiUrl= and ?apiKey= from the URL, strip them, and return values if both present.
 * If a matching connection already exists, activate it and return null.
 */
function extractUrlParams(
  connections: Connection[],
  activateFn: (id: string) => void,
): PendingConnection | null {
  const params = new URLSearchParams(window.location.search);
  const apiUrl = params.get("apiUrl");
  const apiKey = params.get("apiKey");

  // Always strip the params from the URL
  if (params.has("apiUrl") || params.has("apiKey")) {
    const url = new URL(window.location.href);
    url.searchParams.delete("apiUrl");
    url.searchParams.delete("apiKey");
    window.history.replaceState({}, "", url.toString());
  }

  // Only act if we have both values
  if (!apiUrl || !apiKey) return null;

  const normalizedUrl = apiUrl.replace(/\/+$/, "");

  // Check if a connection with matching URL+key already exists
  const existing = connections.find(
    (c) => c.apiUrl.replace(/\/+$/, "") === normalizedUrl && c.apiKey === apiKey,
  );
  if (existing) {
    activateFn(existing.id);
    return null;
  }

  return { apiUrl: normalizedUrl, apiKey };
}

function loadState(): { connections: Connection[]; activeConnection: Connection | null } {
  const connections = getConnections();
  const activeConnection = getActiveConnection();
  return { connections, activeConnection };
}

export function useConfigProvider() {
  const [state, setState] = useState(loadState);
  const queryClient = useQueryClient();

  const refreshState = useCallback(() => {
    setState(loadState());
  }, []);

  // Extract URL params on init — may set pendingConnection or activate an existing one
  const [pendingConnection, setPendingConnection] = useState<PendingConnection | null>(() => {
    const initial = loadState();
    return extractUrlParams(initial.connections, (id) => {
      setActiveConnection(id);
      // State will be loaded fresh on next render
    });
  });

  // Re-load state if URL params activated an existing connection
  useState(() => {
    if (!pendingConnection) {
      setState(loadState());
    }
  });

  const clearPendingConnection = useCallback(() => {
    setPendingConnection(null);
  }, []);

  // If there's a pending connection, use its credentials for the config
  const config: Config = pendingConnection
    ? { apiUrl: pendingConnection.apiUrl, apiKey: pendingConnection.apiKey }
    : state.activeConnection
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
    setPendingConnection(null);
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
    pendingConnection,
    clearPendingConnection,
  };
}

export function useConfig() {
  const context = useContext(ConfigContext);
  if (!context) {
    throw new Error("useConfig must be used within a ConfigProvider");
  }
  return context;
}
