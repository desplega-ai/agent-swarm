/**
 * Worker-side credential wait loop.
 *
 * Runs once at boot, *after* the worker has registered with the API
 * (`POST /api/agents`). While harness credentials are missing, the loop:
 *
 *   1. Calls `checkProviderCredentials(provider, process.env)` — if ready,
 *      returns immediately.
 *   2. Otherwise calls the caller-provided `refreshEnv()` (typically
 *      `fetchResolvedEnv` from runner.ts) to pull `swarm_config` keys into
 *      `process.env`.
 *   3. Re-checks; if ready, returns.
 *   4. Logs a `[boot] waiting for …` line and invokes `onTick(status)` so
 *      callers can report state to the API.
 *   5. Sleeps with exponential backoff (2s → 30s, cap configurable).
 *   6. If `BOOT_MAX_WAIT_SECONDS` is set and exceeded, throws a
 *      `BootMaxWaitExceededError` so the runner can exit with a distinct
 *      code. Default 0 = wait forever.
 *
 * Why TS-level wait instead of bash-level fail-fast: workers running under
 * `restart: unless-stopped` would otherwise loop the container forever when
 * a credential is set via `swarm_config` after the first boot, because the
 * entrypoint hard-exits before the process can refresh.
 */

import { checkProviderCredentials } from "../providers/credentials";
import type { CredCheckOptions, CredStatus } from "../providers/types";

/** Exit code distinct from generic failures so monitoring can distinguish
 * "config never arrived" from worker process crashes. Matches sysexits(3)'s
 * `EX_CONFIG`.
 */
export const EX_CONFIG = 78;

export class BootMaxWaitExceededError extends Error {
  constructor(
    public readonly elapsedSeconds: number,
    public readonly lastStatus: CredStatus,
  ) {
    super(
      `Boot wait exceeded BOOT_MAX_WAIT_SECONDS (${elapsedSeconds.toFixed(1)}s). ` +
        `Still missing: ${lastStatus.missing.join(", ") || "(unknown)"}.`,
    );
    this.name = "BootMaxWaitExceededError";
  }
}

export interface AwaitCredentialsOptions {
  /** Harness provider name — picks the predicate to run. */
  provider: string;
  /** Pull latest swarm_config values into env. Resolves to the merged env. */
  refreshEnv: () => Promise<Record<string, string | undefined>>;
  /** Callback invoked on every tick — Phase 3 wires this to the status-report API. */
  onTick?: (status: CredStatus, attempt: number) => void;
  /** Override env source (defaults to `process.env`). */
  initialEnv?: Record<string, string | undefined>;
  /** Sleep helper override for tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Clock override for tests (returns ms epoch). */
  now?: () => number;
  /** Forwarded to `checkProviderCredentials` (file-presence injection for codex/pi/opencode). */
  credCheckOptions?: CredCheckOptions;
  /** Override the default backoff config (else read from env). */
  backoff?: {
    initialMs?: number;
    maxMs?: number;
    maxWaitSeconds?: number;
  };
  /** Logger override (defaults to console.log). */
  log?: (line: string) => void;
}

interface ResolvedBackoff {
  initialMs: number;
  maxMs: number;
  maxWaitSeconds: number;
}

function resolveBackoff(
  override: AwaitCredentialsOptions["backoff"],
  env: Record<string, string | undefined>,
): ResolvedBackoff {
  const parsePositive = (raw: string | undefined, fallback: number): number => {
    if (!raw) return fallback;
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 ? n : fallback;
  };
  return {
    initialMs: override?.initialMs ?? parsePositive(env.BOOT_INITIAL_BACKOFF_MS, 2000),
    maxMs: override?.maxMs ?? parsePositive(env.BOOT_MAX_BACKOFF_MS, 30000),
    // 0 = wait forever — the runner can override with a finite ceiling per
    // worker if monitoring wants a "config never arrived" signal.
    maxWaitSeconds: override?.maxWaitSeconds ?? parsePositive(env.BOOT_MAX_WAIT_SECONDS, 0),
  };
}

/** Update process.env in place from a refreshed env object. */
function applyEnvUpdates(refreshed: Record<string, string | undefined>): void {
  for (const [key, value] of Object.entries(refreshed)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

/**
 * Block until the worker's harness has its credentials.
 *
 * Returns the final `CredStatus` (always `ready: true`) once satisfied. The
 * caller is then free to start the polling loop.
 */
export async function awaitCredentials(opts: AwaitCredentialsOptions): Promise<CredStatus> {
  const sleep = opts.sleep ?? ((ms: number) => Bun.sleep(ms));
  const now = opts.now ?? (() => Date.now());
  const log = opts.log ?? ((line: string) => console.log(line));
  const initialEnv = opts.initialEnv ?? process.env;
  const backoff = resolveBackoff(opts.backoff, initialEnv);

  // Fast path: already satisfied at boot.
  let status = checkProviderCredentials(opts.provider, initialEnv, opts.credCheckOptions);
  if (status.ready) {
    log(`[boot] credentials ready (provider=${opts.provider}, satisfiedBy=${status.satisfiedBy})`);
    return status;
  }

  const start = now();
  let attempt = 0;
  let delayMs = backoff.initialMs;

  while (!status.ready) {
    attempt += 1;

    // Notify the caller (Phase 3 reports waiting_for_credentials to the API).
    try {
      opts.onTick?.(status, attempt);
    } catch (err) {
      // onTick failures must never break the wait loop — they're just
      // best-effort status reporting.
      log(`[boot] onTick error (non-fatal): ${err}`);
    }

    log(
      `[boot] waiting for ${status.missing.join(", ") || "credentials"} ` +
        `(attempt ${attempt}, retry in ${delayMs}ms)${status.hint ? ` — ${status.hint}` : ""}`,
    );

    await sleep(delayMs);

    // Refresh env from swarm_config (the whole point of the loop — the
    // server may have just been told about a credential).
    try {
      const refreshed = await opts.refreshEnv();
      applyEnvUpdates(refreshed);
    } catch (err) {
      // Don't crash on a transient refresh failure; just retry on the next tick.
      log(`[boot] env refresh failed (non-fatal): ${err}`);
    }

    status = checkProviderCredentials(opts.provider, process.env, opts.credCheckOptions);

    if (!status.ready) {
      // Exponential backoff with cap.
      delayMs = Math.min(delayMs * 2, backoff.maxMs);

      if (backoff.maxWaitSeconds > 0) {
        const elapsedSec = (now() - start) / 1000;
        if (elapsedSec >= backoff.maxWaitSeconds) {
          throw new BootMaxWaitExceededError(elapsedSec, status);
        }
      }
    }
  }

  log(
    `[boot] credentials ready (provider=${opts.provider}, satisfiedBy=${status.satisfiedBy}, attempts=${attempt})`,
  );
  // Final tick so callers can clear the waiting state.
  try {
    opts.onTick?.(status, attempt);
  } catch {
    // best-effort
  }
  return status;
}
