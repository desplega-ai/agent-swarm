import { type ProviderName, ProviderNameSchema } from "@swarm/types";

const SUPPORTED_PROVIDERS = ProviderNameSchema.options;

/**
 * Resolve the effective `HARNESS_PROVIDER` for a worker.
 *
 * Precedence (highest first):
 *   1. `resolvedEnv.HARNESS_PROVIDER` — value coming from `swarm_config`
 *      (overlay produced by `fetchResolvedEnv`, scoped repo > agent > global).
 *   2. `fallbackEnv.HARNESS_PROVIDER` — raw `process.env`.
 *   3. `"claude"` — final default.
 *
 * Invalid values (anything outside `ProviderNameSchema`) log a warning and
 * fall back to `"claude"` rather than throwing — boot must not be killed
 * by a typo'd swarm_config row.
 */
export function resolveHarnessProvider(
  resolvedEnv: Record<string, string | undefined>,
  fallbackEnv: Record<string, string | undefined> = process.env,
): ProviderName {
  const candidate = resolvedEnv.HARNESS_PROVIDER?.trim() || fallbackEnv.HARNESS_PROVIDER?.trim();
  if (!candidate) return "claude";
  const parsed = ProviderNameSchema.safeParse(candidate);
  if (!parsed.success) {
    console.warn(
      `[harness-provider] Invalid HARNESS_PROVIDER="${candidate}" (must be one of: ${SUPPORTED_PROVIDERS.join(", ")}); falling back to "claude"`,
    );
    return "claude";
  }
  return parsed.data;
}
