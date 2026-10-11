import type { CurrentUserState } from "@/contexts/current-user-context";
import { isAdminLike } from "./user-role";

const DAY_MS = 24 * 60 * 60 * 1000;
const STORAGE_VERSION = 1;

/** A successful submission is enough feedback for one quarter. */
export const FEEDBACK_SUBMISSION_COOLDOWN_MS = 90 * DAY_MS;
/** A dismissal is a softer signal, but still suppresses the prompt for a month. */
export const FEEDBACK_DISMISS_COOLDOWN_MS = 30 * DAY_MS;
/** `quarterly`: an install at least this old that was not asked for this long. */
export const FEEDBACK_QUARTERLY_MS = 90 * DAY_MS;
/** `tasks_completed`: the install is at least this old ... */
export const FEEDBACK_TASKS_MIN_AGE_MS = 3 * DAY_MS;
/** ... and completed at least this many tasks. */
export const FEEDBACK_TASKS_MIN_COMPLETED = 10;

export type FeedbackTrigger =
  | "task_failed"
  | "tasks_completed"
  | "workflow_completed"
  | "quarterly";

export interface FeedbackPopupState {
  version: typeof STORAGE_VERSION;
  lastSubmittedAt: string | null;
  lastDismissedAt: string | null;
  submissionCount: number;
  /** When the card was last shown. Event triggers only fire before the first ask. */
  lastShownAt: string | null;
  /** The browser session that first saw a failed task; `task_failed` waits for a later one. */
  firstFailureSessionId: string | null;
  firstFailureSeenAt: string | null;
}

export const EMPTY_FEEDBACK_POPUP_STATE: FeedbackPopupState = {
  version: STORAGE_VERSION,
  lastSubmittedAt: null,
  lastDismissedAt: null,
  submissionCount: 0,
  lastShownAt: null,
  firstFailureSessionId: null,
  firstFailureSeenAt: null,
};

export function feedbackPopupStorageKey(apiUrl: string, userId: string): string {
  return `swarm:feedback-popup:v${STORAGE_VERSION}:${apiUrl}:${userId}`;
}

const stringOrNull = (value: unknown) => (typeof value === "string" ? value : null);

export function parseFeedbackPopupState(raw: string | null): FeedbackPopupState {
  if (!raw) return EMPTY_FEEDBACK_POPUP_STATE;
  try {
    const value = JSON.parse(raw) as Partial<FeedbackPopupState>;
    if (value.version !== STORAGE_VERSION) return EMPTY_FEEDBACK_POPUP_STATE;
    return {
      version: STORAGE_VERSION,
      lastSubmittedAt: stringOrNull(value.lastSubmittedAt),
      lastDismissedAt: stringOrNull(value.lastDismissedAt),
      submissionCount:
        typeof value.submissionCount === "number" && value.submissionCount >= 0
          ? Math.floor(value.submissionCount)
          : 0,
      lastShownAt: stringOrNull(value.lastShownAt),
      firstFailureSessionId: stringOrNull(value.firstFailureSessionId),
      firstFailureSeenAt: stringOrNull(value.firstFailureSeenAt),
    };
  } catch {
    return EMPTY_FEEDBACK_POPUP_STATE;
  }
}

export interface FeedbackEligibility {
  isCloud: boolean;
  currentUserState: CurrentUserState;
  user: { role?: string } | null;
  state: FeedbackPopupState;
  /** `telemetry_installed_at`, else `/status` `instance.first_seen_at` (telemetry off). */
  installedAt: string | null;
  tasksCompleted: number;
  tasksFailed: number;
  workflowRunsCompleted: number;
  /** This browser session (per tab), compared with `state.firstFailureSessionId`. */
  sessionId: string;
  otherDialogOpen: boolean;
  nowMs?: number;
}

function elapsedMs(iso: string | null, nowMs: number): number {
  const ms = iso ? Date.parse(iso) : Number.NaN;
  return Number.isFinite(ms) ? nowMs - ms : Number.NaN;
}

/** Inside `cooldownMs` of `iso`. A future timestamp counts as inside. */
function within(iso: string | null, cooldownMs: number, nowMs: number): boolean {
  const elapsed = elapsedMs(iso, nowMs);
  return Number.isFinite(elapsed) && elapsed < cooldownMs;
}

/**
 * Why the feedback card should show now, or null. Cloud, non-admins, another
 * open dialog and the submit/dismiss cooldowns always block. Otherwise:
 *
 * - before the first ask, a moment of success or friction: a failed task (seen
 *   in an earlier session), a completed workflow, or 10 completed tasks on an
 *   install at least 3 days old;
 * - after that, `quarterly`: an install at least 90 days old not asked for 90 days.
 */
export function feedbackPopupTrigger(input: FeedbackEligibility): FeedbackTrigger | null {
  if (
    input.isCloud ||
    input.currentUserState !== "ready" ||
    !isAdminLike(input.user) ||
    input.otherDialogOpen
  ) {
    return null;
  }
  const nowMs = input.nowMs ?? Date.now();
  const { state } = input;
  if (within(state.lastSubmittedAt, FEEDBACK_SUBMISSION_COOLDOWN_MS, nowMs)) return null;
  if (within(state.lastDismissedAt, FEEDBACK_DISMISS_COOLDOWN_MS, nowMs)) return null;

  const ageMs = elapsedMs(input.installedAt, nowMs);
  if (state.lastShownAt === null) {
    if (
      input.tasksFailed > 0 &&
      state.firstFailureSessionId !== null &&
      state.firstFailureSessionId !== input.sessionId
    ) {
      return "task_failed";
    }
    if (input.workflowRunsCompleted > 0) return "workflow_completed";
    if (
      input.tasksCompleted >= FEEDBACK_TASKS_MIN_COMPLETED &&
      ageMs >= FEEDBACK_TASKS_MIN_AGE_MS
    ) {
      return "tasks_completed";
    }
  }
  if (ageMs >= FEEDBACK_QUARTERLY_MS && !within(state.lastShownAt, FEEDBACK_QUARTERLY_MS, nowMs)) {
    return "quarterly";
  }
  return null;
}

/** The 0-10 follow-up question for a score. */
export function followUpQuestion(score: number): string {
  if (score <= 6) return "What almost made you give up?";
  if (score >= 9) return "What would you tell a colleague?";
  return "What would make it a 10?";
}
