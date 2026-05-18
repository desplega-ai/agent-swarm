/** Data for session cost tracking. Shared across all provider adapters. */
export interface CostData {
  sessionId: string;
  taskId?: string;
  agentId: string;
  totalCostUsd: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  /**
   * Migration 063: undefined means "the harness can't report this" (e.g. the
   * Codex SDK has no cache-write field). Zero is reserved for "really zero".
   */
  cacheWriteTokens?: number;
  /** Migration 063: codex reasoning_output_tokens (and similar) for reasoning models. */
  reasoningOutputTokens?: number;
  /** Migration 063: claude extended-thinking tokens from CLI's `usage.thinking_input_tokens`. */
  thinkingTokens?: number;
  durationMs: number;
  /**
   * Migration 063: nullable — some adapters (claude when `num_turns` is absent)
   * can't honestly report a turn count; null is preferred over a faked 1.
   */
  numTurns: number | null;
  model: string;
  isError: boolean;
  /**
   * Phase 6 (extended migration 063): tells the API which recompute path to
   * use on `POST /api/session-costs`. After Phase 2 the recompute path runs
   * for every provider with seeded pricing rows, so every adapter should
   * populate this field.
   */
  provider?: "claude" | "claude-managed" | "codex" | "pi" | "opencode" | "devin";
}

import type { ProviderName } from "../types";

/** Normalized event emitted by any provider adapter. */
export type ProviderEvent =
  | {
      type: "session_init";
      sessionId: string;
      provider?: ProviderName;
      providerMeta?: Record<string, unknown>;
    }
  | { type: "message"; role: "assistant" | "user"; content: string }
  | { type: "tool_start"; toolCallId: string; toolName: string; args: unknown }
  | { type: "tool_end"; toolCallId: string; toolName: string; result: unknown }
  | { type: "result"; cost: CostData; output?: string; isError: boolean; errorCategory?: string }
  | { type: "error"; message: string; category?: string }
  | { type: "raw_log"; content: string }
  | { type: "raw_stderr"; content: string }
  | { type: "progress"; message: string }
  | { type: "custom"; name: string; data: unknown }
  | {
      type: "context_usage";
      contextUsedTokens: number;
      // Migration 063: nullable so adapters (e.g. devin without a context API)
      // can emit a snapshot that records cumulative tokens without faking a window.
      contextTotalTokens: number | null;
      // Migration 063: null if contextTotalTokens is missing (no divide-by-zero).
      contextPercent: number | null;
      // Migration 063: null when the adapter can't honestly report output tokens.
      outputTokens: number | null;
      /**
       * Migration 063 — the formula the adapter used to compute
       * contextUsedTokens. See `ContextFormulaSchema` in `src/types.ts` for the
       * canonical value list. Adapters should always populate this going
       * forward; it powers cross-provider apples-to-apples comparison.
       */
      contextFormula?: string;
    }
  | {
      type: "compaction";
      preCompactTokens: number;
      compactTrigger: "auto" | "manual" | "auto-inferred";
      contextTotalTokens: number;
    };

/** Configuration passed to a provider adapter to create a session. */
export interface ProviderSessionConfig {
  prompt: string;
  systemPrompt: string;
  model: string;
  role: string;
  agentId: string;
  taskId: string;
  apiUrl: string;
  apiKey: string;
  cwd: string;
  vcsRepo?: string;
  resumeSessionId?: string;
  iteration?: number;
  logFile: string;
  /** Extra CLI args — used by Claude adapter, ignored by others. */
  additionalArgs?: string[];
  /** Resolved environment variables to pass to the spawned process. */
  env?: Record<string, string>;
}

/** A running provider session. */
export interface ProviderSession {
  readonly sessionId: string | undefined;
  onEvent(listener: (event: ProviderEvent) => void): void;
  waitForCompletion(): Promise<ProviderResult>;
  abort(): Promise<void>;
}

/** Result returned when a provider session completes. */
export interface ProviderResult {
  exitCode: number;
  sessionId?: string;
  cost?: CostData;
  output?: string;
  isError: boolean;
  errorCategory?: string;
  /** Human-readable failure reason built from error tracking. */
  failureReason?: string;
}

/** Behavioral traits that govern prompt assembly and feature gating. */
export interface ProviderTraits {
  /** Provider can call MCP tools (store-progress, task-action, skills, slack-reply, etc.) */
  hasMcp: boolean;
  /** Provider runs in the local Docker container with /workspace, identity files, agent-fs, PM2, etc. */
  hasLocalEnvironment: boolean;
}

/** Main contract for a harness provider adapter. */
export interface ProviderAdapter {
  readonly name: string;
  readonly traits: ProviderTraits;
  createSession(config: ProviderSessionConfig): Promise<ProviderSession>;
  canResume(sessionId: string): Promise<boolean>;
  formatCommand(commandName: string): string;
}

/**
 * Status returned by per-adapter `checkCredentials(env, opts)` predicates.
 *
 * `ready=false` means the worker should park in the credential-wait loop
 * (Phase 2). `missing` lists env-var names (or absolute file paths) the
 * adapter would accept; the dashboard surfaces this list as the "blocked
 * on …" hint.
 *
 * `satisfiedBy`:
 * - `'env'` — env-var(s) directly satisfy the adapter
 * - `'file'` — an existing on-disk auth.json was found
 * - `'side-effect-pending'` — env-vars are present but a follow-up step
 *   (e.g. `codex login --with-api-key`) still needs to run before the
 *   adapter can use them. Workers should treat this as "ready" for the
 *   purposes of the boot loop — the side-effect is the entrypoint's job.
 */
export interface CredStatus {
  ready: boolean;
  missing: string[];
  satisfiedBy?: "env" | "file" | "side-effect-pending";
  hint?: string;
}

/**
 * Options threaded into `checkCredentials` for testability — the codex and
 * pi/opencode predicates probe the filesystem for `~/.codex/auth.json`,
 * `~/.pi/agent/auth.json`, `~/.local/share/opencode/auth.json`. Tests inject
 * a fake `fs` + `homeDir` to exercise the file-vs-env branches deterministically.
 */
export interface CredCheckOptions {
  homeDir?: string;
  fs?: { existsSync(p: string): boolean };
}
