import { generateSlug } from "./slugs";

const STORAGE_KEY = "agent-swarm-config";
const CONNECTIONS_KEY = "agent-swarm-connections";

export interface Config {
  apiUrl: string;
  apiKey: string;
}

export interface Connection {
  id: string;
  name: string;
  apiUrl: string;
  apiKey: string;
}

export interface MultiConfig {
  connections: Connection[];
  activeId: string | null;
}

const DEFAULT_CONFIG: Config = {
  apiUrl: "http://localhost:3013",
  apiKey: "",
};

function generateConnectionId(): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let result = "conn_";
  for (let i = 0; i < 8; i++) {
    result += chars[Math.floor(Math.random() * chars.length)];
  }
  return result;
}

function loadMultiConfig(): MultiConfig {
  try {
    const stored = localStorage.getItem(CONNECTIONS_KEY);
    if (stored) {
      return JSON.parse(stored);
    }
  } catch (e) {
    console.error("Failed to load connections:", e);
  }

  // Migrate from old single-config format
  try {
    const oldStored = localStorage.getItem(STORAGE_KEY);
    if (oldStored) {
      const oldConfig: Config = JSON.parse(oldStored);
      const connection: Connection = {
        id: generateConnectionId(),
        name: "default",
        apiUrl: oldConfig.apiUrl || DEFAULT_CONFIG.apiUrl,
        apiKey: oldConfig.apiKey || DEFAULT_CONFIG.apiKey,
      };
      const multi: MultiConfig = {
        connections: [connection],
        activeId: connection.id,
      };
      localStorage.setItem(CONNECTIONS_KEY, JSON.stringify(multi));
      localStorage.removeItem(STORAGE_KEY);
      return multi;
    }
  } catch (e) {
    console.error("Failed to migrate old config:", e);
  }

  return { connections: [], activeId: null };
}

function saveMultiConfig(multi: MultiConfig): void {
  localStorage.setItem(CONNECTIONS_KEY, JSON.stringify(multi));
}

/** Resolve activeId — fix orphaned references, auto-select first if needed. */
function resolveActiveId(multi: MultiConfig): MultiConfig {
  if (multi.connections.length === 0) {
    return { ...multi, activeId: null };
  }
  const exists = multi.connections.some((c) => c.id === multi.activeId);
  if (!exists) {
    return { ...multi, activeId: multi.connections[0].id };
  }
  return multi;
}

// ---------------------------------------------------------------------------
// Multi-connection CRUD
// ---------------------------------------------------------------------------

export function getConnections(): Connection[] {
  const multi = resolveActiveId(loadMultiConfig());
  return multi.connections;
}

export function addConnection(conn: Omit<Connection, "id"> & { id?: string }): Connection {
  const multi = resolveActiveId(loadMultiConfig());
  const connection: Connection = {
    id: conn.id || generateConnectionId(),
    name: conn.name || generateSlug(),
    apiUrl: conn.apiUrl,
    apiKey: conn.apiKey,
  };
  multi.connections.push(connection);
  // If this is the first connection, auto-activate it
  if (multi.connections.length === 1) {
    multi.activeId = connection.id;
  }
  saveMultiConfig(multi);
  return connection;
}

export function updateConnection(
  id: string,
  updates: Partial<Omit<Connection, "id">>,
): Connection | null {
  const multi = resolveActiveId(loadMultiConfig());
  const idx = multi.connections.findIndex((c) => c.id === id);
  if (idx === -1) return null;
  multi.connections[idx] = { ...multi.connections[idx], ...updates };
  saveMultiConfig(multi);
  return multi.connections[idx];
}

export function removeConnection(id: string): boolean {
  const multi = resolveActiveId(loadMultiConfig());
  const idx = multi.connections.findIndex((c) => c.id === id);
  if (idx === -1) return false;
  multi.connections.splice(idx, 1);
  // Fix activeId if we removed the active connection
  if (multi.activeId === id) {
    multi.activeId = multi.connections.length > 0 ? multi.connections[0].id : null;
  }
  saveMultiConfig(multi);
  return true;
}

export function getActiveConnection(): Connection | null {
  const multi = resolveActiveId(loadMultiConfig());
  if (!multi.activeId) return null;
  return multi.connections.find((c) => c.id === multi.activeId) ?? null;
}

export function setActiveConnection(id: string): boolean {
  const multi = loadMultiConfig();
  const exists = multi.connections.some((c) => c.id === id);
  if (!exists) return false;
  multi.activeId = id;
  saveMultiConfig(multi);
  return true;
}

// ---------------------------------------------------------------------------
// Backward-compatible API (used by ApiClient and useConfig)
// ---------------------------------------------------------------------------

export function getConfig(): Config {
  const active = getActiveConnection();
  if (active) {
    return { apiUrl: active.apiUrl, apiKey: active.apiKey };
  }
  return { ...DEFAULT_CONFIG };
}

export function saveConfig(config: Config): void {
  const active = getActiveConnection();
  if (active) {
    updateConnection(active.id, { apiUrl: config.apiUrl, apiKey: config.apiKey });
  } else {
    // No connections yet — create one
    addConnection({
      name: generateSlug(),
      apiUrl: config.apiUrl,
      apiKey: config.apiKey,
    });
  }
}

export function resetConfig(): void {
  localStorage.removeItem(STORAGE_KEY);
  localStorage.removeItem(CONNECTIONS_KEY);
}

export function getDefaultConfig(): Config {
  return { ...DEFAULT_CONFIG };
}
