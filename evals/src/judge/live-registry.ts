import type { JudgeTrace } from "../types.ts";

/**
 * In-memory live-judge registry (v3 spec §3). The runner executes in-process
 * with the API server, so judges push (mutable) traces here while an attempt
 * is in its judging phase and the server reads them for the polled
 * `/api/attempts/:id/judge-live` endpoint — same pattern as the live transcript.
 *
 * Traces are shared BY REFERENCE: judges keep mutating the object they attached
 * (pushing steps, setting finishedAt/costUsd/…) and readers see updates for
 * free. Bun's single-threaded event loop makes mid-poll serialization safe;
 * readers must serialize the snapshot immediately and never retain it.
 */

export interface LiveJudgeSnapshot {
  judging: boolean;
  traces: JudgeTrace[];
}

export interface JudgeLiveHandle {
  /** Register a (mutable) trace for live reads. The judge keeps mutating it. */
  attach(trace: JudgeTrace): void;
}

const registry = new Map<string, { judging: boolean; traces: JudgeTrace[] }>();

/**
 * Runner calls when an attempt enters its judging phase. Resets any previous
 * entry (retries re-enter cleanly). The returned handle stays bound to THIS
 * entry — attaches after a clear/reset are harmless no-ops on a dead entry.
 */
export function beginJudging(attemptId: string): JudgeLiveHandle {
  const entry: { judging: boolean; traces: JudgeTrace[] } = { judging: true, traces: [] };
  registry.set(attemptId, entry);
  return {
    attach(trace: JudgeTrace): void {
      entry.traces.push(trace);
    },
  };
}

/** Runner calls after all judges finish: judging → false, traces stay readable. */
export function endJudging(attemptId: string): void {
  const entry = registry.get(attemptId);
  if (entry) entry.judging = false;
}

/** Runner calls AFTER final persistence (in runAttemptOnce's finally). Never leaks. */
export function clearJudging(attemptId: string): void {
  registry.delete(attemptId);
}

/** Server reads in-process. Unknown attemptId → { judging: false, traces: [] }. */
export function getJudgeLive(attemptId: string): LiveJudgeSnapshot {
  const entry = registry.get(attemptId);
  return entry ? { judging: entry.judging, traces: entry.traces } : { judging: false, traces: [] };
}
