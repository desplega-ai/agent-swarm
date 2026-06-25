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

import type { ProviderAdapter } from "./types";

/**
 * Create a provider adapter for the given harness provider name.
 *
 * Adapter modules are loaded via dynamic `import()` so their transitive
 * dependencies (e.g. `@earendil-works/pi-coding-agent` for the pi adapter)
 * are NOT evaluated at binary startup. This prevents module-level side
 * effects in third-party SDKs from crashing subcommands that don't need
 * them (the codex-session-runner ENOENT at `/usr/local/bin/package.json`).
 */
export async function createProviderAdapter(provider: string): Promise<ProviderAdapter> {
  switch (provider) {
    case "claude": {
      const { ClaudeAdapter } = await import("./claude-adapter");
      return new ClaudeAdapter();
    }
    case "pi": {
      const { PiMonoAdapter } = await import("./pi-mono-adapter");
      return new PiMonoAdapter();
    }
    case "codex": {
      const { CodexAdapter } = await import("./codex-adapter");
      return new CodexAdapter();
    }
    case "claude-managed": {
      const { ClaudeManagedAdapter } = await import("./claude-managed-adapter");
      return new ClaudeManagedAdapter();
    }
    case "devin": {
      const { DevinAdapter } = await import("./devin-adapter");
      return new DevinAdapter();
    }
    case "opencode": {
      const { OpencodeAdapter } = await import("./opencode-adapter");
      return new OpencodeAdapter();
    }
    case "ai-sdk-agent": {
      const { AiSdkAgentAdapter } = await import("./ai-sdk-agent-adapter");
      return new AiSdkAgentAdapter();
    }
    default:
      throw new Error(
        `Unknown HARNESS_PROVIDER: "${provider}". Supported: claude, pi, codex, devin, claude-managed, opencode, ai-sdk-agent`,
      );
  }
}
