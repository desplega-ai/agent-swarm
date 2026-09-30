/**
 * Harness crashes: task failures caused by the harness or its provider, not by
 * the model under test. An attempt that hits one ends as `error` with
 * `exclusion = "harness-error"`, so no score or pass rate counts it. Before
 * this, a context overflow or a dead provider stream ended as `failed` with
 * score 0 and read as a model failure.
 *
 * Rules, same as INFRA_FAILURE_SIGNATURES (runner/index.ts): match on the task's
 * `failureReason` only, and keep each pattern narrow enough that a
 * model-caused failure cannot match. When in doubt, leave it out; an unmatched
 * crash stays `failed`, which is the safe direction. Known model-caused
 * failures that must never match: `tool-loop: Detected ping-pong loop ...`,
 * `Task depends on ...`, `Blocked dependency ...`.
 */

import type { SwarmTask } from "../types.ts";

export type HarnessCrashKind = "context-overflow" | "provider-error" | "no-output-timeout";

export interface HarnessCrashSignature {
  kind: Exclude<HarnessCrashKind, "no-output-timeout">;
  pattern: RegExp;
  /**
   * A fresh sandbox can fix a transient provider fault but never a prompt that
   * does not fit the model's window, so overflow is not retried.
   */
  retryable: boolean;
}

export const HARNESS_CRASH_SIGNATURES: HarnessCrashSignature[] = [
  // OpenRouter / OpenAI: "This endpoint's maximum context length is N tokens. However, you requested ..."
  {
    kind: "context-overflow",
    pattern: /maximum context length is [\d,]+ tokens/i,
    retryable: false,
  },
  { kind: "context-overflow", pattern: /\bcontext_length_exceeded\b/i, retryable: false },
  // Anthropic: "prompt is too long: N tokens > M maximum"
  { kind: "context-overflow", pattern: /\bprompt is too long: [\d,]+ tokens\b/i, retryable: false },
  // Mid-stream provider errors surfaced as the task failure reason.
  { kind: "provider-error", pattern: /^JSON error injected into SSE stream/i, retryable: true },
  {
    kind: "provider-error",
    pattern: /"type"\s*:\s*"(?:overloaded_error|rate_limit_error|api_error)"/i,
    retryable: true,
  },
  {
    kind: "provider-error",
    pattern:
      /\b(?:429|500|502|503|504|529)\b[^\n]{0,60}(?:Too Many Requests|Internal Server Error|Bad Gateway|Service Unavailable|Gateway Time-?out|overloaded)/i,
    retryable: true,
  },
  { kind: "provider-error", pattern: /^Provider returned error\b/i, retryable: true },
  // Claude Code on a subscription: "You've hit your session limit · resets 12pm (UTC)".
  // Not retried: every retry inside the window hits the same limit.
  {
    kind: "provider-error",
    pattern: /\bYou've hit your (?:session|usage|weekly|daily) limit\b/i,
    retryable: false,
  },
];

export interface HarnessCrash {
  kind: HarnessCrashKind;
  retryable: boolean;
  /** Short human reason, safe to persist as the attempt `error`. */
  detail: string;
}

/** Match a failed task's `failureReason` against the crash signatures. */
export function classifyFailureReason(reason: string | null | undefined): HarnessCrash | null {
  const text = String(reason ?? "");
  if (text.length === 0) return null;
  const sig = HARNESS_CRASH_SIGNATURES.find((s) => s.pattern.test(text));
  if (!sig) return null;
  return { kind: sig.kind, retryable: sig.retryable, detail: text.slice(0, 300) };
}

/**
 * A task that hit the attempt timeout while the agent produced nothing: no
 * session-log row at all means it never started (or hung at boot), which is a
 * harness fault. A slow agent that logged anything is a model failure and is
 * left to the `tasks-completed` gate.
 */
export function classifyNoOutputTimeout(
  tasks: readonly (SwarmTask & { timedOut?: boolean })[],
  logRows: readonly { taskId: string }[],
): { task: SwarmTask; crash: HarnessCrash } | null {
  const withLogs = new Set(logRows.map((r) => r.taskId));
  for (const task of tasks) {
    if (task.timedOut && !task.skipped && !withLogs.has(task.id)) {
      return {
        task,
        crash: {
          kind: "no-output-timeout",
          retryable: true,
          detail: "timed out with no agent output (no session-log rows)",
        },
      };
    }
  }
  return null;
}

/** Thrown by the runner for a harness crash; ends the attempt as `error` + `harness-error`. */
export class HarnessCrashError extends Error {
  constructor(
    public readonly crash: HarnessCrash,
    public readonly taskId: string,
  ) {
    super(
      `harness crash (${crash.kind}): task ${taskId} - ${crash.detail}. ` +
        "Excluded from scores; not a model failure.",
    );
    this.name = "HarnessCrashError";
  }
}
