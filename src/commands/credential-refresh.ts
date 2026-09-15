import {
  buildCredStatusReport,
  isCredCheckDisabled,
  sendCredStatusReport,
  shouldRefreshBedrockStatus,
} from "./provider-credentials";
import type { ApiConfig } from "./runner";

export const CREDENTIAL_RETRY_INTERVAL_MS = 30_000;
const BEDROCK_REFRESH_INTERVAL_MS = 5 * 60 * 1000;

export interface CredentialRefreshState {
  harnessProvider: string | null;
  // null means the last attempt failed before readiness could be acknowledged.
  ready: boolean | null;
  lastRefreshAt: number;
  inFlight: boolean;
}

/**
 * Called on each runner tick after env reconciliation. Provider changes refresh
 * immediately; blocked/failed reports retry on a bounded interval until the API
 * acknowledges readiness. Only one build/report may be in flight at a time.
 */
export async function refreshCredentialStatus(
  api: ApiConfig,
  state: CredentialRefreshState,
  harnessProvider: string,
  env: Record<string, string | undefined>,
  now = Date.now(),
): Promise<void> {
  if (isCredCheckDisabled(env) || state.inFlight) return;
  const providerChanged = state.harnessProvider !== harnessProvider;
  const retryDue =
    state.ready !== true && now - state.lastRefreshAt >= CREDENTIAL_RETRY_INTERVAL_MS;
  if (
    !providerChanged &&
    !retryDue &&
    !shouldRefreshBedrockStatus({
      harnessProvider,
      env,
      lastRefreshAt: state.lastRefreshAt,
      now,
      intervalMs: BEDROCK_REFRESH_INTERVAL_MS,
    })
  ) {
    return;
  }

  state.harnessProvider = harnessProvider;
  state.lastRefreshAt = now;
  state.ready = null;
  state.inFlight = true;
  try {
    const snapshot = await buildCredStatusReport(harnessProvider, { ...env }, {}, "post_task");
    // The runner invalidates this cache on a live provider swap. Discard a
    // snapshot built for the old provider; the next tick checks the new one.
    if (state.harnessProvider !== harnessProvider) return;
    await sendCredStatusReport(api.apiUrl, api.apiKey, api.agentId, api.runtimeInstanceId, {
      ready: snapshot.ready,
      missing: snapshot.missing,
      credStatus: snapshot,
    });
    if (state.harnessProvider === harnessProvider) state.ready = snapshot.ready;
  } finally {
    // Errors propagate to the runner's non-fatal logger, leaving ready unknown
    // so even a lost ready:true write is retried without a restart.
    state.inFlight = false;
  }
}
