import type {
  AttemptPhase,
  AttemptProgressSnapshot,
  PhaseTimings,
  ProgressLogLevel,
  ProgressLogLine,
} from "../types.ts";

/**
 * In-memory live attempt-progress registry (v4 spec §2). The runner executes
 * in-process with the API server, so it pushes phase transitions, partial
 * phase timings, and every runner log line here while an attempt runs; the
 * server reads them for the polled `/api/attempts/:id/progress` endpoint —
 * same pattern as the judge live-registry.
 *
 * Lifecycle (driven by the runner, WP-RUNNER4):
 *   beginAttemptProgress(id)            — at the top of runAttemptOnce (resets on retry)
 *   setAttemptPhase(id, phase)          — at each phase start
 *   recordAttemptTimings(id, timings)   — after each phase completes (merge)
 *   pushAttemptLog(id, level, line)     — every runner log line (ring buffer)
 *   finishAttemptProgress(id)           — in runAttemptOnce's finally; returns the FULL
 *                                         captured lines for the runner.log artifact and
 *                                         deletes the entry (never leaks)
 */

/** Ring-buffer capacity for live log lines (the artifact keeps the full set). */
export const PROGRESS_LOG_CAP = 2000;

interface ProgressEntry {
  startedAt: string;
  currentPhase: AttemptPhase | null;
  currentPhaseStartedAt: string | null;
  phases: Partial<PhaseTimings>;
  /** Live ring buffer (≤ PROGRESS_LOG_CAP). */
  log: ProgressLogLine[];
  /** Count of lines dropped from the front of the ring buffer. */
  dropped: number;
  /** Full capture for the runner.log artifact (not size-capped beyond the line count). */
  fullLog: ProgressLogLine[];
}

const registry = new Map<string, ProgressEntry>();

const EMPTY_SNAPSHOT: AttemptProgressSnapshot = {
  active: false,
  startedAt: null,
  currentPhase: null,
  currentPhaseStartedAt: null,
  phases: {},
  log: [],
};

/** Runner calls at the top of runAttemptOnce. Resets any previous entry (retries re-enter). */
export function beginAttemptProgress(attemptId: string): void {
  registry.set(attemptId, {
    startedAt: new Date().toISOString(),
    currentPhase: null,
    currentPhaseStartedAt: null,
    phases: {},
    log: [],
    dropped: 0,
    fullLog: [],
  });
}

/** Runner calls when a phase starts (null when the attempt is between/after phases). */
export function setAttemptPhase(attemptId: string, phase: AttemptPhase | null): void {
  const entry = registry.get(attemptId);
  if (!entry) return;
  entry.currentPhase = phase;
  entry.currentPhaseStartedAt = phase === null ? null : new Date().toISOString();
}

/**
 * Merge completed-phase durations. Callers may pass the runner's whole
 * PhaseTimings object after each phase — null fields do NOT clobber previously
 * recorded numbers (a phase that ran stays visible).
 */
export function recordAttemptTimings(attemptId: string, patch: Partial<PhaseTimings>): void {
  const entry = registry.get(attemptId);
  if (!entry) return;
  for (const [key, value] of Object.entries(patch)) {
    if (value !== null && value !== undefined) {
      (entry.phases as Record<string, unknown>)[key] = value;
    }
  }
}

/** Append one runner log line (live ring buffer capped at PROGRESS_LOG_CAP). */
export function pushAttemptLog(attemptId: string, level: ProgressLogLevel, line: string): void {
  const entry = registry.get(attemptId);
  if (!entry) return;
  const entryLine: ProgressLogLine = { ts: new Date().toISOString(), level, line };
  entry.fullLog.push(entryLine);
  entry.log.push(entryLine);
  if (entry.log.length > PROGRESS_LOG_CAP) {
    entry.dropped += entry.log.length - PROGRESS_LOG_CAP;
    entry.log.splice(0, entry.log.length - PROGRESS_LOG_CAP);
  }
}

/** Heuristic level for a runner log line ("[error] …" → error, "warn: …" → warn). */
export function logLevelFor(line: string): ProgressLogLevel {
  if (/\[error\]|\berror\b:/i.test(line)) return "error";
  if (/\[retry\]|\bwarn(?:ing)?\b/i.test(line)) return "warn";
  return "info";
}

/** Server reads in-process. Unknown attemptId → the empty { active: false } shape. */
export function getAttemptProgress(attemptId: string): AttemptProgressSnapshot {
  const entry = registry.get(attemptId);
  if (!entry) return EMPTY_SNAPSHOT;
  return {
    active: true,
    startedAt: entry.startedAt,
    currentPhase: entry.currentPhase,
    currentPhaseStartedAt: entry.currentPhaseStartedAt,
    phases: entry.phases,
    log: entry.log,
  };
}

/**
 * Runner calls in runAttemptOnce's finally (after final persistence). Returns
 * the FULL captured log (for the runner.log artifact) and deletes the entry.
 */
export function finishAttemptProgress(attemptId: string): ProgressLogLine[] {
  const entry = registry.get(attemptId);
  registry.delete(attemptId);
  return entry?.fullLog ?? [];
}

/** Serialize captured lines for the runner.log artifact: "ISO [level] line" per row. */
export function formatRunnerLog(lines: ProgressLogLine[]): string {
  return lines.map((l) => `${l.ts} [${l.level}] ${l.line}`).join("\n");
}
