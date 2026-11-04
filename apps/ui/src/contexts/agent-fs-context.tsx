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
import { useMatch } from "react-router-dom";
import { useStatusContext } from "@/app/status-context";
import {
  autoConnectRunKey,
  settledOutcome,
  subscribeSettled,
} from "@/components/comb/auto-connect-attempts";
import type { AutoConnectOutcome } from "@/components/comb/connect-flow";
import { useCurrentUser } from "@/contexts/current-user-context";
import { type AgentFsLive, type LiveState, useAgentFsLive } from "@/hooks/use-agent-fs-live";
import { useConfig } from "@/hooks/use-config";
import { AgentFsClient, type AgentFsError } from "@/lib/agent-fs/client";
import {
  type AgentFsCredential,
  type CredentialOwner,
  clearCredential,
  credentialSnapshot,
  subscribeCredential,
  writeCredential,
} from "@/lib/agent-fs/credential-store";
import { agentFsKey, agentFsRetry, recheckMeOnAuthError } from "@/lib/agent-fs/query";
import { type AgentFsState, combEndpoint, deriveAgentFsState } from "@/lib/agent-fs/state";
import type { MeResponse } from "@/lib/agent-fs/types";

export type { AgentFsState, LiveState };

export interface AgentFsContextValue extends AgentFsLive {
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
  /** Set in `ready`: the saved identity, after the key check passed. */
  me: MeResponse | null;
  /** `/health` features of the agent-fs server. Empty when unknown. */
  features: Set<string>;
  /** `/health` upload limit in bytes. Null when the server does not say. */
  maxUploadBytes: number | null;
  /** Why the state is `invalid-key` or `unreachable`. */
  error: AgentFsError | null;
  /** This page load's settled automatic connect outcome. Null while none has settled. */
  autoConnect: AutoConnectOutcome | null;
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

/**
 * The check that the saved key still works: `ls /` on the swarm drive. Not
 * agent-fs `/auth/me`: a key the dashboard minted is scoped to the shared org,
 * so the identity comes from the saved credential (`GET /api/fs/me` at mint
 * time). With no swarm drive configured there is nothing to check against.
 */
function useAgentFsKeyCheck(
  checkKey: readonly unknown[],
  client: AgentFsClient | null,
  credential: Omit<AgentFsCredential, "apiKey"> | null,
  drive: { orgId: string | null; driveId: string | null },
) {
  const { orgId, driveId } = drive;
  return useQuery({
    queryKey: checkKey,
    queryFn: async ({ signal }): Promise<MeResponse> => {
      if (orgId && driveId) {
        await (client as AgentFsClient).callOp(orgId, "ls", { path: "/" }, driveId, { signal });
      }
      const saved = credential as Omit<AgentFsCredential, "apiKey">;
      return {
        userId: saved.userId,
        email: saved.email,
        displayName: saved.displayName,
        defaultOrgId: orgId,
        defaultDriveId: driveId,
      };
    },
    enabled: client !== null && credential !== null,
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

  // The credential belongs to the dashboard user: switching users never reuses
  // another user's key. A tab with no user keeps the legacy (user-less) key.
  const currentUser = useCurrentUser();
  const ownerId = currentUser.userId;
  const ownerEmail = currentUser.user?.email ?? null;
  const owner = useMemo<CredentialOwner | null>(
    () => (ownerId ? { userId: ownerId, email: ownerEmail } : null),
    [ownerId, ownerEmail],
  );

  // Read during render, so a hard load never flashes `needs-connect`.
  const subscribe = useCallback(
    (onChange: () => void) =>
      endpoint ? subscribeCredential(apiUrl, endpoint, owner, onChange) : () => {},
    [apiUrl, endpoint, owner],
  );
  const getSnapshot = useMemo(
    () => (endpoint ? credentialSnapshot(apiUrl, endpoint, owner) : () => null),
    [apiUrl, endpoint, owner],
  );
  const saved = useSyncExternalStore(subscribe, getSnapshot);
  const runKey = autoConnectRunKey(apiUrl, endpoint, ownerId);
  const autoConnect = useSyncExternalStore(subscribeSettled, () => settledOutcome(runKey));

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
  const orgId = comb?.org_id ?? null;
  const driveId = comb?.drive_id ?? null;
  // Keyed by the key id too: a re-minted key for the same user checks again.
  const keyId = saved?.keyId ?? null;
  const meKey = useMemo(
    () => agentFsKey(endpoint ?? "", userId, orgId, driveId, "me", keyId),
    [endpoint, userId, orgId, driveId, keyId],
  );
  const meQuery = useAgentFsKeyCheck(meKey, client, credential, { orgId, driveId });
  const healthFeatures = health.data?.features;
  const features = useMemo(() => new Set(healthFeatures ?? []), [healthFeatures]);
  const maxUploadBytes = health.data?.maxUploadBytes ?? null;

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
      writeCredential(apiUrl, endpoint, owner, next);
    },
    [apiUrl, endpoint, owner, queryClient],
  );

  const disconnect = useCallback(() => {
    if (endpoint) clearCredential(apiUrl, endpoint, owner);
    queryClient.removeQueries({ queryKey: ["agent-fs"] });
  }, [apiUrl, endpoint, owner, queryClient]);

  const refetchMe = meQuery.refetch;
  const retry = useCallback(() => {
    void refetchMe();
  }, [refetchMe]);

  // While the dashboard user is unknown, the credential to read is unknown too.
  const statusPending = (status === undefined && statusLoading) || currentUser.state === "pending";
  const hasCredential = saved !== null;
  const me = meQuery.data;
  const meError = meQuery.error;
  const { state, error } = useMemo(
    () =>
      deriveAgentFsState({ statusLoading: statusPending, endpoint, hasCredential, me, meError }),
    [statusPending, endpoint, hasCredential, me, meError],
  );

  // Live updates (step-11): the change stream follows the drive in view, on Comb pages only.
  const combRoute = useMatch("/file/~/:orgId/:driveId/*");
  const { liveState, liveRelayed, liveDriveId, subscribeLive } = useAgentFsLive({
    client: state === "ready" && features.has("change-stream") ? client : null,
    endpoint,
    userId,
    orgId: combRoute?.params.orgId ?? null,
    driveId: combRoute?.params.driveId ?? null,
  });

  // Memoized: every link and attachment row reads this context.
  const liveUrl = comb?.live_url ?? null;
  const value = useMemo<AgentFsContextValue>(
    () => ({
      state,
      endpoint,
      orgId,
      driveId,
      liveUrl,
      credential,
      client,
      me: state === "ready" ? (me ?? null) : null,
      features,
      maxUploadBytes,
      error,
      autoConnect,
      connect,
      disconnect,
      retry,
      liveState,
      liveRelayed,
      liveDriveId,
      subscribeLive,
    }),
    [
      state,
      endpoint,
      orgId,
      driveId,
      liveUrl,
      credential,
      client,
      me,
      features,
      maxUploadBytes,
      error,
      autoConnect,
      connect,
      disconnect,
      retry,
      liveState,
      liveRelayed,
      liveDriveId,
      subscribeLive,
    ],
  );

  return <AgentFsContext.Provider value={value}>{children}</AgentFsContext.Provider>;
}

export function useAgentFs(): AgentFsContextValue {
  const ctx = useContext(AgentFsContext);
  if (!ctx) {
    throw new Error("useAgentFs must be used within an <AgentFsProvider>");
  }
  return ctx;
}

/** `useAgentFs()` for shared components that also render outside the provider (`/setup`). */
export function useOptionalAgentFs(): AgentFsContextValue | null {
  return useContext(AgentFsContext);
}
