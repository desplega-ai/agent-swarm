/**
 * Orphan-recovery throttle for the worker delivery loop.
 *
 * `boot()` recovers this process's orphans once and seeds the interval from the
 * time the recovery finished, so the first delivery tick does not pay for the
 * same call again. Seeding with 0 (the pre-fix behavior) made that first tick
 * fire immediately, which is the duplicate this throttle exists to remove.
 */

export interface OrphanRecoveryThrottle {
  /** Recover once at boot and start the interval from its completion time. */
  boot(): Promise<number>;
  /** Recover when the interval has elapsed since the last recovery, else 0. */
  tick(): Promise<number>;
}

export interface OrphanRecoveryThrottleOptions {
  recover: () => Promise<number>;
  intervalMs: number;
  /** Injectable clock so tests do not wait for real time. */
  now?: () => number;
}

export function createOrphanRecoveryThrottle(
  options: OrphanRecoveryThrottleOptions,
): OrphanRecoveryThrottle {
  const { recover, intervalMs, now = Date.now } = options;
  let lastRecoveryAt: number | null = null;

  const recoverNow = async (): Promise<number> => {
    const recovered = await recover();
    lastRecoveryAt = now();
    return recovered;
  };

  return {
    boot: recoverNow,
    async tick(): Promise<number> {
      if (lastRecoveryAt !== null && now() - lastRecoveryAt <= intervalMs) {
        return 0;
      }
      return recoverNow();
    },
  };
}
