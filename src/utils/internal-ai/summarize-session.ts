/**
 * Worker-side domain helper for session-end summarization.
 *
 * Plan: thoughts/taras/plans/2026-05-10-fix-session-summarization-workers.md
 * → Phase 0 § "summarize-session.ts"
 *
 * Composes `completeStructured` with `SummaryWithRatingsSchema` and the
 * shared `BASE_SUMMARIZE_PROMPT` extracted from `src/hooks/hook.ts`. API-server
 * callers wanting structured AI completion call `completeStructured` directly
 * with their own schemas — this helper is for session-transcript consumers
 * only.
 *
 * Worker-safe: uses fetch() only via underlying helpers; no bun:sqlite import.
 */

import { Type } from "typebox";
import type { z } from "zod";
import {
  BASE_SUMMARIZE_PROMPT,
  buildSummaryWithRatingsPrompt,
  type RetrievalRow,
  SummaryWithRatingsSchema,
} from "../../be/memory/raters/llm.js";
import { completeStructured } from "./complete-structured.js";
import type { ResolvedCredential } from "./credentials.js";

export interface SummarizeSessionOptions {
  /** Diagnostic tag only — propagated into `callerTag`, not into `completeStructured` directly. */
  harness: "claude" | "pi" | "opencode" | "codex";
  /** Pre-truncated transcript text. */
  transcript: string;
  /** Memory retrievals for the per-memory ratings block; [] when not requested. */
  retrievals: RetrievalRow[];
  taskContext: { sourceTaskId: string; agentId: string; prompt?: string };
  /** Passed through to `completeStructured` for codex-OAuth probing. */
  apiUrl: string;
  apiKey: string;
  signal?: AbortSignal;
  /**
   * Bypass `resolveCredential` entirely — opencode auth path (and tests) pass
   * an already-resolved credential through to `completeStructured`. Phase 2
   * amendment: clean injection point so harnesses with their own credential
   * stores (opencode's `auth.json`) can skip the harness-agnostic resolver.
   */
  _credentialOverride?: ResolvedCredential;
  /** Test injection. */
  _completeStructured?: typeof completeStructured;
}

/**
 * Typebox tool schema mirroring `SummaryWithRatingsSchema`.
 *
 * Kept in lockstep with the zod schema via `src/tests/internal-ai/schema-parity.test.ts`
 * which fuzzes both validators with a fixture set.
 */
export const summaryToolSchema = Type.Object({
  summary: Type.String(),
  ratings: Type.Array(
    Type.Object({
      id: Type.String({ minLength: 1 }),
      score: Type.Number({ minimum: 0, maximum: 1 }),
      reasoning: Type.String({ minLength: 1, maxLength: 500 }),
      referencesSource: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })),
    }),
  ),
});

/**
 * Returns the structured summary (with optional per-memory ratings), or
 * `null` when:
 *   - the transcript is too short (≤ 100 chars), OR
 *   - `completeStructured` could not resolve a credential, OR
 *   - the LLM repeatedly failed to produce schema-valid output.
 */
export async function summarizeSession(
  opts: SummarizeSessionOptions,
): Promise<z.infer<typeof SummaryWithRatingsSchema> | null> {
  if (opts.transcript.length <= 100) return null;

  const taskLine = opts.taskContext.prompt ? `\nTask: ${opts.taskContext.prompt}` : "";
  const basePrompt = `${BASE_SUMMARIZE_PROMPT}${taskLine}\n\nTranscript:\n${opts.transcript}`;
  const userPrompt = buildSummaryWithRatingsPrompt(basePrompt, opts.retrievals);

  const runner = opts._completeStructured ?? completeStructured;
  return await runner({
    zodSchema: SummaryWithRatingsSchema,
    toolSchema: summaryToolSchema,
    toolName: "record_session_summary",
    toolDescription:
      "Record the high-value learnings extracted from this session, plus per-memory ratings of any retrievals.",
    systemPrompt:
      "You are an expert at extracting durable, generalizable learnings from agent sessions.",
    userPrompt,
    callerTag: `session-summary:${opts.harness}`,
    apiUrl: opts.apiUrl,
    apiKey: opts.apiKey,
    signal: opts.signal,
    retries: 3,
    ...(opts._credentialOverride ? { _credentialOverride: opts._credentialOverride } : {}),
  });
}
