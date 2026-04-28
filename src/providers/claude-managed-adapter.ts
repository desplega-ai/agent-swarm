/**
 * ClaudeManagedAdapter — harness provider for Anthropic's Managed Agents
 * (`@anthropic-ai/sdk` beta surface).
 *
 * **Phase 1 status**: skeleton only. Validates env-var presence at construction
 * time, factory-dispatchable, and asserts the SDK's beta surface is available
 * via real type imports below. `createSession` throws `Not implemented` until
 * Phase 3.
 *
 * Reference: thoughts/taras/plans/2026-04-28-claude-managed-agents-provider.md
 */

// SDK shape assertions — these imports exist *only* to make `bun run tsc:check`
// fail if the bumped `@anthropic-ai/sdk` doesn't expose the beta resources we
// need (agents/sessions/environments/skills). They become real usages in
// Phase 3 when `createSession` is implemented; until then the imports are
// unused, hence the explicit lint suppression.
//
// The plan specifies short names (Agent, Session, SessionEvent, Environment,
// Skill); the SDK's actual export names are `BetaManagedAgentsAgent`,
// `BetaManagedAgentsSession`, `BetaManagedAgentsSessionEvent`, `BetaEnvironment`,
// and the skills resource is exposed via responses (`SkillCreateResponse`).
// Aliasing here documents the mapping in one place so Phase 3 can reference
// the same names without re-discovering them.

// biome-ignore lint/correctness/noUnusedImports: SDK shape assertion — tightened in Phase 3
import type { BetaManagedAgentsAgent as Agent } from "@anthropic-ai/sdk/resources/beta/agents";
// biome-ignore lint/correctness/noUnusedImports: SDK shape assertion — tightened in Phase 3
import type { BetaEnvironment as Environment } from "@anthropic-ai/sdk/resources/beta/environments";
// biome-ignore lint/correctness/noUnusedImports: SDK shape assertion — tightened in Phase 3
import type {
  BetaManagedAgentsSession as Session,
  BetaManagedAgentsSessionEvent as SessionEvent,
} from "@anthropic-ai/sdk/resources/beta/sessions";
// biome-ignore lint/correctness/noUnusedImports: SDK shape assertion — tightened in Phase 3
import type { SkillCreateResponse as Skill } from "@anthropic-ai/sdk/resources/beta/skills";

import type { ProviderAdapter, ProviderSession, ProviderSessionConfig } from "./types";

/**
 * Required env vars validated at construction time. Listing them in one place
 * keeps the error messages consistent and makes it easy for Phase 2 (worker
 * bootstrap / docker-entrypoint) to mirror the validation.
 */
const REQUIRED_ENV_VARS = [
  "ANTHROPIC_API_KEY",
  "MANAGED_AGENT_ID",
  "MANAGED_ENVIRONMENT_ID",
] as const;

export class ClaudeManagedAdapter implements ProviderAdapter {
  readonly name = "claude-managed";
  // Anthropic's cloud sandbox calls back into our /mcp endpoint, but the worker
  // process is a thin SSE relay — no /workspace, no PM2, no agent-fs, no skills FS.
  readonly traits = { hasMcp: true, hasLocalEnvironment: false };

  /** Anthropic API key (kept private; never logged). */
  private readonly apiKey: string;
  /** Managed agent identifier (created by `claude-managed-setup` CLI in Phase 2). */
  private readonly agentId: string;
  /** Managed environment identifier (created by `claude-managed-setup` CLI in Phase 2). */
  private readonly environmentId: string;

  constructor() {
    const missing = REQUIRED_ENV_VARS.filter((key) => !process.env[key]);
    if (missing.length > 0) {
      throw new Error(
        `[claude-managed] Missing required env var(s): ${missing.join(", ")}. ` +
          `Run \`bun run src/cli.tsx claude-managed-setup\` to create an Anthropic-side ` +
          `agent + environment and persist their IDs to swarm_config.`,
      );
    }

    // Non-null assertions are safe here: the missing-key check above guarantees
    // each required variable is set.
    this.apiKey = process.env.ANTHROPIC_API_KEY as string;
    this.agentId = process.env.MANAGED_AGENT_ID as string;
    this.environmentId = process.env.MANAGED_ENVIRONMENT_ID as string;
  }

  async createSession(_config: ProviderSessionConfig): Promise<ProviderSession> {
    // Touch private fields so the unused-private-member lint stays quiet
    // until Phase 3 wires them into the real session.
    void this.apiKey;
    void this.agentId;
    void this.environmentId;
    throw new Error("ClaudeManagedAdapter.createSession not yet implemented (Phase 3)");
  }

  async canResume(_sessionId: string): Promise<boolean> {
    // Phase 1: no resume support. Phase 3 wires this to
    // `client.beta.sessions.retrieve(sessionId)` and inspects status.
    return false;
  }

  formatCommand(commandName: string): string {
    return `/${commandName}`;
  }
}
