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
  provider?: "claude" | "claude-managed" | "codex" | "pi" | "opencode" | "ai-sdk-agent" | "devin";
}

import type { ProviderName } from "../types";
import type { RateLimitWindowTelemetry } from "../utils/error-tracker";

/** Normalized event emitted by any provider adapter. */
export type ProviderEvent =
  | {
      type: "session_init";
      sessionId: string;
      provider?: ProviderName;
      providerMeta?: Record<string, unknown>;
      harnessVariant?: string;
      harnessVariantMeta?: Record<string, unknown>;
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
  contextKey?: string;
  /**
   * @deprecated Never set by the runner — native session resume was removed in
   * the 2026-05-28 plan. Adapters log + ignore any stray value. Follow-up
   * continuity flows through the context preamble; see
   * `src/commands/context-preamble.ts` and `src/commands/resume-session.ts`.
   */
  resumeSessionId?: string;
  iteration?: number;
  logFile: string;
  /** Extra CLI args — used by Claude adapter, ignored by others. */
  additionalArgs?: string[];
  /** Resolved environment variables to pass to the spawned process. */
  env?: Record<string, string>;
  /**
   * Codex OAuth pool slot selected for this task. When set, the Codex adapter
   * uses this slot for token refresh write-back instead of defaulting to slot 0.
   */
  codexSlot?: number;
}

/** A running provider session. */
export interface ProviderSession {
  readonly sessionId: string | undefined;
  onEvent(listener: (event: ProviderEvent) => void): void;
  waitForCompletion(): Promise<ProviderResult>;
  abort(reason?: string): Promise<void>;
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
  /**
   * ISO timestamp of the rate limit reset time, parsed from a structured
   * `rate_limit_event` line in the Claude CLI stream. Only set by the Claude
   * adapter when a `status: "rejected"` event is present. Already clamped to
   * [now+60s, now+7d] at the source. The runner uses this as tier-1 of the
   * three-tier cooldown resolver.
   */
  rateLimitResetAt?: string;
  /**
   * Latest provider-emitted rate-limit window snapshots observed during the
   * session, keyed by provider window type (for Claude: five_hour, seven_day).
   * Best-effort and informational; consumers must tolerate it being absent.
   */
  rateLimitWindows?: RateLimitWindowTelemetry;
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
 * - `'sdk-delegated'` — the harness's underlying SDK owns credential
 *   resolution at runtime (e.g. AWS SDK default chain for pi-mono +
 *   `MODEL_OVERRIDE=amazon-bedrock/...`); agent-swarm does no presence check
 *   and any error surfaces from the first inference call.
 */
export interface CredStatus {
  ready: boolean;
  missing: string[];
  satisfiedBy?: "env" | "file" | "side-effect-pending" | "sdk-delegated";
  hint?: string;
  /**
   * Pi-mono Bedrock mode only: usable model list = harness-drivable ∩
   * AWS-invocable (on-demand/ACTIVE foundation models ∪ inference profiles),
   * region-scoped. Empty when enumeration failed (ready===false), when
   * `AWS_REGION` is unset, or when the intersection is empty. Undefined when not
   * in Bedrock mode.
   */
  bedrockModels?: Array<{ id: string; name: string }>;
  /**
   * Pi-mono Bedrock mode only: AWS region the enumeration ran against. An empty
   * string signals Bedrock mode with `AWS_REGION` unset (no region fabricated).
   */
  bedrockRegion?: string;
}

/**
 * Options threaded into `checkCredentials` for testability — the codex and
 * pi/opencode predicates probe the filesystem for `~/.codex/auth.json`,
 * `~/.pi/agent/auth.json`, `~/.local/share/opencode/auth.json`. Tests inject
 * a fake `fs` + `homeDir` to exercise the file-vs-env branches deterministically.
 *
 * `bedrockProbe` is an injectable for the Bedrock SDK enumeration path in
 * `checkPiMonoCredentials`. In production it is left undefined and the function
 * dynamically imports `@aws-sdk/client-bedrock` to run real
 * `ListFoundationModels` + `ListInferenceProfiles` calls. Tests inject a stub
 * to avoid hitting AWS.
 */
export interface CredCheckOptions {
  homeDir?: string;
  fs?: { existsSync(p: string): boolean };
  /**
   * Injectable for the Bedrock SDK enumeration. When provided, called instead
   * of the real `@aws-sdk/client-bedrock` `ListFoundationModels` +
   * `ListInferenceProfiles` calls. Should throw on auth/access failure (with an
   * AWS SDK-shaped error message) or resolve with the intersected
   * (harness-drivable ∩ AWS-invocable) model list on success.
   *
   * Return type is `Array<{id,name}> | undefined` for backward compatibility:
   * existing test stubs that return void (`async () => {}`) are still valid
   * (void is assignable to undefined in TypeScript's structural typing);
   * new tests that need to exercise the model list inject stubs that return
   * an array. Production code always returns the model list.
   */
  bedrockProbe?: () => Promise<Array<{ id: string; name: string }> | undefined>;
}
