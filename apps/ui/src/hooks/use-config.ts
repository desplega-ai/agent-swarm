import { useQueryClient } from "@tanstack/react-query";
import { createContext, useCallback, useContext, useState } from "react";
import {
  addConnection as addStoredConnection,
  type Config,
  type Connection,
  getActiveConnection,
  getConnections,
  getDefaultConfig,
  isUserTokenApiKey,
  removeConnection as removeStoredConnection,
  resetConfig as resetStoredConfig,
  saveConfig,
  setActiveConnection,
  setEmbedConnection,
  updateConnection as updateStoredConnection,
} from "@/lib/config";
import { uiDeploymentConfig } from "@/lib/deployment-config";

export interface PendingConnection {
  apiUrl: string;
  apiKey: string;
}

export interface PendingIdentity {
  email?: string;
  name?: string;
}

export interface PendingApiUrlTrust {
  origin: string;
  allowed: boolean;
}

function isPrivateOrLoopbackHostname(hostname: string): boolean {
  const normalizedHostname = hostname.toLowerCase();
  const host =
    normalizedHostname.startsWith("[") && normalizedHostname.endsWith("]")
      ? normalizedHostname.slice(1, -1)
      : normalizedHostname;
  if (host === "localhost" || host.endsWith(".localhost") || host === "::1") return true;

  const ipv4Match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (ipv4Match) {
    const octets = ipv4Match.slice(1).map(Number);
    if (octets.some((octet) => octet > 255)) return false;
    return (
      octets[0] === 10 ||
      octets[0] === 127 ||
      (octets[0] === 172 && octets[1]! >= 16 && octets[1]! <= 31) ||
      (octets[0] === 192 && octets[1] === 168)
    );
  }

  if (!host.includes(":") || !/^[\da-f:.]+$/.test(host)) return false;
  try {
    new URL(`http://[${host}]/`);
  } catch {
    return false;
  }

  const firstHextet = Number.parseInt(host.split(":", 1)[0] || "0", 16);
  return (
    (firstHextet >= 0xfc00 && firstHextet <= 0xfdff) ||
    (firstHextet >= 0xfe80 && firstHextet <= 0xfebf)
  );
}

