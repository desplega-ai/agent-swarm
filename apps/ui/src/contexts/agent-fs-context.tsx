/**
 * Comb's agent-fs connection: the swarm drive from `/status` (`agent_fs.comb`)
 * plus the human's own agent-fs credential from this browser. The states are
 * documented on `AgentFsState` (`lib/agent-fs/state.ts`).
 */

import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useSyncExternalStore,
} from "react";
import { useStatusContext } from "@/app/status-context";
import { useConfig } from "@/hooks/use-config";
import { AgentFsClient, type AgentFsError } from "@/lib/agent-fs/client";
import {
  type AgentFsCredential,
  clearCredential,
  credentialSnapshot,
  subscribeCredential,
  writeCredential,
} from "@/lib/agent-fs/credential-store";
import { agentFsKey, agentFsRetry, recheckMeOnAuthError } from "@/lib/agent-fs/query";
import { type AgentFsState, combEndpoint, deriveAgentFsState } from "@/lib/agent-fs/state";
import type { MeResponse } from "@/lib/agent-fs/types";

export type { AgentFsState };

export interface AgentFsContextValue {
  state: AgentFsState;
  /** Browser-facing agent-fs URL. Null while disabled. Build query keys from it. */
  endpoint: string | null;
  /** The swarm's shared org and drive. */
  orgId: string | null;
  driveId: string | null;
  /** agent-fs live UI host, for "Open in agent-fs" links. */
  liveUrl: string | null;
  /** Who is connected. The key itself stays inside `client`. */
  credential: Omit<AgentFsCredential, "apiKey"> | null;
  /** Set whenever a credential exists, before the key is verified. */
  client: AgentFsClient | null;
  /** Set in `ready`. */
  me: MeResponse | null;
  /** `/health` features of the agent-fs server. Empty when unknown. */
  features: Set<string>;
  /** Why the state is `invalid-key` or `unreachable`. */
  error: AgentFsError | null;
  /** Save a verified credential and switch to it. */
  connect: (credential: AgentFsCredential) => void;
  /** Forget the credential and every cached agent-fs query. */
  disconnect: () => void;
  /** Check the saved key again (after `unreachable`). */
  retry: () => void;
}

const AgentFsContext = createContext<AgentFsContextValue | null>(null);

/** Connection-level data changes rarely: no polling. */
const CONNECTION_QUERY = {
  staleTime: 5 * 60_000,
  refetchInterval: false,
  retry: agentFsRetry,
} as const;

/** Public server info. `features` gates Comb surfaces that need a newer agent-fs. */
function useAgentFsHealth(endpoint: string | null) {
  return useQuery({
    queryKey: agentFsKey(endpoint ?? "", null, null, null, "health"),
    queryFn: ({ signal }) => AgentFsClient.health(endpoint as string, { signal }),
    enabled: endpoint !== null,
    ...CONNECTION_QUERY,
  });
}

/** The connected identity: the check that the saved key still works. */
function useAgentFsMe(meKey: readonly unknown[], client: AgentFsClient | null) {
  return useQuery({
    queryKey: meKey,
    queryFn: ({ signal }) => (client as AgentFsClient).getMe({ signal }),
    enabled: client !== null,
    ...CONNECTION_QUERY,
  });
}

export function AgentFsProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const { config } = useConfig();
  const apiUrl = config.apiUrl;
  const { data: status, isLoading: statusLoading } = useStatusContext();
  const comb = status?.agent_fs?.comb;
  const endpoint = combEndpoint(comb);

  // Read during render, so a hard load never flashes `needs-connect`.
  const subscribe = useCallback(
    (onChange: () => void) =>
      endpoint ? subscribeCredential(apiUrl, endpoint, onChange) : () => {},
    [apiUrl, endpoint],
  );
  const getSnapshot = useMemo(
    () => (endpoint ? credentialSnapshot(apiUrl, endpoint) : () => null),
    [apiUrl, endpoint],
  );
  const saved = useSyncExternalStore(subscribe, getSnapshot);

  const apiKey = saved?.apiKey;
  const client = useMemo(
    () => (endpoint && apiKey ? new AgentFsClient({ endpoint, apiKey }) : null),
    [endpoint, apiKey],
  );
  const credential = useMemo(() => {
    if (!saved) return null;
    const { apiKey: _key, ...rest } = saved;
    return rest;
  }, [saved]);
  const userId = saved?.userId ?? null;

  const health = useAgentFsHealth(endpoint);
  const meKey = useMemo(
    () => agentFsKey(endpoint ?? "", userId, null, null, "me"),
    [endpoint, userId],
  );
  const meQuery = useAgentFsMe(meKey, client);
  const healthFeatures = health.data?.features;
  const features = useMemo(() => new Set(healthFeatures ?? []), [healthFeatures]);

  // A 401 from any agent-fs query (a listing, a file) checks `me` again.
  useEffect(() => {
    if (!client) return;
    return recheckMeOnAuthError(queryClient, meKey);
  }, [client, meKey, queryClient]);

  const connect = useCallback(
    (next: AgentFsCredential) => {
      if (!endpoint) return;
      // Drop results cached under an older key for the same user (a reset key
      // would otherwise keep its 401).
      queryClient.removeQueries({ queryKey: ["agent-fs", endpoint] });
      writeCredential(apiUrl, endpoint, next);
    },
    [apiUrl, endpoint, queryClient],
  );

  const disconnect = useCallback(() => {
    if (endpoint) clearCredential(apiUrl, endpoint);
    queryClient.removeQueries({ queryKey: ["agent-fs"] });
  }, [apiUrl, endpoint, queryClient]);

  const refetchMe = meQuery.refetch;
  const retry = useCallback(() => {
    void refetchMe();
  }, [refetchMe]);

  const { state, error } = deriveAgentFsState({
    statusLoading: status === undefined && statusLoading,
    endpoint,
    hasCredential: saved !== null,
    me: meQuery.data,
    meError: meQuery.error,
  });

  const value: AgentFsContextValue = {
    state,
    endpoint,
    orgId: comb?.org_id ?? null,
    driveId: comb?.drive_id ?? null,
    liveUrl: comb?.live_url ?? null,
    credential,
    client,
    me: state === "ready" ? (meQuery.data ?? null) : null,
    features,
    error,
    connect,
    disconnect,
    retry,
  };

  return <AgentFsContext.Provider value={value}>{children}</AgentFsContext.Provider>;
}

export function useAgentFs(): AgentFsContextValue {
  const ctx = useContext(AgentFsContext);
  if (!ctx) {
    throw new Error("useAgentFs must be used within an <AgentFsProvider>");
  }
  return ctx;
}
