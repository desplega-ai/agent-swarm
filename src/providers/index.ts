export type {
  CostData,
  ProviderAdapter,
  ProviderEvent,
  ProviderResult,
  ProviderSession,
  ProviderSessionConfig,
} from "./types";

import type { ProviderAdapter } from "./types";

/** Create a provider adapter for the given harness provider name. */
export function createProviderAdapter(provider: string): ProviderAdapter {
  switch (provider) {
    // Phase 2 will add: case "claude": return new ClaudeAdapter();
    // Phase 3 will add: case "pi": return new PiMonoAdapter();
    default:
      throw new Error(`Unknown HARNESS_PROVIDER: "${provider}". Supported: claude, pi`);
  }
}
