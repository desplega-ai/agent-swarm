import type { AgentCredStatus } from "../types";
import { CREDENTIAL_POOL_VARS } from "../utils/credentials";
import { scrubSecrets } from "../utils/secret-scrubber";
import {
  buildCredStatusReport,
  isCredCheckDisabled,
  type LiveKeyResult,
  sendCredStatusReport,
  shouldRefreshBedrockStatus,
} from "./provider-credentials";
import type { ApiConfig } from "./runner";

export const CREDENTIAL_RETRY_INTERVAL_MS = 30_000;
export const KEY_RECHECK_INTERVAL_MS = 10 * 60_000;
const BEDROCK_REFRESH_INTERVAL_MS = 5 * 60 * 1000;

export interface CredentialRefreshState {
  harnessProvider: string | null;
  // null means the last attempt failed before readiness could be acknowledged.
  ready: boolean | null;
  lastRefreshAt: number;
  inFlight: boolean;
  fingerprint: string | null;
  rejectedKeys: number;
}

export function credentialFingerprint(env: Record<string, string | undefined>): string {
  return Bun.hash(
    JSON.stringify(
      [...CREDENTIAL_POOL_VARS, "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL"].map(
        (key) => env[key] ?? null,
      ),
    ),
  ).toString();
}

/**
 * Failed keys worth the periodic recheck. A Claude subscription token is left
 * out: its check calls an undocumented Anthropic account endpoint, so it runs
 * only once per token value (boot or change). A failed test with no per-key
 * results counts as one.
 */
export function recheckableFailures(liveTest: AgentCredStatus["liveTest"] | undefined): number {
  const keys = liveTest?.keys;
  if (keys?.length) {
    return keys.filter((key) => !key.ok && key.keyType !== "CLAUDE_CODE_OAUTH_TOKEN").length;
  }
  return liveTest?.ok === false ? 1 : 0;
}

/** Report each pool separately. A telemetry failure must not stop credential checks. */
export async function reportKeyValidation(api: ApiConfig, keys: LiveKeyResult[]): Promise<void> {
  for (const keyType of new Set(keys.map((key) => key.keyType))) {
    try {
      const response = await fetch(`${api.apiUrl}/api/keys/report-validation`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${api.apiKey}`,
          "X-Agent-ID": api.agentId,
        },
        body: JSON.stringify({
          keyType,
          keys: keys
            .filter((key) => key.keyType === keyType)
            .map((key) => ({
              keyIndex: key.index,
              keySuffix: key.suffix,
              ok: key.ok,
              httpStatus: key.httpStatus,
            })),
        }),
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(scrubSecrets(`[credentials] Failed to report key validation: ${message}`));
    }
  }
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
  const fingerprint = credentialFingerprint(env);
  const fingerprintChanged = state.fingerprint !== fingerprint;
  const retryDue =
    state.ready !== true && now - state.lastRefreshAt >= CREDENTIAL_RETRY_INTERVAL_MS;
  const keyRecheckDue =
    state.rejectedKeys > 0 && now - state.lastRefreshAt >= KEY_RECHECK_INTERVAL_MS;
  if (
    !providerChanged &&
    !fingerprintChanged &&
    !retryDue &&
    !keyRecheckDue &&
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
    if (state.harnessProvider === harnessProvider) {
      state.ready = snapshot.ready;
      state.fingerprint = fingerprint;
      state.rejectedKeys = recheckableFailures(snapshot.liveTest);
      const keys = snapshot.liveTest?.keys;
      if (keys?.length) await reportKeyValidation(api, keys);
    }
  } finally {
    // Errors propagate to the runner's non-fatal logger, leaving ready unknown
    // so even a lost ready:true write is retried without a restart.
    state.inFlight = false;
  }
}
