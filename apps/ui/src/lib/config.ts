import { isDemoMode, uiDeploymentConfig } from "./deployment-config";
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

export const DEPLOYMENT_CONNECTION_ID = "deployment";

function getDeploymentConnection(): Connection | null {
  if (!uiDeploymentConfig.apiUrl || !uiDeploymentConfig.apiKey) return null;

  let name = uiDeploymentConfig.apiUrl;
  try {
    name = new URL(uiDeploymentConfig.apiUrl).host;
  } catch {
    // Keep the configured URL as the label when it is not absolute.
  }

  return {
    id: DEPLOYMENT_CONNECTION_ID,
    name: isDemoMode ? "Demo swarm" : name,
    apiUrl: uiDeploymentConfig.apiUrl,
    apiKey: uiDeploymentConfig.apiKey,
  };
}

function assertConnectionsMutable(): void {
  if (getDeploymentConnection()) {
    throw new Error("Connections are managed by this UI deployment.");
  }
}

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

// ---------------------------------------------------------------------------
// Embed connection (DES-771)
// ---------------------------------------------------------------------------

/**
 * Tab-local connection for embedded dashboards (user-bound `aswt_` tokens
 * arriving via URL params). Lives in **sessionStorage** — not the shared
 * localStorage connection list, so two embeds on the same UI origin holding
 * different user tokens can never clobber each other's credentials. The token
 * does not outlive the tab. When no deployment connection exists, it takes
 * precedence over the localStorage `activeId` everywhere.
 */
export const EMBED_CONNECTION_ID = "embed";
const EMBED_KEY = "agent-swarm-embed-connection";

export function getEmbedConnection(): Connection | null {
  try {
    const raw = sessionStorage.getItem(EMBED_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<Connection>;
    if (!parsed.apiUrl || !parsed.apiKey) return null;
    return {
      id: EMBED_CONNECTION_ID,
      name: parsed.name || "embed",
      apiUrl: parsed.apiUrl,
      apiKey: parsed.apiKey,
    };
  } catch {
    return null;
  }
}

export function setEmbedConnection(conn: Omit<Connection, "id">): Connection {
  const connection: Connection = { id: EMBED_CONNECTION_ID, ...conn };
  try {
    sessionStorage.setItem(EMBED_KEY, JSON.stringify(connection));
  } catch {
    // Storage unavailable — callers' in-memory state still drives this
    // session; API calls fall back to the localStorage connection.
  }
  return connection;
}

export function clearEmbedConnection(): void {
  try {
    sessionStorage.removeItem(EMBED_KEY);
  } catch {
    // Nothing to clear if storage is unavailable.
  }
}

export function getConnections(): Connection[] {
  const deployment = getDeploymentConnection();
  if (deployment) return [deployment];
  const multi = resolveActiveId(loadMultiConfig());
  const embed = getEmbedConnection();
  return embed ? [embed, ...multi.connections] : multi.connections;
}

export function addConnection(conn: Omit<Connection, "id"> & { id?: string }): Connection {
  assertConnectionsMutable();
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
  assertConnectionsMutable();
  if (id === EMBED_CONNECTION_ID) {
    const embed = getEmbedConnection();
    if (!embed) return null;
    return setEmbedConnection({ ...embed, ...updates });
  }
  const multi = resolveActiveId(loadMultiConfig());
  const idx = multi.connections.findIndex((c) => c.id === id);
  if (idx === -1) return null;
  multi.connections[idx] = { ...multi.connections[idx], ...updates };
  saveMultiConfig(multi);
  return multi.connections[idx];
}

export function removeConnection(id: string): boolean {
  assertConnectionsMutable();
  if (id === EMBED_CONNECTION_ID) {
    const existed = getEmbedConnection() !== null;
    clearEmbedConnection();
    return existed;
  }
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
  const deployment = getDeploymentConnection();
  if (deployment) return deployment;
  const embed = getEmbedConnection();
  if (embed) return embed;
  const multi = resolveActiveId(loadMultiConfig());
  if (!multi.activeId) return null;
  return multi.connections.find((c) => c.id === multi.activeId) ?? null;
}

export function setActiveConnection(id: string): boolean {
  const deployment = getDeploymentConnection();
  if (deployment) return id === deployment.id;
  if (id === EMBED_CONNECTION_ID) {
    return getEmbedConnection() !== null;
  }
  const multi = loadMultiConfig();
  const exists = multi.connections.some((c) => c.id === id);
  if (!exists) return false;
  // Activating a saved connection is an explicit choice to leave the
  // tab-local embed session.
  clearEmbedConnection();
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
  assertConnectionsMutable();
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
  assertConnectionsMutable();
  localStorage.removeItem(STORAGE_KEY);
  localStorage.removeItem(CONNECTIONS_KEY);
  clearEmbedConnection();
}

export function getDefaultConfig(): Config {
  const deployment = getDeploymentConnection();
  if (deployment) return { apiUrl: deployment.apiUrl, apiKey: deployment.apiKey };
  return { ...DEFAULT_CONFIG };
}

/**
 * User-bound `aswt_` bearer (minted on the People page) vs the deployment's
 * operator key. When the tab authenticates with a user token the server
 * forces requester/audit attribution to that user, so the UI must derive its
 * identity from the token and never offer identity picking (DES-771).
 */
export function isUserTokenApiKey(apiKey: string): boolean {
  return apiKey.startsWith("aswt_");
}
