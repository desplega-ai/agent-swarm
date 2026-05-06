export {
  checkProviderCredentials,
  REQUIRED_CRED_VARS_BY_PROVIDER,
  type SupportedProvider,
} from "./credentials";
export type {
  CostData,
  CredCheckOptions,
  CredStatus,
  ProviderAdapter,
  ProviderEvent,
  ProviderResult,
  ProviderSession,
  ProviderSessionConfig,
  ProviderTraits,
} from "./types";

import { ClaudeAdapter } from "./claude-adapter";
import { ClaudeManagedAdapter } from "./claude-managed-adapter";
import { CodexAdapter } from "./codex-adapter";
import { DevinAdapter } from "./devin-adapter";
import { OpencodeAdapter } from "./opencode-adapter";
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
    case "claude-managed":
      return new ClaudeManagedAdapter();
    case "devin":
      return new DevinAdapter();
    case "opencode":
      return new OpencodeAdapter();
    default:
      throw new Error(
        `Unknown HARNESS_PROVIDER: "${provider}". Supported: claude, pi, codex, devin, claude-managed, opencode`,
      );
  }
}
