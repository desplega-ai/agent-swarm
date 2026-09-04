import type { CurrentUserState } from "@/contexts/current-user-context";
import { isAdminLike } from "./user-role";

const DAY_MS = 24 * 60 * 60 * 1000;
const STORAGE_VERSION = 1;

/** A successful submission is enough feedback for one quarter. */
export const FEEDBACK_SUBMISSION_COOLDOWN_MS = 90 * DAY_MS;
/** A dismissal is a softer signal, but still suppresses the prompt for a month. */
export const FEEDBACK_DISMISS_COOLDOWN_MS = 30 * DAY_MS;

export interface FeedbackPopupState {
  version: typeof STORAGE_VERSION;
  lastSubmittedAt: string | null;
  lastDismissedAt: string | null;
  submissionCount: number;
}

export const EMPTY_FEEDBACK_POPUP_STATE: FeedbackPopupState = {
  version: STORAGE_VERSION,
  lastSubmittedAt: null,
  lastDismissedAt: null,
  submissionCount: 0,
};

export function feedbackPopupStorageKey(apiUrl: string, userId: string): string {
  return `swarm:feedback-popup:v${STORAGE_VERSION}:${apiUrl}:${userId}`;
}

export function parseFeedbackPopupState(raw: string | null): FeedbackPopupState {
  if (!raw) return EMPTY_FEEDBACK_POPUP_STATE;
  try {
    const value = JSON.parse(raw) as Partial<FeedbackPopupState>;
    if (value.version !== STORAGE_VERSION) return EMPTY_FEEDBACK_POPUP_STATE;
    return {
      version: STORAGE_VERSION,
      lastSubmittedAt: typeof value.lastSubmittedAt === "string" ? value.lastSubmittedAt : null,
      lastDismissedAt: typeof value.lastDismissedAt === "string" ? value.lastDismissedAt : null,
      submissionCount:
        typeof value.submissionCount === "number" && value.submissionCount >= 0
          ? Math.floor(value.submissionCount)
          : 0,
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
  installedAt: string | null;
  hasFailedTask: boolean;
  otherDialogOpen: boolean;
  nowMs?: number;
}

export function shouldShowFeedbackPopup(input: FeedbackEligibility): boolean {
  if (
    input.isCloud ||
    input.currentUserState !== "ready" ||
    !isAdminLike(input.user) ||
    input.otherDialogOpen
  ) {
    return false;
  }

  const nowMs = input.nowMs ?? Date.now();
  const submittedMs = input.state.lastSubmittedAt
    ? Date.parse(input.state.lastSubmittedAt)
    : Number.NaN;
  if (Number.isFinite(submittedMs) && nowMs - submittedMs < FEEDBACK_SUBMISSION_COOLDOWN_MS) {
    return false;
  }
  const dismissedMs = input.state.lastDismissedAt
    ? Date.parse(input.state.lastDismissedAt)
    : Number.NaN;
  if (Number.isFinite(dismissedMs) && nowMs - dismissedMs < FEEDBACK_DISMISS_COOLDOWN_MS) {
    return false;
  }

  const installedMs = input.installedAt ? Date.parse(input.installedAt) : Number.NaN;
  if (!Number.isFinite(installedMs)) return input.hasFailedTask;

  const ageMs = nowMs - installedMs;
  if (ageMs < 0) return false;
  return input.hasFailedTask || ageMs >= 7 * DAY_MS;
}
