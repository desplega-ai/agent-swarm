import type { ProviderName } from "@swarm/types";

/**
 * # Native session resume is deprecated.
 *
 * Follow-up continuity is delivered via the context preamble built by
 * `buildContextPreamble` in `src/commands/context-preamble.ts`. The preamble
 * is bounded, deterministic, and survives worker-container restarts — the
 * failure modes that native resume could not handle.
 *
 * `resolveResumeSession` is preserved as an observability shim: it accepts
 * the same candidate shape the runner already builds and returns every
 * non-empty candidate in `skipped` with a deprecation reason. The result's
 * `resumeSessionId` is always `undefined` — adapters spawn fresh sessions.
 *
 * Refs: thoughts/taras/plans/2026-05-28-deprecate-native-resume.md
 */

export type ResumeSessionSource = "task" | "parent";

export interface ResumeSessionCandidate {
  source: ResumeSessionSource;
  sessionId?: string | null;
  taskId?: string;
  provider?: ProviderName;
  providerMeta?: Record<string, unknown>;
}

export interface ResumeSessionSkip {
  source: ResumeSessionSource;
  sessionId: string;
  provider?: ProviderName;
  reason: string;
}

export interface ResumeSessionResolution {
  /**
   * @deprecated Always `undefined`. Native session resume was removed in the
   * 2026-05-28 deprecation. See module docstring + context-preamble.ts.
   */
  resumeSessionId?: string;
  source?: ResumeSessionSource;
  provider?: ProviderName;
  skipped: ResumeSessionSkip[];
}

export const RESUME_DEPRECATED_REASON = "native resume deprecated — using context preamble";

/**
 * Observability shim. Records the candidates that *would* have been resume
 * targets in the old world; never asks the adapter to resume.
 *
 * `_currentProvider` is kept for call-site compatibility with the runner
 * (both call sites already pass `state.harnessProvider`); the value is
 * intentionally unused.
 */
export function resolveResumeSession(
  _currentProvider: ProviderName,
  candidates: ResumeSessionCandidate[],
): ResumeSessionResolution {
  const skipped: ResumeSessionSkip[] = [];

  for (const candidate of candidates) {
    const sessionId = candidate.sessionId?.trim();
    if (!sessionId) continue;
    skipped.push({
      source: candidate.source,
      sessionId,
      provider: candidate.provider,
      reason: RESUME_DEPRECATED_REASON,
    });
  }

  return { skipped };
}
