export const SCRIPT_CAPACITY_KEYS = ["SCRIPT_EMBEDDED_RUNNER_SLOTS", "SCRIPT_QUEUE_WAIT_SYNC_MS"];

export function validateScriptCapacity(key: string, value: unknown): string | null {
  const max = key === "SCRIPT_QUEUE_WAIT_SYNC_MS" ? 599_999 : 1024;
  return /^\d+$/.test(String(value)) && Number(value) <= max
    ? null
    : `${key} must be an integer from 0 to ${max}`;
}

export function syncQueueWaitMs(): number {
  return Number(process.env.SCRIPT_QUEUE_WAIT_SYNC_MS ?? 30_000);
}

export function assertScriptCapacityConfig(postgres: boolean): void {
  for (const key of SCRIPT_CAPACITY_KEYS) {
    const value = process.env[key];
    if (value === undefined) continue;
    if (!postgres) throw new Error(`script_runners_need_postgres: ${key}`);
    const error = validateScriptCapacity(key, value);
    if (error) throw new Error(error);
  }
}
