/**
 * Opencode provider adapter — skeleton (Phase 1).
 *
 * Wires `HARNESS_PROVIDER=opencode` into the factory. Session/SDK logic
 * comes in sub-5; `createSession` intentionally throws until then.
 */

import { validateOpencodeCredentials } from "../utils/credentials";
import type {
  ProviderAdapter,
  ProviderSession,
  ProviderSessionConfig,
  ProviderTraits,
} from "./types";

export class OpencodeAdapter implements ProviderAdapter {
  readonly name = "opencode";

  readonly traits: ProviderTraits = {
    hasMcp: true,
    hasLocalEnvironment: true,
  };

  validateCredentials(env: Record<string, string | undefined> = {}): string {
    return validateOpencodeCredentials(env);
  }

  async createSession(_config: ProviderSessionConfig): Promise<ProviderSession> {
    throw new Error("not implemented yet");
  }

  async canResume(_sessionId: string): Promise<boolean> {
    return false;
  }

  formatCommand(commandName: string): string {
    return `/${commandName}`;
  }
}
