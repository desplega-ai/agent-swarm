import { getSwarmConfigs } from "../db";

export const RESOURCE_DEFAULTS = {
  RESOURCE_TREE_CAP: 3,
  RESOURCE_SWARM_CAP: 20,
  RESOURCE_IDLE_MS: 30 * 60_000,
  RESOURCE_EXPIRY_MS: 7 * 86_400_000,
  RESOURCE_LEASE_MS: 30 * 60_000,
} as const;
export const RESOURCE_LIMITS = {
  RESOURCE_TREE_CAP: [1, 1000],
  RESOURCE_SWARM_CAP: [1, 10000],
  RESOURCE_IDLE_MS: [1000, 86_400_000],
  RESOURCE_EXPIRY_MS: [60_000, 365 * 86_400_000],
  RESOURCE_LEASE_MS: [1000, 30 * 60_000],
} as const;

export function validateResourceConfig(key: string, value: unknown): string | null {
  if (key === "RESOURCE_PREVIEW_ACCESS")
    return value === "public" || value === "private" ? null : "Use public or private.";
  const range = RESOURCE_LIMITS[key as keyof typeof RESOURCE_LIMITS];
  const number = Number(value);
  return range && Number.isSafeInteger(number) && number >= range[0] && number <= range[1]
    ? null
    : "Use an integer within the resource configuration limits.";
}

let warnedInvalidCleanupIdle = false;
/** Cleanup must not depend on unrelated admission settings being valid. */
export async function resourceCleanupIdleMs() {
  const rows = await getSwarmConfigs({ scope: "global" });
  const value =
    rows.find((row) => row.key === "RESOURCE_IDLE_MS")?.value ?? process.env.RESOURCE_IDLE_MS;
  if (value === undefined || validateResourceConfig("RESOURCE_IDLE_MS", value) === null) {
    warnedInvalidCleanupIdle = false;
    return value === undefined ? RESOURCE_DEFAULTS.RESOURCE_IDLE_MS : Number(value);
  }
  if (!warnedInvalidCleanupIdle) {
    console.warn(
      "[resources] Invalid RESOURCE_IDLE_MS; cleanup uses the default idle timeout. Admission remains fail-closed.",
    );
    warnedInvalidCleanupIdle = true;
  }
  return RESOURCE_DEFAULTS.RESOURCE_IDLE_MS;
}

export async function resourceConfig() {
  const rows = await getSwarmConfigs({ scope: "global" });
  const stored = new Map(rows.map((row) => [row.key, row.value]));
  const read = (key: string) => stored.get(key) ?? process.env[key];
  const config = { ...RESOURCE_DEFAULTS } as Record<keyof typeof RESOURCE_DEFAULTS, number>;
  for (const key of Object.keys(RESOURCE_DEFAULTS) as (keyof typeof RESOURCE_DEFAULTS)[]) {
    const value = read(key);
    if (value !== undefined) {
      const error = validateResourceConfig(key, value);
      if (error) throw new Error(`${key}: ${error}`);
      config[key] = Number(value);
    }
  }
  const access = read("RESOURCE_PREVIEW_ACCESS") ?? "public";
  if (validateResourceConfig("RESOURCE_PREVIEW_ACCESS", access))
    throw new Error("Use public or private for resource preview access.");
  return { ...config, access };
}
