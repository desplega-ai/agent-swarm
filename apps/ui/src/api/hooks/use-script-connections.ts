import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  IntegrationsCatalogResponse,
  OAuthAppSummary,
  ScriptConnectionDetail,
  ScriptConnectionKind,
  ScriptConnectionScope,
  ScriptCredentialBinding,
  UpsertCredentialBindingInput,
  UpsertOAuthAppInput,
  UpsertScriptConnectionInput,
} from "@/api/types";
import { api } from "../client";

export interface ScriptConnectionFilters {
  kind?: ScriptConnectionKind | "all";
  scope?: ScriptConnectionScope | "all";
  scopeId?: string;
}

export function useScriptConnections(filters?: ScriptConnectionFilters) {
  return useQuery({
    queryKey: ["script-connections", filters],
    queryFn: () => api.fetchScriptConnections(filters),
    select: (data) => data.connections,
  });
}

export function useScriptConnection(id: string | undefined) {
  return useQuery({
    queryKey: ["script-connection", id],
    queryFn: () => api.fetchScriptConnection(id as string),
    enabled: Boolean(id),
    select: (data) => data.connection as ScriptConnectionDetail,
  });
}

export function useCredentialBindings() {
  return useQuery({
    queryKey: ["credential-bindings"],
    queryFn: () => api.fetchCredentialBindings(),
    select: (data) => data.bindings as ScriptCredentialBinding[],
  });
}

export function useOAuthApps() {
  return useQuery({
    queryKey: ["oauth-apps"],
    queryFn: () => api.fetchOAuthApps(),
    select: (data) => data.oauthApps as OAuthAppSummary[],
  });
}

const CATALOG_STORAGE_KEY = "agent-swarm:integrations-catalog:v1";
const CATALOG_TTL_MS = 60 * 60 * 1000;

let memoryCatalogCache: { timestamp: number; data: IntegrationsCatalogResponse } | null = null;

function readCachedCatalog(): IntegrationsCatalogResponse | undefined {
  const now = Date.now();
  if (memoryCatalogCache && now - memoryCatalogCache.timestamp < CATALOG_TTL_MS) {
    return memoryCatalogCache.data;
  }
  try {
    const raw = window.localStorage.getItem(CATALOG_STORAGE_KEY);
    if (!raw) return undefined;
    const parsed = JSON.parse(raw) as { timestamp?: unknown; data?: unknown };
    if (typeof parsed.timestamp !== "number" || now - parsed.timestamp >= CATALOG_TTL_MS) {
      return undefined;
    }
    const data = parsed.data as IntegrationsCatalogResponse;
    memoryCatalogCache = { timestamp: parsed.timestamp, data };
    return data;
  } catch {
    return undefined;
  }
}

function writeCachedCatalog(data: IntegrationsCatalogResponse) {
  const timestamp = Date.now();
  memoryCatalogCache = { timestamp, data };
  try {
    window.localStorage.setItem(CATALOG_STORAGE_KEY, JSON.stringify({ timestamp, data }));
  } catch {
    // localStorage can be unavailable or full; the in-memory cache still works.
  }
}

export function useIntegrationsCatalog() {
  return useQuery({
    queryKey: ["integrations-catalog"],
    queryFn: async () => {
      const cached = readCachedCatalog();
      if (cached) return cached;
      const data = await api.fetchIntegrationsCatalog();
      writeCachedCatalog(data);
      return data;
    },
    staleTime: CATALOG_TTL_MS,
    select: (data) => data.entries,
  });
}

export function useUpsertScriptConnection() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: UpsertScriptConnectionInput) => api.upsertScriptConnection(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["script-connections"] });
      queryClient.invalidateQueries({ queryKey: ["script-connection"] });
      queryClient.invalidateQueries({ queryKey: ["credential-bindings"] });
      queryClient.invalidateQueries({ queryKey: ["script-type-defs"] });
    },
  });
}

export function useRefreshScriptConnection() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.refreshScriptConnection(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["script-connections"] });
      queryClient.invalidateQueries({ queryKey: ["script-connection"] });
      queryClient.invalidateQueries({ queryKey: ["script-type-defs"] });
    },
  });
}

export function useSetScriptConnectionEnabled() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) =>
      api.setScriptConnectionEnabled(id, enabled),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["script-connections"] });
      queryClient.invalidateQueries({ queryKey: ["script-connection"] });
      queryClient.invalidateQueries({ queryKey: ["script-type-defs"] });
    },
  });
}

export function useUpsertCredentialBinding() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: UpsertCredentialBindingInput) => api.upsertCredentialBinding(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["credential-bindings"] });
      queryClient.invalidateQueries({ queryKey: ["script-connections"] });
      queryClient.invalidateQueries({ queryKey: ["script-connection"] });
    },
  });
}

export function useUpsertOAuthApp() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: UpsertOAuthAppInput) => api.upsertOAuthApp(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["oauth-apps"] });
      queryClient.invalidateQueries({ queryKey: ["credential-bindings"] });
      queryClient.invalidateQueries({ queryKey: ["script-connections"] });
      queryClient.invalidateQueries({ queryKey: ["script-connection"] });
    },
  });
}

export function useDeleteOAuthApp() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (provider: string) => api.deleteOAuthApp(provider),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["oauth-apps"] });
      queryClient.invalidateQueries({ queryKey: ["credential-bindings"] });
      queryClient.invalidateQueries({ queryKey: ["script-connections"] });
      queryClient.invalidateQueries({ queryKey: ["script-connection"] });
    },
  });
}

export function useRefreshOAuthApp() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (provider: string) => api.refreshOAuthApp(provider),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["oauth-apps"] });
      queryClient.invalidateQueries({ queryKey: ["credential-bindings"] });
    },
  });
}

export function useDisconnectOAuthApp() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (provider: string) => api.disconnectOAuthApp(provider),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["oauth-apps"] });
      queryClient.invalidateQueries({ queryKey: ["credential-bindings"] });
      queryClient.invalidateQueries({ queryKey: ["script-connections"] });
      queryClient.invalidateQueries({ queryKey: ["script-connection"] });
    },
  });
}

export function useDiscoverOAuthApp() {
  return useMutation({
    mutationFn: (url: string) => api.discoverOAuthApp(url),
  });
}

export function useIntegrationsSurface() {
  return useMutation({
    mutationFn: (domain: string) => api.fetchIntegrationsSurface(domain),
  });
}

export function useOAuthAuthorizeUrl() {
  return useMutation({
    mutationFn: (provider: string) => api.fetchOAuthAuthorizeUrl(provider),
  });
}

export function useRunInlineScript() {
  return useMutation({
    mutationFn: (data: { source: string; intent: string; agentId: string }) =>
      api.runInlineScript(data),
  });
}
