/**
 * Comb's agent-fs connection: the swarm drive from `/status` (`agent_fs.comb`)
 * plus the human's own agent-fs credential from this browser.
 *
 * States:
 * - `disabled`: Comb is off, agent-fs is not configured, or the API predates Comb.
 * - `loading`: `/status` or the identity check is in flight.
 * - `needs-connect`: no credential in this browser.
 * - `invalid-key`: agent-fs rejected the saved key (401).
 * - `unreachable`: the identity check failed for another reason (network, 5xx).
 * - `ready`: `me` is loaded and `client` works.
 */

import { useQueryClient } from "@tanstack/react-query";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { useAgentFsHealth, useAgentFsMe } from "@/api/hooks/use-agent-fs";
import { useStatusContext } from "@/app/status-context";
import { useConfig } from "@/hooks/use-config";
import { AgentFsClient, AgentFsError, isAgentFsAuthError } from "@/lib/agent-fs/client";
import {
  type AgentFsCredential,
  clearCredential,
  readCredential,
  subscribeCredential,
  writeCredential,
} from "@/lib/agent-fs/credential-store";
import type { MeResponse } from "@/lib/agent-fs/types";

export type AgentFsState =
  | "disabled"
  | "loading"
  | "needs-connect"
  | "invalid-key"
  | "unreachable"
  | "ready";

export interface AgentFsContextValue {
  state: AgentFsState;
  /** Browser-facing agent-fs URL. Null while disabled. */
  endpoint: string | null;
  /** The swarm's shared org and drive. */
  orgId: string | null;
  driveId: string | null;
  /** agent-fs live UI host, for "Open in agent-fs" links. */
  liveUrl: string | null;
  credential: AgentFsCredential | null;
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

export function AgentFsProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const { config } = useConfig();
  const apiUrl = config.apiUrl;
  const { data: status, isLoading: statusLoading } = useStatusContext();
  const comb = status?.agent_fs?.comb;
  const endpoint = comb?.enabled && comb.api_url ? comb.api_url : null;

  const [credential, setCredential] = useState<AgentFsCredential | null>(() =>
    endpoint ? readCredential(apiUrl, endpoint) : null,
  );
  useEffect(() => {
    if (!endpoint) {
      setCredential(null);
      return;
    }
    setCredential(readCredential(apiUrl, endpoint));
    return subscribeCredential(apiUrl, endpoint, setCredential);
  }, [apiUrl, endpoint]);

  const apiKey = credential?.apiKey;
  const client = useMemo(
    () => (endpoint && apiKey ? new AgentFsClient({ endpoint, apiKey }) : null),
    [endpoint, apiKey],
  );

  const health = useAgentFsHealth(endpoint);
  const meQuery = useAgentFsMe(client, credential?.userId ?? null);
  const healthFeatures = health.data?.features;
  const features = useMemo(() => new Set(healthFeatures ?? []), [healthFeatures]);

  const connect = useCallback(
    (next: AgentFsCredential) => {
      if (!endpoint) return;
      // Drop results cached under an older key for the same user (a reset key
      // would otherwise keep its 401).
      queryClient.removeQueries({ queryKey: ["agent-fs", endpoint] });
      writeCredential(apiUrl, endpoint, next);
      setCredential(next);
    },
    [apiUrl, endpoint, queryClient],
  );

  const disconnect = useCallback(() => {
    if (endpoint) clearCredential(apiUrl, endpoint);
    setCredential(null);
    queryClient.removeQueries({ queryKey: ["agent-fs"] });
  }, [apiUrl, endpoint, queryClient]);

  const refetchMe = meQuery.refetch;
  const retry = useCallback(() => {
    void refetchMe();
  }, [refetchMe]);

  const meError = meQuery.error
    ? meQuery.error instanceof AgentFsError
      ? meQuery.error
      : new AgentFsError(0, "UNKNOWN", "agent-fs identity check failed")
    : null;
  let state: AgentFsState;
  if (status === undefined && statusLoading) state = "loading";
  else if (!endpoint) state = "disabled";
  else if (!credential) state = "needs-connect";
  // A 401 wins over cached data: the key was revoked or reset since.
  else if (isAgentFsAuthError(meError)) state = "invalid-key";
  else if (meQuery.data) state = "ready";
  else if (meError) state = "unreachable";
  else state = "loading";
  const error = state === "invalid-key" || state === "unreachable" ? meError : null;

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
