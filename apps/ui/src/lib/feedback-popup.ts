import type { CurrentUserState } from "@/contexts/current-user-context";
import { isAdminLike } from "./user-role";

const DAY_MS = 24 * 60 * 60 * 1000;

export interface FeedbackEligibility {
  isCloud: boolean;
  currentUserState: CurrentUserState;
  user: { role?: string } | null;
  dismissed: boolean;
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
    input.dismissed ||
    input.otherDialogOpen
  ) {
    return false;
  }

  const installedMs = input.installedAt ? Date.parse(input.installedAt) : Number.NaN;
  if (!Number.isFinite(installedMs)) return input.hasFailedTask;

  const ageMs = (input.nowMs ?? Date.now()) - installedMs;
  if (ageMs < 0 || ageMs >= 30 * DAY_MS) return false;
  return input.hasFailedTask || ageMs >= 7 * DAY_MS;
}
