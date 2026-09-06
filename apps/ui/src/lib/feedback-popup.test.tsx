import { describe, expect, test } from "bun:test";
import {
  EMPTY_FEEDBACK_POPUP_STATE,
  FEEDBACK_DISMISS_COOLDOWN_MS,
  FEEDBACK_SUBMISSION_COOLDOWN_MS,
  feedbackPopupStorageKey,
  parseFeedbackPopupState,
  shouldShowFeedbackPopup,
} from "./feedback-popup";
import { isAdminLike } from "./user-role";

const NOW = Date.parse("2026-09-03T12:00:00.000Z");
const daysAgo = (days: number) => new Date(NOW - days * 24 * 60 * 60 * 1000).toISOString();

const eligible = {
  isCloud: false,
  currentUserState: "ready" as const,
  user: { role: "admin" },
  state: EMPTY_FEEDBACK_POPUP_STATE,
  installedAt: daysAgo(8),
  hasFailedTask: false,
  otherDialogOpen: false,
  nowMs: NOW,
};

describe("isAdminLike", () => {
  test("treats missing and empty roles as admin during onboarding", () => {
    expect(isAdminLike({})).toBe(true);
    expect(isAdminLike({ role: "  " })).toBe(true);
    expect(isAdminLike({ role: "admin" })).toBe(true);
  });

  test("rejects an explicit non-admin role", () => {
    expect(isAdminLike({ role: "member" })).toBe(false);
  });
});

describe("shouldShowFeedbackPopup", () => {
  test("shows from day seven onward", () => {
    expect(shouldShowFeedbackPopup(eligible)).toBe(true);
    expect(shouldShowFeedbackPopup({ ...eligible, installedAt: daysAgo(7) })).toBe(true);
    expect(shouldShowFeedbackPopup({ ...eligible, installedAt: daysAgo(300) })).toBe(true);
  });

  test("shows before day seven after a failure", () => {
    expect(
      shouldShowFeedbackPopup({ ...eligible, installedAt: daysAgo(2), hasFailedTask: true }),
    ).toBe(true);
  });

  test("allows only the failure trigger when install age is unknown", () => {
    expect(shouldShowFeedbackPopup({ ...eligible, installedAt: null })).toBe(false);
    expect(shouldShowFeedbackPopup({ ...eligible, installedAt: null, hasFailedTask: true })).toBe(
      true,
    );
  });

  test("waits for identity and any other dialog to close", () => {
    expect(shouldShowFeedbackPopup({ ...eligible, currentUserState: "pending" })).toBe(false);
    expect(shouldShowFeedbackPopup({ ...eligible, otherDialogOpen: true })).toBe(false);
  });

  test("never shows on cloud or to an explicit non-admin", () => {
    expect(shouldShowFeedbackPopup({ ...eligible, isCloud: true })).toBe(false);
    expect(shouldShowFeedbackPopup({ ...eligible, user: { role: "viewer" } })).toBe(false);
  });

  test("never prompts twice inside the submission cooldown", () => {
    const submittedAt = new Date(NOW - FEEDBACK_SUBMISSION_COOLDOWN_MS + 1).toISOString();
    expect(
      shouldShowFeedbackPopup({
        ...eligible,
        state: { ...EMPTY_FEEDBACK_POPUP_STATE, lastSubmittedAt: submittedAt, submissionCount: 1 },
      }),
    ).toBe(false);
    expect(
      shouldShowFeedbackPopup({
        ...eligible,
        state: {
          ...EMPTY_FEEDBACK_POPUP_STATE,
          lastSubmittedAt: new Date(NOW - FEEDBACK_SUBMISSION_COOLDOWN_MS).toISOString(),
          submissionCount: 1,
        },
      }),
    ).toBe(true);
  });

  test("suppresses a dismissal for the shorter cooldown", () => {
    expect(
      shouldShowFeedbackPopup({
        ...eligible,
        state: {
          ...EMPTY_FEEDBACK_POPUP_STATE,
          lastDismissedAt: new Date(NOW - FEEDBACK_DISMISS_COOLDOWN_MS + 1).toISOString(),
        },
      }),
    ).toBe(false);
    expect(
      shouldShowFeedbackPopup({
        ...eligible,
        state: {
          ...EMPTY_FEEDBACK_POPUP_STATE,
          lastDismissedAt: new Date(NOW - FEEDBACK_DISMISS_COOLDOWN_MS).toISOString(),
        },
      }),
    ).toBe(true);
  });

  test("treats a future stored timestamp conservatively", () => {
    expect(
      shouldShowFeedbackPopup({
        ...eligible,
        state: {
          ...EMPTY_FEEDBACK_POPUP_STATE,
          lastSubmittedAt: new Date(NOW + 24 * 60 * 60 * 1000).toISOString(),
          submissionCount: 1,
        },
      }),
    ).toBe(false);
  });
});

describe("feedback popup storage", () => {
  test("uses one versioned deployment-and-user key", () => {
    expect(feedbackPopupStorageKey("https://swarm.example", "user_1")).toBe(
      "swarm:feedback-popup:v1:https://swarm.example:user_1",
    );
  });

  test("parses valid state and safely resets malformed state", () => {
    expect(
      parseFeedbackPopupState(
        JSON.stringify({
          version: 1,
          lastSubmittedAt: "2026-09-01T00:00:00.000Z",
          lastDismissedAt: null,
          submissionCount: 2,
        }),
      ),
    ).toEqual({
      version: 1,
      lastSubmittedAt: "2026-09-01T00:00:00.000Z",
      lastDismissedAt: null,
      submissionCount: 2,
    });
    expect(parseFeedbackPopupState("not-json")).toEqual(EMPTY_FEEDBACK_POPUP_STATE);
    expect(parseFeedbackPopupState(JSON.stringify({ version: 2 }))).toEqual(
      EMPTY_FEEDBACK_POPUP_STATE,
    );
  });
});
