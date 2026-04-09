export type {
  CostData,
  ProviderAdapter,
  ProviderEvent,
  ProviderResult,
  ProviderSession,
  ProviderSessionConfig,
} from "./types";

import { ClaudeAdapter } from "./claude-adapter";
import { CodexAdapter } from "./codex-adapter";
import { PiMonoAdapter } from "./pi-mono-adapter";
import type { ProviderAdapter } from "./types";

/** Create a provider adapter for the given harness provider name. */
export function createProviderAdapter(provider: string): ProviderAdapter {
  switch (provider) {
    case "claude":
      return new ClaudeAdapter();
    case "pi":
      return new PiMonoAdapter();
    case "codex":
      return new CodexAdapter();
    default:
      throw new Error(`Unknown HARNESS_PROVIDER: "${provider}". Supported: claude, pi, codex`);
  }
}