/** A deep-linked destination may receive credentials only over HTTPS or a private dev address. */
export function inspectPendingApiUrl(apiUrl: string): PendingApiUrlTrust {
  try {
    const url = new URL(apiUrl);
    const inputHostname =
      /^[a-z][\w+.-]*:\/\/(?:[^@/?#]*@)?(\[[^\]]+\]|[^:/?#]+)(?::\d+)?(?:[/?#]|$)/i.exec(
        apiUrl.trim(),
      )?.[1];
    return {
      origin: url.origin,
      allowed:
        !url.username &&
        !url.password &&
        (url.protocol === "https:" ||
          (url.protocol === "http:" &&
            !!inputHostname &&
            isPrivateOrLoopbackHostname(inputHostname))),
    };
  } catch {
    return { origin: apiUrl, allowed: false };
  }
}

export function pendingApiUrlSubmissionError(apiUrl: string, confirmed: boolean): string | null {
  if (!inspectPendingApiUrl(apiUrl).allowed) {
    return "Deep-linked API URLs must use HTTPS, except for private or loopback addresses.";
  }
  return confirmed ? null : "Confirm the destination before sending your API key.";
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
  /** True when build-time settings own the only available connection */
  connectionLocked: boolean;
  /** Pending connection from URL params (not yet saved) */
  pendingConnection: PendingConnection | null;
  /** API URL hint from an apiUrl-only deep link; never opens the naming modal. */
  pendingApiUrl: string | null;
  /** Clear the pending connection state */
  clearPendingConnection: () => void;
  /** Pending identity hint from URL params (?email=, ?name=) */
  pendingIdentity: PendingIdentity | null;
  /** Clear the pending identity state */
  clearPendingIdentity: () => void;
}

export const ConfigContext = createContext<ConfigContextValue | null>(null);

/**
 * Extract ?apiUrl=, ?apiKey=, ?email=, ?name= from the URL, strip them, and
 * return the pending connection, API URL, and identity hints. An apiUrl-only
 * link pre-fills the welcome form without becoming a pending connection. If a
 * connection with the given apiUrl+apiKey already exists, activate it and
 * return a null pendingConnection (the identity hint is still returned
 * separately).
 */
export function extractUrlParams(
  connections: Connection[],
  activateFn: (id: string) => void,
): {
  pendingConnection: PendingConnection | null;
  pendingApiUrl: string | null;
  pendingIdentity: PendingIdentity | null;
} {
  const params = new URLSearchParams(window.location.search);
  const apiUrl = params.get("apiUrl");
  const apiKey = params.get("apiKey");
  const email = params.get("email");
  const name = params.get("name");

  const hasAny =
    params.has("apiUrl") || params.has("apiKey") || params.has("email") || params.has("name");
  if (hasAny) {
    const url = new URL(window.location.href);
    url.searchParams.delete("apiUrl");
    url.searchParams.delete("apiKey");
    url.searchParams.delete("email");
    url.searchParams.delete("name");
    window.history.replaceState({}, "", url.toString());
  }

  const pendingIdentity: PendingIdentity | null =
    email || name
      ? {
          ...(email ? { email } : {}),
          ...(name ? { name } : {}),
        }
      : null;

  if (uiDeploymentConfig.apiUrl) {
    return {
      pendingConnection: null,
      pendingApiUrl: null,
      pendingIdentity: uiDeploymentConfig.userId ? null : pendingIdentity,
    };
  }

  if (!apiUrl) {
    return { pendingConnection: null, pendingApiUrl: null, pendingIdentity };
  }

  const normalizedUrl = apiUrl.replace(/\/+$/, "");

  if (!apiKey) {
    return { pendingConnection: null, pendingApiUrl: normalizedUrl, pendingIdentity };
  }

  const existing = connections.find(
    (c) => c.apiUrl.replace(/\/+$/, "") === normalizedUrl && c.apiKey === apiKey,
  );
  if (existing) {
    activateFn(existing.id);
    return { pendingConnection: null, pendingApiUrl: null, pendingIdentity };
  }

  // DES-771: a user-bound `aswt_` token arriving via URL params is the embed
  // handshake. Store it as the tab-local embed connection (sessionStorage) —
  // the ApiClient authenticates from stored connections and an embedded
  // iframe must not be interrupted by the "Name This Connection" modal.
  // Tab-local storage means two embeds on this origin holding different
  // tokens can never clobber each other, and the shared localStorage
  // connection list is never touched.
  if (isUserTokenApiKey(apiKey)) {
    let host = normalizedUrl;
    try {
      host = new URL(normalizedUrl).host;
    } catch {
      // Keep the raw URL as the label if it doesn't parse.
    }
    setEmbedConnection({ name: `embed:${host}`, apiUrl: normalizedUrl, apiKey });
    return { pendingConnection: null, pendingApiUrl: null, pendingIdentity };
  }

  return {
    pendingConnection: { apiUrl: normalizedUrl, apiKey },
    pendingApiUrl: null,
    pendingIdentity,
  };
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

  // Extract URL params on init — may set pendingConnection, pendingIdentity, or
  // activate an existing connection.
  const initialUrlParams = useState(() => {
    const initial = loadState();
    return extractUrlParams(initial.connections, (id) => {
      setActiveConnection(id);
      // State will be loaded fresh on next render
    });
  })[0];

  const [pendingConnection, setPendingConnection] = useState<PendingConnection | null>(
    initialUrlParams.pendingConnection,
  );
  const [pendingApiUrl, setPendingApiUrl] = useState<string | null>(initialUrlParams.pendingApiUrl);
  const [pendingIdentity, setPendingIdentity] = useState<PendingIdentity | null>(
    initialUrlParams.pendingIdentity,
  );

  // Re-load state if URL params activated an existing connection
  useState(() => {
    if (!pendingConnection) {
      setState(loadState());
    }
  });

  const clearPendingConnection = useCallback(() => {
    setPendingConnection(null);
  }, []);

  const clearPendingIdentity = useCallback(() => {
    setPendingIdentity(null);
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
    setPendingApiUrl(null);
    setPendingIdentity(null);
  }, [refreshState]);

  const isConfigured = !!config.apiKey;
  const connectionLocked = Boolean(uiDeploymentConfig.apiUrl);

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
    connectionLocked,
    pendingConnection,
    pendingApiUrl,
    clearPendingConnection,
    pendingIdentity,
    clearPendingIdentity,
  };
}

export function useConfig() {
  const context = useContext(ConfigContext);
  if (!context) {
    throw new Error("useConfig must be used within a ConfigProvider");
  }
  return context;
}
