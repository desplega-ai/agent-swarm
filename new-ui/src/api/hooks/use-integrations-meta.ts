import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { getConfig } from "@/lib/config";

// ---------------------------------------------------------------------------
// Integrations-page support hooks
//
// - `useEnvPresence(keys)` tells the UI which of the given env vars are
//   currently set in `process.env` on the API server — regardless of whether
//   they were sourced from the deployment env file or from a DB-backed
//   `swarm_config` row that was already loaded at boot. Presence-only, never
//   values.
//
// - `useReloadConfig()` invokes the server's reload endpoint which re-reads
//   `swarm_config` into `process.env` with override=true and re-initializes
//   each long-lived integration client (Slack socket mode, GitHub/Linear/
//   AgentMail handlers). This is what lets the UI apply a just-saved value
//   without a server restart.
// ---------------------------------------------------------------------------

function getBaseUrl(): string {
  const config = getConfig();
  if (import.meta.env.DEV && config.apiUrl === "http://localhost:3013") {
    return "";
  }
  return config.apiUrl;
}

function getHeaders(): HeadersInit {
  const config = getConfig();
  const headers: HeadersInit = { "Content-Type": "application/json" };
  if (config.apiKey) {
    headers.Authorization = `Bearer ${config.apiKey}`;
  }
  return headers;
}

export type EnvPresenceMap = Record<string, boolean>;

async function fetchEnvPresence(keys: string[]): Promise<EnvPresenceMap> {
  if (keys.length === 0) return {};
  const url = `${getBaseUrl()}/api/config/env-presence?keys=${encodeURIComponent(keys.join(","))}`;
  const res = await fetch(url, { headers: getHeaders() });
  if (!res.ok) {
    throw new Error(`Failed to fetch env presence: ${res.status}`);
  }
  const data = (await res.json()) as { presence: EnvPresenceMap };
  return data.presence ?? {};
}

export function useEnvPresence(keys: string[]) {
  const stableKey = [...keys].sort().join(",");
  return useQuery({
    queryKey: ["config", "env-presence", stableKey],
    queryFn: () => fetchEnvPresence(keys),
    staleTime: 5_000,
    enabled: keys.length > 0,
  });
}

export interface ReloadConfigResult {
  success: boolean;
  configsLoaded: number;
  keysUpdated: string[];
  integrationsReinitialized: string[];
}

async function postReloadConfig(): Promise<ReloadConfigResult> {
  const url = `${getBaseUrl()}/api/config/reload`;
  const res = await fetch(url, {
    method: "POST",
    headers: getHeaders(),
    body: "{}",
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Reload failed (${res.status}): ${body.slice(0, 200)}`);
  }
  return (await res.json()) as ReloadConfigResult;
}

export function useReloadConfig() {
  const queryClient = useQueryClient();
  return useMutation<ReloadConfigResult, Error>({
    mutationFn: postReloadConfig,
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ["config", "env-presence"] });
      queryClient.invalidateQueries({ queryKey: ["configs"] });
    },
    onError: (err) => {
      toast.error(`Reload failed: ${err.message}`);
    },
  });
}

// ---------------------------------------------------------------------------
// Claude Managed Agents — test-connection mutation
//
// Hits `POST /api/integrations/claude-managed/test`. The endpoint reads
// `ANTHROPIC_API_KEY` + `MANAGED_AGENT_ID` from `swarm_config` and calls
// `client.beta.agents.retrieve` to verify the configured pair actually points
// at a live managed agent. Always returns 200 OK with `{ ok, ... }`.
// ---------------------------------------------------------------------------

export interface ClaudeManagedTestResult {
  ok: boolean;
  agentName?: string | null;
  model?: string | null;
  error?: string;
}

async function postClaudeManagedTest(): Promise<ClaudeManagedTestResult> {
  const url = `${getBaseUrl()}/api/integrations/claude-managed/test`;
  const res = await fetch(url, {
    method: "POST",
    headers: getHeaders(),
    body: "{}",
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Test connection failed (${res.status}): ${body.slice(0, 200)}`);
  }
  return (await res.json()) as ClaudeManagedTestResult;
}

export function useTestClaudeManagedConnection() {
  return useMutation<ClaudeManagedTestResult, Error>({
    mutationFn: postClaudeManagedTest,
    onError: (err) => {
      toast.error(`Test connection failed: ${err.message}`);
    },
  });
}
